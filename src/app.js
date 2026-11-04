/**
 * app.js — the bench: layout, gestures, drawing, and the words that explain it.
 *
 * The verbs, chosen so that everything the acoustics model contains is reachable
 * with a finger and none of it hides behind a mode switch:
 *
 *   DRAG UP FROM THE BLOCK   Cut a new pipe. Its length is where you let go.
 *   TOUCH A PIPE             Blow it. Hold to keep it sounding.
 *   DRAG A PIPE SIDEWAYS     Change its bore, which changes its pitch through the
 *                            end correction and its tone through the spectrum.
 *   DRAG ACROSS ITS MOUTH    Move the windhole. Low = flutey, high = stringy.
 *   FLICK A PIPE UP HARD     Overblow it: the pitch jumps a TWELFTH, not an octave.
 *   DOUBLE-TAP / DBL-CLICK   Take the pipe off the rack.
 *
 * A firm upward flick only overblows once it is far enough from where it began,
 * which is what makes "blow a low C and flick it up a twelfth" one continuous
 * gesture, the way an organist actually overblows.
 *
 * Everything is drawn from the same Pipe objects the audio reads, so the picture
 * and the pitch cannot drift apart.
 */

/** Layout constants that depend on the canvas size; recomputed on resize. */
const LAYOUT = {
  width: 0,
  height: 0,
  blockY: 0,
  pipeGap: 0,
  firstPipeX: 0,
  /** Comfortable touch target: narrower than this and a thumb misses the pipe. */
  minPipeWidthPx: 26,
  /**
   * Base drawn pipe width, and how strongly a real bore shows on top of it.
   *
   * Measured by rendering the opening rack at the three target viewports and
   * looking at the result: a smaller base left the standing wave unreadable and
   * the three pipes too close in width to tell apart, while a larger gain drew
   * bins rather than pipes. These put the three-pipe row at about two thirds of
   * a portrait phone with each wave legible inside its own pipe.
   */
  basePipeWidthPx: 48,
  boreVisualGain: 1.6,
  /** A cut shorter than this is a tap, not a pipe. */
  minCutM: 0.05,
  /**
   * Shrink factor applied to every drawn pipe width so a long rack fits the
   * bench. 1 whenever the row fits; recomputed by rackWidthPx().
   */
  rowScale: 1,
  /** Air kept either side of a centred row, in px. */
  rowMarginPx: 18,
  /**
   * How much pipe length the bench shows at full height, in metres, and the
   * scale that follows from it. Fixed for a given viewport; see updateScale().
   * 0.75 m reaches a little below C3, which is as low as this bench goes.
   */
  viewSpanM: 0.75,
  pxPerM: 1,
};

