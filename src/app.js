/**
 * app.js — the bench: layout, gestures, drawing, and the words that explain it.
 *
 * Two verbs, chosen so that everything the acoustics model contains is
 * reachable with a finger and neither verb is hidden behind a mode switch:
 *
 *   DRAG UP FROM THE BLOCK   cut a new pipe. Its length is where you let go.
 *   DRAG A PIPE SIDEWAYS     change its width, which changes its pitch (through
 *                            the end correction) and its tone.
 *   TOUCH A PIPE             blow it. Hold to keep it sounding.
 *   DRAG A PIPE UP/DOWN      (from its body, vertically) overblow into the next
 *                            register: the pitch jumps a TWELFTH, not an octave.
 *
 * Everything is drawn from the same Pipe objects the audio reads, so the picture
 * and the pitch cannot drift apart.
 */

/** Pixels of screen per metre of pipe. Chosen per viewport; see computeLayout. */
const LAYOUT = {
  blockY: 0,
  borePx: 0,
  pipeGap: 0,
  firstPipeX: 0,
  pxPerM: 1,
  width: 0,
  height: 0,
};

const app = {
  canvas: null,
  context: null,
  organ: new Organ(),
  audio: new AudioEngine(),
  /** Pipe ids currently being blown. */
  sounding: new Set(),
  /** Pointer id -> the gesture it is performing. */
  gestures: new Map(),
  /** One-shot status sentence, shown under the canvas. */
  message: '',
  /** Set when the user dismisses the onboarding panel. */
  onboardingDismissed: false,
  /** Frames elapsed; drives the breathing "touch a pipe" hint only. */
  frame: 0,
  paused: false,
  reducedMotion: false,
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Place the bench for a given canvas size.
 *
 * The block sits near the bottom in portrait (pipes grow upward into the empty
 * space above it) and near the bottom in landscape too, because that is the one
 * arrangement that keeps the tallest pipe, the labels, and the controls on
 * screen at the same time.
 */
function computeLayout(width, height) {
  LAYOUT.width = width;
  LAYOUT.height = height;
  // Block baseline: leaves a strip below for the mouth labels.
  LAYOUT.blockY = height - Math.max(46, Math.min(72, height * 0.09));
  // A metre of pipe should fill most of the available height at default zoom.
  const usableHeight = LAYOUT.blockY - Math.max(96, height * 0.16);
  LAYOUT.pxPerM = usableHeight / 1.1;
  LAYOUT.pipeGap = Math.max(10, Math.min(26, width / 42));
  LAYOUT.firstPipeX = Math.max(18, width * 0.03);
}

/** Screen X of the centre of pipe index i. */
function pipeCenterX(index, radiusM) {
  const widthPx = Math.max(6, radiusM * 2 * LAYOUT.pxPerM);
  let x = LAYOUT.firstPipeX;
  for (let i = 0; i < index; i += 1) {
    x += Math.max(6, app.organ.pipes[i].radiusM * 2 * LAYOUT.pxPerM) + LAYOUT.pipeGap;
  }
  return x + widthPx / 2;
}

/** Length in metres for a pointer Y measured from the block. */
function lengthFromY(y) {
  return Math.max(0.03, (LAYOUT.blockY - y) / LAYOUT.pxPerM);
}

// ---------------------------------------------------------------------------
// Pipe helpers
// ---------------------------------------------------------------------------

const MIN_RADIUS_M = 0.004;
const MAX_RADIUS_M = 0.045;

function addPipe(lengthM, radiusM) {
  const pipe = new Pipe(lengthM, radiusM, 0.5);
  if (app.organ.snapped) app.organ.snapPipe(pipe);
  app.organ.pipes.push(pipe);
  return pipe;
}

/** The pipe whose body contains a screen point, or undefined. */
function pipeAt(x, y) {
  for (const [index, pipe] of app.organ.pipes.entries()) {
    const centerX = pipeCenterX(index, pipe.radiusM);
    const halfWidth = Math.max(6, pipe.radiusM * 2 * LAYOUT.pxPerM) / 2;
    const topY = LAYOUT.blockY - pipe.lengthM * LAYOUT.pxPerM;
    // A few pixels of slack either side: a 6 px wide pipe is impossible to hit
    // with a thumb, and the hit box is allowed to be more generous than the art.
    if (x >= centerX - halfWidth - 6 && x <= centerX + halfWidth + 6 && y >= topY - 8 && y <= LAYOUT.blockY + 8) {
      return { index, pipe, centerX };
    }
  }
  return undefined;
}

/** A short human name for a frequency, e.g. "C4" or "F#3 +31". */
function noteName(frequencyHz, referenceHz) {
  const cents = centsBetween(frequencyHz, referenceHz);
  const semitone = Math.round(cents / 100);
  const sharp = Math.round(cents - semitone * 100);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Octave numbers count from C, so semitone 0 (the organ's reference) is C4.
  const octave = 4 + Math.floor(semitone / 12);
  const degree = ((semitone % 12) + 12) % 12;
  const offset = Math.round(cents - semitone * 100);
  const centsLabel = offset === 0 ? '' : ` ${offset > 0 ? '+' : '−'}${Math.abs(offset)}`;
  return `${names[degree]}${octave}${centsLabel}`;
}

// ---------------------------------------------------------------------------
// Status messages: what just happened, in plain language
// ---------------------------------------------------------------------------

function describeFrequency(pipe) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  return `${noteName(frequency, app.organ.referenceHz)} · ${frequency.toFixed(1)} Hz`;
}

function announceBlow(pipe) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const registerWord = pipe.register === 1 ? 'fundamental' : `register ${pipe.register}`;
  app.message = `Blowing ${describeFrequency(pipe)} — the whole pipe is one quarter-wavelength (${registerWord}).`;
}