const app = {
  canvas: null,
  context: null,
  organ: new Organ(),
  audio: new AudioEngine(),
  /** Pipe objects currently being blown. */
  sounding: new Set(),
  /** Pointer id -> the gesture it is performing. */
  gestures: new Map(),
  /** One-shot status sentence, shown under the canvas. */
  message: '',
  /** Frames elapsed; drives the idle breathing animation only. */
  frame: 0,
  /** Under test: frames advance only when a test says so. */
  paused: false,
  reducedMotion: false,
  /** Pointer id and time of the last completed tap, for double-tap delete. */
  lastTap: { pipe: null, at: 0 },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Place the bench for a given canvas size.
 *
 * The block always sits near the bottom and pipes grow upward, in portrait and
 * landscape alike: it is the one arrangement that keeps the tallest pipe, its
 * label, and the controls on screen at the same time.
 */
function computeLayout(width, height) {
  LAYOUT.width = width;
  LAYOUT.height = height;
  LAYOUT.blockY = height - Math.max(42, Math.min(72, height * 0.09));
  // The space a full-height pipe occupies: from the block up to the reserve that
  // holds the label of the tallest pipe.
  LAYOUT.usableHeightPx = LAYOUT.blockY - Math.max(72, height * 0.12);
  LAYOUT.pipeGap = Math.max(12, Math.min(30, width / 34));
  updateScale();
  // Centre the row on its fitted width. Packing it against the left edge left
  // five sixths of a desktop empty and made a three-pipe rack read as a fragment.
  LAYOUT.firstPipeX = Math.max(LAYOUT.rowMarginPx, (width - rackWidthPx()) / 2);
}

/** The row's width before fitting: unscaled gaps plus each pipe's natural width. */
function naturalRackPx() {
  const gaps = (app.organ.pipes.length - 1) * LAYOUT.pipeGap;
  const widths = app.organ.pipes.reduce(
    (total, pipe) => total + naturalPipeWidthPx(pipe),
    0,
  );
  return gaps + widths;
}

/**
 * Total width of the row of pipes, gaps included, after any shrink needed to fit.
 *
 * Drawn widths are presentation, so when a rack is wide enough to overflow the
 * bench the whole row is scaled down together: bores keep their proportions, and
 * only the exaggeration is reduced. Without this, a dozen pipes spill off the
 * right-hand edge and a phone user cannot reach or see the newest ones.
 */
function rackWidthPx() {
  const count = app.organ.pipes.length;
  if (count === 0) return 0;
  const natural = (count - 1) * LAYOUT.pipeGap + naturalRackPx();
  // Leave a margin so the row is never flush against both edges.
  const available = Math.max(0, LAYOUT.width - 2 * LAYOUT.rowMarginPx);
  LAYOUT.rowScale = natural > available ? available / natural : 1;
  return natural * LAYOUT.rowScale;
}

/**
 * The scale of the bench, in pixels per metre.
 *
 * Set by the *viewport*, once, in computeLayout: the metre span the bench shows
 * is fixed, so a drag maps to a length and a length maps back to a height without
 * the two feeding each other.
 *
 * An earlier version let the scale follow the longest pipe, so a single long pipe
 * filled the screen. It looked better and it was unsound: the length a drag asked
 * for was dy / pxPerM, while pxPerM was derived from the longest pipe, so cutting
 * to a given fraction of the bench always produced the same length no matter how
 * far the finger moved. Two pipes cut four pixels apart came out *identically*
 * the same length, which quietly destroys the beating demo this whole instrument
 * is built around. Fitting the view to the content is worth doing, but only in a
 * transform that the gesture maths never reads.
 */
function updateScale() {
  LAYOUT.pxPerM = LAYOUT.usableHeightPx / LAYOUT.viewSpanM;
}

/**
 * Width in px that a pipe's bore is drawn at.
 *
 * Deliberately not the true bore scaled. A 12 mm-radius pipe is a hairline at
 * any scale where the whole instrument fits, and a wave drawn inside a hairline
 * is not a wave: the drawn width is a base plus the true width times a gain, so
 * the *differences* between bores stay honest and visible, which is what the
 * bore gesture is about, while every pipe is wide enough to show its own wave.
 * The label states the real diameter and the pitch uses the real radius, so no
 * physics is inflated. The constants are measured, not guessed: see LAYOUT.
 */
function naturalPipeWidthPx(pipe) {
  const trueWidthPx = pipe.radiusM * 2 * LAYOUT.pxPerM;
  return Math.max(
    LAYOUT.minPipeWidthPx,
    LAYOUT.basePipeWidthPx + trueWidthPx * LAYOUT.boreVisualGain,
  );
}

/** The width actually drawn and hit-tested: the natural width, fitted to the bench. */
function pipeWidthPx(pipe) {
  return naturalPipeWidthPx(pipe) * LAYOUT.rowScale;
}

/**
 * Screen X of the centre of the pipe at `index`.
 *
 * A pipe carries its own x once it has been placed (see `anchorX`), so cutting a
 * second pipe over the first puts them in the same column rather than shoving the
 * new one off to the side. Pipes with no x of their own -- every pipe the bench
 * seeds, and any added programmatically -- pack left to right as before.
 */
function pipeCenterX(index) {
  const pipe = app.organ.pipes[index];
  if (pipe.anchorX !== undefined) return pipe.anchorX;
  // Walk the same fitted widths and the same fitted gap that rackWidthPx() added
  // up. Deriving the position from one model is what keeps the row from drifting
  // past the edge the fit was supposed to keep it inside.
  const gap = LAYOUT.pipeGap * LAYOUT.rowScale;
  let x = LAYOUT.firstPipeX;
  for (let i = 0; i < index; i += 1) {
    x += pipeWidthPx(app.organ.pipes[i]) + gap;
  }
  return x + pipeWidthPx(pipe) / 2;
}

/** The pipe's height in px, from the block to its top. */
function pipeHeightPx(pipe) {
  return pipe.lengthM * LAYOUT.pxPerM;
}

/**
 * Length in metres that a pointer Y measured from the block asks for.
 *
 * The upper clamp is the full drawable height at the *current* scale, which
 * grows as the view eases out, so a long cut is limited by the screen rather
 * than by the frame it started in.
 */
function lengthFromY(y) {
  const raw = (LAYOUT.blockY - y) / LAYOUT.pxPerM;
  return Math.min(Math.max(raw, 0), LAYOUT.viewSpanM);
}

// ---------------------------------------------------------------------------
// Pipe helpers
// ---------------------------------------------------------------------------

const MIN_RADIUS_M = 0.004;
const MAX_RADIUS_M = 0.05;

function addPipe(lengthM, radiusM) {
  const pipe = new Pipe(lengthM, radiusM, 0.5);
  if (app.organ.snapped) app.organ.snapPipe(pipe);
  app.organ.pipes.push(pipe);
  return pipe;
}

/** Where a pipe's mouth sits on screen. */
function mouthY(pipe) {
  return LAYOUT.blockY - pipe.footprint * pipeHeightPx(pipe);
}

/**
 * The pipe and part of a pipe under a screen point.
 *
 * Returns kind 'pipe' for the body and 'mouth' for the band around the windhole,
 * which is dragged separately. The hit box is deliberately more generous than the
 * art: a 6 px wide pipe is impossible to hit with a thumb.
 */
function hitTest(x, y) {
  const mouthBandPx = 18;
  // Walk backwards: the last-drawn pipe is the visually topmost one, so it must
  // win where two overlap. That is what makes the stack-and-compare gesture work
  // -- pipes pushed upward sit over the ones behind them, and grab as drawn.
  for (let index = app.organ.pipes.length - 1; index >= 0; index -= 1) {
    const pipe = app.organ.pipes[index];
    const centerX = pipeCenterX(index);
    const halfWidth = pipeWidthPx(pipe) / 2;
    const topY = LAYOUT.blockY - pipeHeightPx(pipe);
    if (x < centerX - halfWidth - 8 || x > centerX + halfWidth + 8) continue;
    if (y < topY - 10 || y > LAYOUT.blockY + 8) continue;
    // The mouth is grabbed by the tab that sticks out past the pipe's edge, not
    // by a band across the whole bore. A band would swallow the middle of every
    // pipe -- the mouth sits at 50% by default -- and the body gesture, which is
    // the one you need in order to overblow, would be unreachable.
    const grabFromEdge = halfWidth + 10;
    if (Math.abs(x - centerX) > grabFromEdge - 8 && Math.abs(y - mouthY(pipe)) <= mouthBandPx) {
      return { kind: 'mouth', index, pipe, centerX };
    }
    return { kind: 'pipe', index, pipe, centerX };
  }
  return { kind: 'none' };
}

/** A short human name for a frequency, e.g. "C4" or "F#3 +31". */
function noteName(frequencyHz, referenceHz) {
  const cents = centsBetween(frequencyHz, referenceHz);
  const semitone = Math.round(cents / 100);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Octave numbers count from C, so semitone 0 (the organ's reference) is C4.
  const octave = 4 + Math.floor(semitone / 12);
  const degree = ((semitone % 12) + 12) % 12;
  const offset = Math.round(cents - semitone * 100);
  const centsLabel = offset === 0 ? '' : ` ${offset > 0 ? '+' : '\u2212'}${Math.abs(offset)}`;
  return `${names[degree]}${octave}${centsLabel}`;
}

// ---------------------------------------------------------------------------
// Status messages: what just happened, in plain language
// ---------------------------------------------------------------------------

function describeFrequency(pipe) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  return `${noteName(frequency, app.organ.referenceHz)} \u00b7 ${frequency.toFixed(1)} Hz`;
}

function announceBlow(pipe) {
  const registerWord = pipe.register === 1 ? 'its fundamental' : `register ${pipe.register}`;
  app.message = `Blowing ${describeFrequency(pipe)}. This pipe is speaking ${registerWord}: ` +
    `a stopped pipe holds an odd number of quarter-wavelengths, and length sets the pitch.`;
}

function announceCut(pipe) {
  const endCorrectionMm = 0.6 * pipe.radiusM * 1000;
  app.message = `A pipe ${Math.round(pipe.lengthM * 100)} cm long speaks ${describeFrequency(pipe)}. ` +
    `The open end makes it behave ${Math.round(endCorrectionMm)} mm longer than you cut it, ` +
    `so it lands a touch flat of the arithmetic.`;
}

function announceWidth(pipe, previousHz) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const deltaCents = centsBetween(frequency, previousHz);
  const direction = deltaCents > 0 ? 'sharper' : 'flatter';
  app.message = `Bore ${Math.round(pipe.radiusM * 2 * 1000)} mm: ${deltaCents >= 0 ? '+' : '\u2212'}` +
    `${Math.abs(deltaCents).toFixed(1)} cents ${direction} than before. A wider mouth is a ` +
    `longer end correction, so the pipe now measures ` +
    `${Math.round(pipe.effectiveLengthM() * 1000)} mm to the air rather than ` +
    `${Math.round(pipe.lengthM * 1000)} mm to the rim.`;
}

function announceMouth(pipe, previousHz) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const deltaCents = Math.abs(centsBetween(frequency, previousHz));
  const colour = pipe.footprint < 0.35 ? 'flutey: mostly fundamental'
    : pipe.footprint > 0.65 ? 'stringy: the upper partials come through'
      : 'balanced between the two';
  app.message = `Windhole moved to ${Math.round(pipe.footprint * 100)}% up the pipe, which makes it ${colour}. ` +
    (deltaCents > 1
      ? `It also slipped ${deltaCents.toFixed(1)} cents, because the mouth is the top of the pipe.`
      : `The pitch barely moved \u2014 this is a colour control.`);
}

function announceRegister(pipe, previousRegister) {
  if (pipe.register > previousRegister) {
    app.message = `Overblown into register ${pipe.register}: ${describeFrequency(pipe)}. ` +
      `A pipe closed at the foot has no even partials, so it jumped a TWELFTH (3\u00d7), not an octave.`;
  } else {
    app.message = `Back down to ${previousRegister === 1 ? 'the fundamental' : `register ${previousRegister}`}: ` +
      `${describeFrequency(pipe)}.`;
  }
}

function announceTemperature() {
  const c = speedOfSound(app.organ.temperatureC);
  const cents = centsBetween(c, speedOfSound(20));
  app.message = `Air at ${app.organ.temperatureC.toFixed(0)} \u00b0C: sound travels ${c.toFixed(1)} m/s, ` +
    `so every pipe is ${Math.abs(cents).toFixed(1)} cents ${cents >= 0 ? 'sharp' : 'flat'} ` +
    `of its pitch at 20 \u00b0C. Warm organs go sharp; that is physics, not bad tuning.`;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/**
 * What a pointer going down means: one hit test, three outcomes.
 *
 * A pipe's body belongs to that pipe, its mouth band belongs to the mouth, and
 * anywhere else on the bench is a request to cut a new one. There is no palette
 * to get wrong and no mode to be stuck in.
 */
function pointerDown(pointerId, x, y, timestamp) {
  const hit = hitTest(x, y);
  if (hit.kind === 'mouth') {
    app.gestures.set(pointerId, { type: 'mouth', pipe: hit.pipe, previousHz: hit.pipe.frequencyHz(app.organ.temperatureC) });
    return;
  }
  if (hit.kind === 'pipe') {
    // Double-tap detection lives here rather than in a click handler so a touch
    // and a mouse take exactly the same path.
    const now = timestamp ?? performance.now();
    const isSecondTap = app.lastTap.pipe === hit.pipe && now - app.lastTap.at < 420;
    if (isSecondTap) {
      app.lastTap = { pipe: null, at: 0 };
      removePipe(hit.pipe);
      return;
    }
    app.lastTap = { pipe: hit.pipe, at: now };
    app.gestures.set(pointerId, {
      type: 'pipe',
      pipe: hit.pipe,
      startX: x,
      startY: y,
      startWidthPx: pipeWidthPx(hit.pipe),
      previousHz: hit.pipe.frequencyHz(app.organ.temperatureC),
    });
    app.sounding.add(hit.pipe);
    announceBlow(hit.pipe);
    return;
  }
  // Empty bench: start cutting. The pipe exists immediately so the drag has
  // something to grow, and is removed on release if it never left the block.
  // Its x is where the drag started, which is what makes it possible to line a
  // new pipe up directly above an existing one: push it up at the same place, and
  // it is drawn on top and grabs in front -- the way you compare two pipes that
  // are a few cents apart to hear them beat.
  const pipe = new Pipe(lengthFromY(y), 0.012, 0.5);
  pipe.anchorX = x;
  app.organ.pipes.push(pipe);
  app.gestures.set(pointerId, { type: 'cut', pipe });
}

function removePipe(pipe) {
  const index = app.organ.pipes.indexOf(pipe);
  if (index >= 0) app.organ.pipes.splice(index, 1);
  app.sounding.delete(pipe);
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  app.message = `Took the ${noteName(frequency, app.organ.referenceHz)} pipe off the rack. ` +
    (app.organ.pipes.length === 0
      ? 'The bench is empty \u2014 drag up from the block to cut another.'
      : `${app.organ.pipes.length} pipe(s) left.`);
}

/**
 * Decide what a drag means, by which part is grabbed and which way it moves.
 *
 * Mouth band: reposition the windhole. Pipe body, sideways: change the bore.
 * Pipe body, up and far: overblow. The distance gate on overblowing is what lets
 * one press both blow the pipe and then throw it up a twelfth, and stops a
 * slightly-slanted touch from changing the pitch under someone's finger.
 */
function pointerMove(pointerId, x, y) {
  const gesture = app.gestures.get(pointerId);
  if (!gesture) return;
  const { organ } = app;

  if (gesture.type === 'cut') {
    gesture.pipe.lengthM = lengthFromY(y);
    if (organ.snapped) organ.snapPipe(gesture.pipe);
    return;
  }

  if (gesture.type === 'mouth') {
    const { pipe } = gesture;
    const heightPx = pipeHeightPx(pipe);
    if (heightPx <= 0) return;
    const next = Math.min(Math.max((LAYOUT.blockY - y) / heightPx, 0.05), 1);
    if (Math.abs(next - pipe.footprint) > 1e-4) {
      pipe.footprint = next;
      // The mouth *is* the top of the pipe, so moving it changes the length that
      // matters. Report honestly instead of pretending it is a pure colour knob.
      organ.snapPipe(pipe);
      announceMouth(pipe, gesture.previousHz);
      gesture.previousHz = pipe.frequencyHz(organ.temperatureC);
    }
    return;
  }

  const { pipe } = gesture;
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  const overblowThresholdPx = 90;

  if (Math.abs(dy) > overblowThresholdPx && dy < 0 && pipe.register < 3) {
    const previous = pipe.register;
    pipe.register += 1;
    announceRegister(pipe, previous);
    // Re-arm from here, so a long flick can walk up the registers one at a time.
    gesture.startX = x;
    gesture.startY = y;
    return;
  }
  if (dy > overblowThresholdPx && pipe.register > 1) {
    const previous = pipe.register;
    pipe.register -= 1;
    announceRegister(pipe, previous);
    gesture.startX = x;
    gesture.startY = y;
    return;
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    const nextRadius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, boreRadiusFromDrag(gesture.startWidthPx, dx)));
    if (Math.abs(nextRadius - pipe.radiusM) > 1e-6) {
      pipe.radiusM = nextRadius;
      if (app.organ.snapped) app.organ.snapPipe(pipe);
      announceWidth(pipe, gesture.previousHz);
      gesture.previousHz = pipe.frequencyHz(app.organ.temperatureC);
    }
  }
}