function announceCut(pipe) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const endCorrection = 0.6 * pipe.radiusM * 1000;
  app.message = `Cut a pipe ${Math.round(pipe.lengthM * 100)} cm long: ${describeFrequency(pipe)}. ` +
    `The open end adds ~${endCorrection.toFixed(0)} mm, so it speaks a little flat of its measured length.`;
}

function announceWidth(pipe, previousHz) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const deltaCents = centsBetween(frequency, previousHz);
  const direction = deltaCents > 0 ? 'sharper' : 'flatter';
  app.message = `Widened to ${Math.round(pipe.radiusM * 2 * 1000)} mm: ${deltaCents >= 0 ? '+' : ''}` +
    `${deltaCents.toFixed(1)} cents ${direction}, because a wider mouth makes the pipe ` +
    `acoustically longer (${Math.round(pipe.effectiveLengthM() * 1000)} mm effective).`;
}

function announceRegister(pipe, previousRegister) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  if (pipe.register > previousRegister) {
    app.message = `Overblown into register ${pipe.register}: ${describeFrequency(pipe)}. ` +
      `A pipe closed at the foot has no even partials, so it jumped a twelfth (3×), not an octave.`;
  } else {
    app.message = `Back to ${previousRegister === 1 ? 'the fundamental' : `register ${previousRegister}`}: ` +
      `${describeFrequency(pipe)}. Easy does it.`;
  }
}

function announceTemperature() {
  const c = speedOfSound(app.organ.temperatureC);
  const reference = speedOfSound(20);
  const cents = centsBetween(c, reference);
  app.message = `Air at ${app.organ.temperatureC.toFixed(0)} °C: sound travels ${c.toFixed(1)} m/s, so every pipe ` +
    `is ${Math.abs(cents).toFixed(1)} cents ${cents >= 0 ? 'sharp' : 'flat'} of its pitch at 20 °C.`;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/**
 * Work out what a pointer going down means.
 *
 * One hit test, two outcomes: a pipe body belongs to that pipe (blow it, and
 * drag it to change it), and anywhere else on the bench is a request to cut a
 * new one. There is no tool palette to get wrong.
 */
function pointerDown(pointerId, x, y) {
  const hit = pipeAt(x, y);
  if (hit) {
    app.gestures.set(pointerId, {
      type: 'pipe',
      index: hit.index,
      pipe: hit.pipe,
      startX: x,
      startY: y,
      lastY: y,
      previousHz: hit.pipe.frequencyHz(app.organ.temperatureC),
      moved: false,
    });
    app.sounding.add(hit.pipe);
    announceBlow(hit.pipe);
    return;
  }
  // Empty bench: start cutting. The pipe materialises immediately at the block
  // so the drag has something to grow, and it is removed again if the pointer
  // never leaves the block (a tap is not a pipe).
  const pipe = new Pipe(lengthFromY(y), 0.012, 0.5);
  app.organ.pipes.push(pipe);
  app.gestures.set(pointerId, { type: 'cut', pipe, startX: x, startY: y });
}

function pointerMove(pointerId, x, y) {
  const gesture = app.gestures.get(pointerId);
  if (!gesture) return;
  if (gesture.type === 'cut') {
    gesture.pipe.lengthM = lengthFromY(y);
    if (app.organ.snapped) app.organ.snapPipe(gesture.pipe);
    return;
  }
  const { pipe } = gesture;
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  if (Math.abs(dx) > 4) gesture.moved = true;
  if (Math.abs(dy) > 10) gesture.moved = true;

  // Horizontal drag changes the bore; vertical drag overblows. Deciding by which
  // axis dominates means the two never fight over one gesture.
  if (Math.abs(dx) > Math.abs(dy)) {
    const borePx = Math.max(8, Math.abs(dx));
    const nextRadius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, borePx / 2 / LAYOUT.pxPerM));
    if (Math.abs(nextRadius - pipe.radiusM) > 1e-6) {
      pipe.radiusM = nextRadius;
      announceWidth(pipe, gesture.previousHz);
    }
    return;
  }
  if (dy < -26) {
    if (pipe.register < 3) {
      const previous = pipe.register;
      pipe.register += 1;
      announceRegister(pipe, previous);
      gesture.startY = y;
    }
  } else if (dy > 26 && pipe.register > 1) {
    const previous = pipe.register;
    pipe.register -= 1;
    announceRegister(pipe, previous);
    gesture.startY = y;
  }
}