/**
 * Bore radius for a horizontal drag, measured as a change from where it began.
 *
 * The alternative — treating the absolute pointer x as the bore — makes a pipe
 * jump to whatever width the finger happened to land at. Dragging relative to the
 * press point means the pipe responds to the gesture rather than to the geometry
 * of the screen.
 */
function boreRadiusFromDrag(startWidthPx, dx) {
  return (startWidthPx + dx * 1.5) / 2 / LAYOUT.pxPerM;
}

function pointerUp(pointerId) {
  const gesture = app.gestures.get(pointerId);
  if (!gesture) return;
  if (gesture.type === 'cut') {
    const pipe = gesture.pipe;
    const index = app.organ.pipes.indexOf(pipe);
    if (pipe.lengthM < LAYOUT.minCutM) {
      // A tap that never left the block is not a pipe.
      if (index >= 0) app.organ.pipes.splice(index, 1);
      app.message = 'Nothing happened \u2014 drag up from the block, and keep going, to cut a pipe.';
    } else {
      if (app.organ.snapped) app.organ.snapPipe(pipe);
      announceCut(pipe);
      // Sound it briefly, so the first thing a new pipe does is tell you what
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
 * The pressure standing wave inside one pipe, as a function of position.
 *
 * s runs 0 at the closed foot to 1 at the open mouth, and register n holds
 * k = 2n - 1 quarter wavelengths, so the shape is cos(k * pi/2 * s).
 *
 * Pressure is drawn rather than displacement, and that choice is load-bearing
 * for the moment the instrument exists to teach. Displacement is sin(k*pi/2*s):
 * it is zero at the foot, so the first thing a displacement plot does on going
 * from register 1 to register 2 is stay invisible at the bottom while the pitch
 * jumps a twelfth. Pressure is cos(): a full antinode at the closed foot and a
 * node at the mouth, which is the real boundary condition, and the new node
 * appears where the eye already is. Found by rendering both and looking.
 */
function standingWave(pipe, sample) {
  const k = 2 * pipe.register - 1;
  return Math.cos((k * Math.PI * sample) / 2);
}

/**
 * A colour for a pipe, from where it sits in the rack.
 *
 * Derived from the pitch rather than chosen, so two pipes an octave apart read as
 * related and the eye gets the same information the ear does.
 */
function pipeHue(pipe) {
  const semitones = centsBetween(pipe.frequencyHz(app.organ.temperatureC), app.organ.referenceHz) / 100;
  return ((semitones * 9) % 360 + 360) % 360;
}

function drawScene(context) {
  const { width, height } = LAYOUT;
  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#0b1220');
  background.addColorStop(1, '#141d2c');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  drawWindchest(context);
  for (const [index, pipe] of app.organ.pipes.entries()) {
    drawPipe(context, index, pipe);
  }
  if (app.organ.pipes.length === 0) drawCutHint(context);
}

/** The windchest the pipes stand in, with a meter showing real output level. */
function drawWindchest(context) {
  const { width, blockY, height } = LAYOUT;
  context.fillStyle = '#26324a';
  context.fillRect(0, blockY, width, height - blockY);
  context.fillStyle = '#3a4c69';
  context.fillRect(0, blockY, width, 3);

  // The meter reads the audio bus, so "silence" and "the browser blocked audio"
  // look different from "nothing is blowing".
  const level = app.audio.readLevel();
  const meterWidth = Math.min(150, width * 0.3);
  const meterX = width - meterWidth - 14;
  const meterY = blockY + Math.max(10, (height - blockY) / 2 - 3);
  context.fillStyle = '#1a2434';
  context.fillRect(meterX, meterY, meterWidth, 6);
  context.fillStyle = level > 0.02 ? '#7fd6c1' : '#3a5573';
  context.fillRect(meterX, meterY, meterWidth * Math.min(1, level * 2.5), 6);
}

function drawPipe(context, index, pipe) {
  const centerX = pipeCenterX(index);
  const widthPx = pipeWidthPx(pipe);
  const heightPx = pipeHeightPx(pipe);
  const topY = LAYOUT.blockY - heightPx;
  const sounding = app.sounding.has(pipe);
  const hue = pipeHue(pipe);
  const light = sounding ? 68 : 44;

  const body = context.createLinearGradient(centerX - widthPx / 2, 0, centerX + widthPx / 2, 0);
  body.addColorStop(0, `hsl(${hue}, 34%, ${light - 16}%)`);
  body.addColorStop(0.45, `hsl(${hue}, 46%, ${light}%)`);
  body.addColorStop(1, `hsl(${hue}, 34%, ${light - 10}%)`);
  context.fillStyle = body;
  context.fillRect(centerX - widthPx / 2, topY, widthPx, heightPx);

  // Closed foot: a solid cap, because that boundary is the whole reason a
  // stopped pipe sounds an octave below an open one.
  context.fillStyle = `hsl(${hue}, 30%, ${light - 24}%)`;
  context.fillRect(centerX - widthPx / 2 - 2, LAYOUT.blockY - 5, widthPx + 4, 5);

  drawStandingWave(context, pipe, centerX, widthPx, heightPx, sounding);
  drawMouth(context, pipe, centerX, widthPx, sounding);
  drawPipeLabel(context, centerX, topY, pipe, sounding);
}

/**
 * The wave, clipped to the pipe.
 *
 * Its amplitude follows the drawn bore, so a fat pipe's wave is visibly fatter:
 * the displacement has somewhere to happen. When silent the wave is still drawn,
 * dimmer, because *where the wave would sit* is the thing being taught.
 */
function drawStandingWave(context, pipe, centerX, widthPx, heightPx, sounding) {
  if (heightPx < 16) return;
  context.save();
  context.beginPath();
  context.rect(centerX - widthPx / 2, LAYOUT.blockY - heightPx, widthPx, heightPx);
  context.clip();
  const pulse = app.reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(app.frame * 0.1);
  const amplitude = Math.max(2, (widthPx / 2 - 2) * (sounding ? pulse : 0.55));
  context.strokeStyle = sounding ? 'rgba(8, 18, 30, 0.8)' : 'rgba(8, 18, 30, 0.4)';
  context.lineWidth = Math.max(1.5, widthPx * 0.1);
  context.beginPath();
  const steps = 48;
  for (let step = 0; step <= steps; step += 1) {
    const sample = step / steps;
    const y = LAYOUT.blockY - sample * heightPx;
    const x = centerX + standingWave(pipe, sample) * amplitude;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  context.restore();
}

/**
 * The mouth: the windhole the player aims at, and the drag handle for tone.
 *
 * Drawn as a lip sticking out past the pipe, the way a real flue pipe's mouth is
 * a cut in the side, so it reads as something to grab rather than decoration.
 */
function drawMouth(context, pipe, centerX, widthPx, sounding) {
  const y = mouthY(pipe);
  const tabWidth = widthPx + 22;
  // A raised lip wider than the bore, with the windhole itself as the dark slot
  // in the middle: it reads as a handle sticking out either side, which is what
  // the hit test actually grabs.
  context.fillStyle = sounding ? '#ffdca0' : '#d9a468';
  context.fillRect(centerX - tabWidth / 2, y - 4, tabWidth, 8);
  context.fillStyle = sounding ? '#1b1105' : '#2b1d0c';
  context.fillRect(centerX - widthPx * 0.3, y - 2.5, widthPx * 0.6, 5);
}

/** The readout above each pipe: what it is, and what it is made of. */
function drawPipeLabel(context, centerX, topY, pipe, sounding) {
  const frequency = pipe.frequencyHz(app.organ.temperatureC);
  const base = Math.max(11, Math.min(15, LAYOUT.width / 85));
  const label = noteName(frequency, app.organ.referenceHz);
  const detail = `${Math.round(pipe.lengthM * 100)} cm \u00b7 \u00d8${Math.round(pipe.radiusM * 2 * 1000)} mm \u00b7 r${pipe.register}`;

  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  const labelY = Math.max(base + 2, topY - 6);

  context.font = `700 ${base}px "Stem Sans", system-ui, sans-serif`;
  context.fillStyle = sounding ? '#f2fbff' : '#c3d5e8';
  context.fillText(label, centerX, labelY);

  context.font = `400 ${Math.max(10, base - 2.5)}px "Stem Sans", system-ui, sans-serif`;
  context.fillStyle = '#8ba3c0';
  context.fillText(detail, centerX, Math.max(12, labelY - base - 1));
}

/**
 * The invitation to cut a pipe, drawn where the gesture happens.
 *
 * It appears only when the rack is empty, so it teaches the one gesture that
 * cannot be discovered by touching an existing pipe and then gets out of the way.
 */
function drawCutHint(context) {
  const { width, blockY } = LAYOUT;
  const alpha = app.reducedMotion ? 0.8 : 0.55 + 0.25 * Math.sin(app.frame * 0.05);
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = '#7fd6c1';
  context.lineWidth = 2;
  context.setLineDash([7, 7]);
  const x = Math.round(width / 2);
  const top = blockY - Math.min(170, blockY - 40);
  context.beginPath();
  context.moveTo(x, blockY - 8);
  context.lineTo(x, top);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(x - 8, top + 12);
  context.lineTo(x, top - 3);
  context.lineTo(x + 8, top + 12);
  context.stroke();
  context.fillStyle = '#d6f2ea';
  context.font = `600 ${Math.max(13, Math.min(17, width / 60))}px "Stem Sans", system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.fillText('drag up from the block to cut a pipe', x, top - 12);
  context.restore();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Seed the bench with three pipes.
 *
 * The rough lengths snap to C3, G3 and C4: a stopped pipe's fundamental, its
 * twelfth, and an octave. The opening screen therefore demonstrates the model
 * rather than showing three arbitrary pitches, and the twelfth is the interval a
 * beginner would not expect an organ to make.
 */
function seedRack() {
  app.organ.pipes = [];
  addPipe(0.65, 0.012);
  addPipe(0.427, 0.018);
  addPipe(0.3226, 0.009);
  app.lastTap = { pipe: null, at: 0 };
}

/**
 * The status line. Kept in one place so what the app says is derived from state
 * rather than scattered across the handlers, which is how a status line ends up
 * describing something the app no longer does.
 */
function syncControls() {
  const temperature = document.querySelector('#temperature');
  const temperatureValue = document.querySelector('#temperature-value');
  if (temperature) temperature.value = String(app.organ.temperatureC);
  if (temperatureValue) temperatureValue.textContent = `${app.organ.temperatureC.toFixed(0)} \u00b0C`;
  const snapped = document.querySelector('#snap');
  if (snapped) snapped.checked = app.organ.snapped;
  const status = document.querySelector('#status');
  if (status) status.textContent = app.message;

  const audioNote = document.querySelector('#audio-note');
  if (audioNote) {
    const state = app.audio.state;
    if (state === 'unavailable') {
      audioNote.textContent = 'This browser is not giving the page an audio output, so the picture and the ' +
        'numbers carry everything. The pitches shown are still the real ones.';
    } else if (state === 'not-started' || state === 'suspended') {
      audioNote.textContent = 'Sound starts the moment you first touch the bench.';
    } else if (app.audio.refused) {
      // The polyphony budget is real, so say when it bites: otherwise a note
      // that silently does not sound looks like a fault in the instrument.
      audioNote.textContent = `That was the ${app.audio.voices.size + 1}th pipe at once, past ` +
        'the six voices this instrument keeps clean. Let one finish first.';
    } else {
      audioNote.textContent = '';
    }
  }
}

/** Match the drawing buffer to the element, so lines are crisp on phones. */
function resize() {
  const canvas = app.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(220, Math.floor(rect.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  app.context = context;
  computeLayout(width, height);
}

function canvasPoint(event) {
  const rect = app.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function bindCanvas() {
  const canvas = app.canvas;
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    // Any press counts as the gesture Web Audio requires, so the first note
    // sounds on the same touch that plays it.
    app.audio.start();
    const point = canvasPoint(event);
    pointerDown(event.pointerId, point.x, point.y, event.timeStamp);
  });
  canvas.addEventListener('pointermove', (event) => {
    const point = canvasPoint(event);
    pointerMove(event.pointerId, point.x, point.y);
  });
  const end = (event) => pointerUp(event.pointerId);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // Keyboard: the first pipe answers space, so the instrument is reachable
  // without a pointer at all.
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    app.audio.start();
    const pipe = app.organ.pipes[0];
    if (!pipe) return;
    app.sounding.add(pipe);
    announceBlow(pipe);
    window.setTimeout(() => app.sounding.delete(pipe), 700);
  });
}

function bindControls() {
  document.querySelector('#temperature')?.addEventListener('input', (event) => {
    app.organ.temperatureC = Number(event.target.value);
    announceTemperature();
    syncControls();
  });
  document.querySelector('#snap')?.addEventListener('change', (event) => {
    app.organ.snapped = event.target.checked;
    app.message = app.organ.snapped
      ? 'Tune-lock on: new pipes snap to the nearest semitone, so they stay in key.'
      : 'Tune-lock off: pipes sit exactly where you cut them. Cut two close together and blow both ' +
        '\u2014 you will hear the beat, which is the difference between them.';
    syncControls();
  });
  document.querySelector('#reset')?.addEventListener('click', () => {
    app.audio.allOff();
    seedRack();
    app.message = 'Fresh rack: C3, G3, C4 \u2014 a stopped pipe\u2019s fundamental, its twelfth, and an octave.';
    syncControls();
  });
  const panel = document.querySelector('#onboarding');
  document.querySelector('#help-toggle')?.addEventListener('click', () => {
    if (!panel) return;
    const wasHidden = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !wasHidden);
  });
  document.querySelector('#onboarding-close')?.addEventListener('click', () => {
    panel?.setAttribute('hidden', '');
  });
}

/**
 * Make the audio match the set of pipes being blown.
 *
 * Ids are the pipe's index, which is stable enough for a voice (a pipe that moves
 * in the rack is re-noted from scratch on the next frame), and the loop also
 * releases voices whose pipe has been deleted, so removing a pipe mid-note does
 * not leave a drone behind.
 */
function serviceVoices() {
  if (app.audio.state !== 'running') return;
  const live = new Set();
  for (const pipe of app.sounding) {
    const index = app.organ.pipes.indexOf(pipe);
    if (index < 0) continue;
    live.add(index);
    app.audio.noteOn(index, pipe, app.organ);
  }
  for (const id of [...app.audio.voices.keys()]) {
    if (!live.has(id)) app.audio.noteOff(id);
  }
}

function render() {
  serviceVoices();
  // Keep the row fitted: adding or deleting a pipe changes how much width the
  // rack needs, and the layout only recomputes itself on resize otherwise.
  LAYOUT.firstPipeX = Math.max(LAYOUT.rowMarginPx, (LAYOUT.width - rackWidthPx()) / 2);
  if (app.context) drawScene(app.context);
  syncControls();
}

function frame() {
  if (!app.paused) {
    app.frame += 1;
    render();
  }
  window.requestAnimationFrame(frame);
}

/**
 * The one documented way a browser test reaches the app.
 *
 * The artifact ships no module system and no other globals, so a test needs an
 * explicit place to stand. It exposes the *live* objects rather than copies: a
 * test reading `organ.pipes` reads the same Pipe instances the renderer and the
 * audio engine read, which is what makes a behavioural assertion mean something.
 */
function exposeTestApi() {
  window.__stem = {
    view: app,
    organ: app.organ,
    audio: app.audio,
    layout: LAYOUT,
    stepFrames(count) {
      for (let i = 0; i < count; i += 1) {
        app.frame += 1;
        render();
      }
      return app.frame;
    },
    /**
     * Named points on the bench, resolved with the same geometry the hit test
     * uses, so a scripted gesture points at the same thing on a 1280 px desktop
     * and a 390 px phone.
     */
    anchors() {
      const rect = app.canvas.getBoundingClientRect();
      const toClient = (x, y) => ({ x: Math.round(rect.left + x), y: Math.round(rect.top + y) });
      const pipes = app.organ.pipes.map((pipe, index) => {
        const centerX = pipeCenterX(index);
        const heightPx = pipeHeightPx(pipe);
        return {
          centerX: Math.round(centerX),
          widthPx: Math.round(pipeWidthPx(pipe)),
          topY: Math.round(LAYOUT.blockY - heightPx),
          middle: toClient(centerX, LAYOUT.blockY - heightPx / 2),
          mouth: toClient(centerX, mouthY(pipe)),
          frequency: pipe.frequencyHz(app.organ.temperatureC),
          lengthCm: Math.round(pipe.lengthM * 100),
          register: pipe.register,
          footprint: pipe.footprint,
        };
      });
      // A spot on the block with no pipe under it, found the way the hit test
      // would find it: a "blank" corner that is actually over a pipe starts a
      // blow rather than a cut, and the scene silently tests the wrong verb.
      let empty = null;
      for (let fraction = 0.1; fraction <= 0.95; fraction += 0.02) {
        const x = Math.round(LAYOUT.width * fraction);
        const y = Math.round(LAYOUT.blockY - 10);
        if (hitTest(x, y).kind === 'none') {
          empty = toClient(x, y);
          break;
        }
      }
      return {
        pipes,
        empty,
        blockY: Math.round(LAYOUT.blockY),
        width: LAYOUT.width,
        height: LAYOUT.height,
      };
    },
  };
}

function main() {
  app.canvas = document.querySelector('#bench');
  app.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  // Paused at startup, before the first frame, so a test's first captured frame
  // is already deterministic rather than whatever the wall clock reached.
  app.paused = new URLSearchParams(window.location.search).has('paused');
  seedRack();
  resize();
  bindCanvas();
  bindControls();
  exposeTestApi();
  announceBlow(app.organ.pipes[0]);
  window.addEventListener('resize', resize);
  document.documentElement.dataset.stemReady = '1';
  window.requestAnimationFrame(frame);
}

main();