/**
 * Finish a gesture.
 *
 * A cut is committed in place: the pipe being dragged *is* the pipe that stays,
 * because a second `addPipe` would re-snap it and would leave the original
 * behind when the tap was too short to count. Committing by mutating the object
 * the whole session has been watching keeps the identity the renderer, the hit
 * test, and the audio engine all use.
 */
function pointerUp(pointerId) {
  const gesture = app.gestures.get(pointerId);
  if (!gesture) return;
  if (gesture.type === 'cut') {
    const pipe = gesture.pipe;
    const index = app.organ.pipes.indexOf(pipe);
    // A tap that never left the block is not a pipe: 4 cm of tube cannot speak.
    if (pipe.lengthM < 0.04) {
      if (index >= 0) app.organ.pipes.splice(index, 1);
      app.message = 'A pipe has to leave the block to do anything — drag up from the block to cut one.';
    } else {
      if (app.organ.snapped) app.organ.snapPipe(pipe);
      announceCut(pipe);
      // Sound it briefly, so the first thing a new pipe does is tell you the
      // pitch it landed on rather than waiting to be touched.
      app.sounding.add(pipe);
      window.setTimeout(() => app.sounding.delete(pipe), 900);
    }
  } else {
    app.sounding.delete(gesture.pipe);
  }
  app.gestures.delete(pointerId);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * The standing wave inside one pipe, in normalised units.
 *
 * A stopped pipe's fundamental has a pressure node at the open end and an
 * antinode at the closed foot: p(x) = cos(pi/2 * s) where s runs 0 at the foot
 * to 1 at the mouth. Register n has n nodes... which for the odd harmonic k is
 * cos(k * pi/2 * s) with k = 2n-1. Drawing the actual function, rather than a
 * wavy line of arbitrary frequency, is what lets a user see *why* the twelfth.
 */
function standingWave(pipe, sample) {
  const k = 2 * pipe.register - 1;
  return Math.cos((k * Math.PI * 2 * sample) / 4);
}

function drawScene(context) {
  const { width, height } = LAYOUT;
  context.clearRect(0, 0, width, height);

  // Bench: a warm gradient so the block reads as a solid object pipes sit on.
  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#0d1420');
  background.addColorStop(1, '#131b28');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  drawWindchest(context);
  for (const [index, pipe] of app.organ.pipes.entries()) {
    drawPipe(context, index, pipe);
  }
  drawCutHint(context);
}

/** The windchest the pipes stand in, with a level meter that shows the air moving. */
function drawWindchest(context) {
  const { width, blockY, height } = LAYOUT;
  context.fillStyle = '#243044';
  context.fillRect(0, blockY, width, height - blockY);
  context.fillStyle = '#2f3f5a';
  context.fillRect(0, blockY, width, 3);

  // A meter of actual output level, so silence and "nothing is blowing" look
  // different from "audio is blocked by the browser".
  const level = app.audio.readLevel();
  const meterWidth = Math.min(140, width * 0.3);
  context.fillStyle = '#1a2434';
  context.fillRect(width - meterWidth - 14, blockY + 14, meterWidth, 6);
  context.fillStyle = level > 0.02 ? '#7fd6c1' : '#38506e';
  context.fillRect(width - meterWidth - 14, blockY + 14, meterWidth * Math.min(1, level * 2.5), 6);
}

function drawPipe(context, index, pipe) {
  const centerX = pipeCenterX(index, pipe.radiusM);
  const widthPx = Math.max(6, pipe.radiusM * 2 * LAYOUT.pxPerM);
  const heightPx = pipe.lengthM * LAYOUT.pxPerM;
  const topY = LAYOUT.blockY - heightPx;
  const sounding = app.sounding.has(pipe);
  const frequency = pipe.frequencyHz(app.organ.temperatureC);

  // Body
  const body = context.createLinearGradient(centerX - widthPx / 2, 0, centerX + widthPx / 2, 0);
  body.addColorStop(0, sounding ? '#4a6f8a' : '#31465c');
  body.addColorStop(0.5, sounding ? '#9fd8e8' : '#4b6a86');
  body.addColorStop(1, sounding ? '#3c5c74' : '#26374a');
  context.fillStyle = body;
  context.fillRect(centerX - widthPx / 2, topY, widthPx, heightPx);

  // The standing wave, drawn along the pipe's length. Amplitude is scaled by
  // the pipe width so a narrow pipe's wave is visibly narrower, which is true
  // to how the displacement relates to the bore.
  if (heightPx > 24) {
    context.save();
    context.beginPath();
    context.rect(centerX - widthPx / 2, topY, widthPx, heightPx);
    context.clip();
    const waveAmplitude = Math.max(2, widthPx * 0.34);
    const brightness = app.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(app.frame * 0.12);
    context.strokeStyle = sounding
      ? `rgba(12, 26, 38, ${0.85 * brightness})`
      : 'rgba(10, 20, 30, 0.45)';
    context.lineWidth = Math.max(1.5, widthPx * 0.12);
    context.beginPath();
    const steps = 40;
    for (let step = 0; step <= steps; step += 1) {
      const sample = step / steps;
      const y = LAYOUT.blockY - sample * heightPx;
      const offset = standingWave(pipe, sample) * waveAmplitude * (sounding ? 1 : 0.5);
      const x = centerX + offset;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    context.restore();
  }

  // The mouth: the hole the wind goes across. Its position along the pipe is the
  // footprint, and dragging it changes the tone.
  const mouthY = LAYOUT.blockY - pipe.footprint * heightPx;
  context.fillStyle = sounding ? '#ffd9a0' : '#f0b97a';
  context.fillRect(centerX - widthPx / 2 - 2, mouthY - 2, widthPx + 4, 4);

  // Sounding glow
  if (sounding) {
    context.strokeStyle = 'rgba(160, 232, 255, 0.5)';
    context.lineWidth = 2;
    context.strokeRect(centerX - widthPx / 2 - 3, topY - 3, widthPx + 6, heightPx + 6);
  }

  drawPipeLabel(context, centerX, topY, widthPx, pipe, frequency, sounding);
}

/** The small readout above each pipe: what it is, and how out of tune it is. */
function drawPipeLabel(context, centerX, topY, widthPx, pipe, frequency, sounding) {
  const text = `${noteName(frequency, app.organ.referenceHz)}`;
  const fontSize = Math.max(11, Math.min(15, widthPx * 0.9));
  context.font = `600 ${fontSize}px "Stem Sans", system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.fillStyle = sounding ? '#e9f7ff' : '#b8c8dc';
  const labelY = Math.max(fontSize + 2, topY - 8);
  context.fillText(text, centerX, labelY);

  // Length, in the units the user is actually cutting in.
  context.font = `400 ${Math.max(10, fontSize - 2)}px "Stem Sans", system-ui, sans-serif`;
  context.fillStyle = '#8aa0bd';
  context.fillText(`${Math.round(pipe.lengthM * 100)} cm · r${pipe.register}`, centerX, labelY - fontSize - 2);
}

/**
 * The invitation to cut a pipe, drawn where the gesture happens.
 *
 * It appears when there is nothing on the bench and fades out once the user has
 * clearly worked out what to do, so it teaches without becoming clutter.
 */
function drawCutHint(context) {
  if (app.organ.pipes.length > 0) return;
  const { width, blockY } = LAYOUT;
  const alpha = app.reducedMotion ? 0.75 : 0.5 + 0.25 * Math.sin(app.frame * 0.05);
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = '#7fd6c1';
  context.lineWidth = 2;
  context.setLineDash([6, 6]);
  const x = LAYOUT.firstPipeX + 24;
  context.beginPath();
  context.moveTo(x, blockY - 6);
  context.lineTo(x, blockY - 150);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(x - 7, blockY - 142);
  context.lineTo(x, blockY - 156);
  context.lineTo(x + 7, blockY - 142);
  context.stroke();
  context.fillStyle = '#cfeee6';
  context.font = '600 15px "Stem Sans", system-ui, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'bottom';
  context.fillText('drag up from the block to cut a pipe', x + 14, blockY - 120);
  context.restore();
}

// ---------------------------------------------------------------------------
// Wiring: canvas, pointer events, controls, controls, resize
// ---------------------------------------------------------------------------

/** Seed the bench with three pipes so the first screen is never empty. */
function seedRack() {
  app.organ.pipes = [];
  // Rough lengths; tune-lock snaps each to a semitone, and these three land on
  // C3, G3, C4: a stopped pipe's own first two resonances (1x and 3x) plus an
  // octave, so the opening screen is already showing the thing the instrument is
  // about rather than three arbitrary pitches.
  addPipe(0.65, 0.012);
  addPipe(0.427, 0.018);
  addPipe(0.3226, 0.009);
}

function syncControls() {
  const temperature = document.querySelector('#temperature');
  const value = document.querySelector('#temperature-value');
  if (temperature) temperature.value = String(app.organ.temperatureC);
  if (value) value.textContent = `${app.organ.temperatureC.toFixed(0)} °C`;
  const snapped = document.querySelector('#snap');
  if (snapped) snapped.checked = app.organ.snapped;
  const message = document.querySelector('#status');
  if (message) message.textContent = app.message;
  const audio = document.querySelector('#audio-note');
  if (audio) {
    const state = app.audio.state;
    if (state === 'unavailable') {
      audio.textContent = 'This browser is not providing audio output, so the picture and the numbers are all there is.';
    } else if (state === 'not-started' || state === 'suspended') {
      audio.textContent = 'Sound starts on your first touch of the bench.';
    } else {
      audio.textContent = '';
    }
  }
}

function resize() {
  const canvas = app.canvas;
  if (!canvas) return;
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(240, Math.floor(rect.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  app.context = context;
  computeLayout(width, height);
}

function pointFromEvent(event) {
  const rect = app.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function bindCanvas() {
  const canvas = app.canvas;
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    // Every gesture counts as the user gesture Web Audio wants, so sound starts
    // on the same touch that plays the first note.
    app.audio.start();
    const { x, y } = pointFromEvent(event);
    pointerDown(event.pointerId, x, y);
  });
  canvas.addEventListener('pointermove', (event) => {
    const { x, y } = pointFromEvent(event);
    pointerMove(event.pointerId, x, y);
  });
  const end = (event) => pointerUp(event.pointerId);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // A keyboard equivalent so the instrument is reachable without a pointer.
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    app.audio.start();
    const index = Math.min(app.organ.pipes.length - 1, 0);
    const pipe = app.organ.pipes[index];
    if (pipe) {
      app.sounding.add(pipe);
      announceBlow(pipe);
      window.setTimeout(() => app.sounding.delete(pipe), 600);
    }
  });
}

function bindControls() {
  const temperature = document.querySelector('#temperature');
  temperature?.addEventListener('input', () => {
    app.organ.temperatureC = Number(temperature.value);
    announceTemperature();
    syncControls();
  });
  const snap = document.querySelector('#snap');
  snap?.addEventListener('change', () => {
    app.organ.snapped = snap.checked;
    app.message = snap.checked
      ? 'Tune-lock on: new pipes snap to the nearest semitone.'
      : 'Tune-lock off: pipes now sit exactly where you cut them, so neighbours can beat against each other.';
    syncControls();
  });
  const reset = document.querySelector('#reset');
  reset?.addEventListener('click', () => {
    seedRack();
    app.message = 'Fresh rack: C3, G3, C4 — a stopped pipe’s fundamental, its twelfth, and an octave.';
    syncControls();
  });
  const help = document.querySelector('#help-toggle');
  const panel = document.querySelector('#onboarding');
  help?.addEventListener('click', () => {
    const hidden = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !hidden);
    app.onboardingDismissed = !hidden;
  });
  document.querySelector('#onboarding-close')?.addEventListener('click', () => {
    panel?.setAttribute('hidden', '');
    app.onboardingDismissed = true;
    syncControls();
  });
}

/** Apply audio state to the voices that should currently be sounding. */
function serviceVoices() {
  if (app.audio.state !== 'running') return;
  const live = new Set();
  for (const pipe of app.sounding) {
    const id = app.organ.pipes.indexOf(pipe);
    if (id < 0) continue;
    live.add(id);
    app.audio.noteOn(id, pipe, app.organ);
  }
  for (const id of [...app.audio.voices.keys()]) {
    if (!live.has(id)) app.audio.noteOff(id);
  }
}

function frame() {
  app.frame += 1;
  if (!app.paused) {
    serviceVoices();
    if (app.context) drawScene(app.context);
    syncControls();
  }
  window.requestAnimationFrame(frame);
}

function main() {
  app.canvas = document.querySelector('#bench');
  app.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  app.paused = new URLSearchParams(window.location.search).has('paused');
  seedRack();
  resize();
  bindCanvas();
  bindControls();
  exposeTestApi();
  announceBlow(app.organ.pipes[0]);
  window.addEventListener('resize', resize);
  // Announce readiness for the browser tests before the first frame is drawn, so
  // a page that has booted but is paused mid-draw is distinguishable from one
  // whose script threw.
  document.documentElement.dataset.stemReady = '1';
  window.requestAnimationFrame(frame);
}

main();

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/*
 * The one documented way a browser test reaches the app.
 *
 * The artifact ships no module system and no globals beyond this, so a test
 * needs an explicit place to stand. It is deliberately the *live* objects
 * rather than a copy: a test that reads `view.organ.pipes` is reading the same
 * Pipe instances the renderer and the audio engine read, which is what makes a
 * passing behavioural assertion mean something.
 *
 * `stepFrames(n)` exists because a screenshot of a live animation is not a
 * golden: it pins the state to an exact frame count instead of an elapsed time.
 */
function exposeTestApi() {
  window.__stem = {
    view: app,
    organ: app.organ,
    audio: app.audio,
    stepFrames(count) {
      for (let i = 0; i < count; i += 1) {
        app.frame += 1;
        serviceVoices();
        if (app.context) drawScene(app.context);
      }
      return app.frame;
    },
    /** Named positions on the bench, resolved from the same geometry the hit
     *  test uses, so a gesture points at the same thing on any viewport. */
    anchors() {
      const benchTop = app.canvas.getBoundingClientRect().top;
      const benchLeft = app.canvas.getBoundingClientRect().left;
      const toClient = (x, y) => ({ x: Math.round(benchLeft + x), y: Math.round(benchTop + y) });
      const pipes = app.organ.pipes.map((pipe, index) => {
        const centerX = pipeCenterX(index, pipe.radiusM);
        return {
          centerX: Math.round(centerX),
          widthPx: Math.max(6, pipe.radiusM * 2 * LAYOUT.pxPerM),
          topY: Math.round(LAYOUT.blockY - pipe.lengthM * LAYOUT.pxPerM),
          middle: toClient(centerX, LAYOUT.blockY - (pipe.lengthM * LAYOUT.pxPerM) / 2),
          frequency: pipe.frequencyHz(app.organ.temperatureC),
          lengthCm: Math.round(pipe.lengthM * 100),
          register: pipe.register,
        };
      });
      // A point on the block with no pipe above it, computed the same way the
      // hit test does rather than by eye: a "blank" spot that is actually over a
      // pipe starts a blow, not a cut, and the test silently checks the wrong verb.
      let empty = null;
      for (let fx = 0.1; fx <= 0.95; fx += 0.05) {
        const x = Math.round(LAYOUT.width * fx);
        const y = Math.round(LAYOUT.blockY - 8);
        if (!pipeAt(x, y)) {
          empty = toClient(x, y);
          break;
        }
      }
      return {
        pipes,
        empty,
        block: toClient(LAYOUT.width * 0.5, LAYOUT.blockY - 4),
        blockY: Math.round(LAYOUT.blockY),
        width: LAYOUT.width,
        height: LAYOUT.height,
      };
    },
  };
}
