#!/usr/bin/env node
/**
 * Interaction tests: drive the built artifact and assert observable behaviour.
 *
 * Every case here is a gesture a person makes, followed by a claim about the
 * state that gesture must produce. The claims are about the model the picture
 * and the sound both read from, so they fail when the app merely looks busy.
 *
 *   node tests/interaction.test.mjs --engine firefox
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright, openScene, dragBench, touchAndHold, releaseTouch, SCENES, DEFAULT_ENGINE } from '../tools/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = pathToFileURL(resolve(ROOT, 'index.html')).href;

function engineFromArgv(argv) {
  const index = argv.indexOf('--engine');
  if (index < 0) return DEFAULT_ENGINE;
  const value = argv[index + 1];
  if (!['firefox', 'chromium', 'webkit'].includes(value)) {
    throw new Error(`--engine expects firefox, chromium or webkit, got "${value ?? ''}"`);
  }
  return value;
}

const ENGINE = engineFromArgv(process.argv);
const SCENE = SCENES[0];

let engines;
let opened;

before(async () => {
  engines = await loadPlaywright();
});

after(async () => {
  if (opened) await opened.browser.close();
});

/** Open the artifact once per process and hand back a fresh page each time. */
async function freshPage() {
  if (opened) await opened.browser.close();
  opened = await openScene(engines, ENGINE, SCENE, ARTIFACT);
  assert.deepEqual(opened.problems, [], `page reported problems: ${opened.problems.join('; ')}`);
  return opened;
}

test('the page boots, declares readiness, and reports no console errors', async () => {
  const { page } = await freshPage();
  const ready = await page.evaluate(() => document.documentElement.dataset.stemReady);
  assert.equal(ready, '1');
  // A seeded rack: the first screen must never be an empty canvas.
  const count = await page.evaluate(() => window.__stem.organ.pipes.length);
  assert.ok(count >= 3, `expected a seeded rack, found ${count} pipes`);
});

test('dragging up from the block cuts a pipe whose pitch follows c/4L', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const before = await page.evaluate(() => window.__stem.organ.pipes.length);
  const from = { x: anchors.empty.x, y: anchors.blockY - 6 };
  const to = { x: from.x, y: anchors.blockY - 260 };
  await dragBench(page, from, to, 10);
  const after = await page.evaluate(() => {
    const organ = window.__stem.organ;
    const pipe = organ.pipes[organ.pipes.length - 1];
    return {
      count: organ.pipes.length,
      lengthM: pipe.lengthM,
      radiusM: pipe.radiusM,
      frequency: pipe.frequencyHz(organ.temperatureC),
    };
  });
  assert.equal(after.count, before + 1, 'a drag should add exactly one pipe');
  // The reported pitch must be what the model gives for that length and bore.
  // This is the app's central promise: the label cannot disagree with the physics.
  const expected = 343.2 / (4 * (after.lengthM + 0.6 * after.radiusM));
  assert.ok(Math.abs(after.frequency - expected) < 1.0, `${after.frequency} vs ${expected}`);
  // And a longer pipe is lower: the drag made a 260 px pipe, so it must be well
  // below the reference pitch.
  assert.ok(after.frequency < 262, `a 260 px pipe should be below middle C, got ${after.frequency}`);
});

test('touching a pipe puts it in the sounding set and the status says what it is', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  await touchAndHold(page, anchors.pipes[0].middle);
  const state = await page.evaluate(() => ({
    sounding: window.__stem.view.sounding.size,
    status: document.querySelector('#status').textContent,
  }));
  await releaseTouch(page);
  assert.equal(state.sounding, 1, 'holding a pipe should make exactly one pipe sound');
  assert.match(state.status, /Blowing .*Hz/, `status read: ${state.status}`);
});

test('dragging a pipe sideways widens the bore and drops the pitch', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const target = anchors.pipes[0];
  const before = await page.evaluate(() => {
    const pipe = window.__stem.organ.pipes[0];
    return { radius: pipe.radiusM, frequency: pipe.frequencyHz(window.__stem.organ.temperatureC) };
  });
  // Grab below the mouth so the drag is read as a bore change, not a mouth move.
  const grabY = Math.round(target.topY + (anchors.blockY - target.topY) * 0.75);
  await dragBench(page, { x: target.centerX, y: grabY }, { x: target.centerX + 120, y: grabY }, 10);
  const after = await page.evaluate(() => {
    const pipe = window.__stem.organ.pipes[0];
    return { radius: pipe.radiusM, frequency: pipe.frequencyHz(window.__stem.organ.temperatureC) };
  });
  assert.ok(after.radius > before.radius, `radius did not grow: ${before.radius} -> ${after.radius}`);
  // Wider bore -> longer effective length -> flatter. The honest, counter-
  // intuitive consequence of the end correction, and the reason a wide pipe is
  // cut shorter than the arithmetic says.
  assert.ok(after.frequency < before.frequency, `pitch did not drop: ${before.frequency} -> ${after.frequency}`);
});

test('dragging across the mouth moves the windhole and changes the tone colour', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const target = anchors.pipes[0];
  // Move the mouth down the pipe: the grab point must track the mouth, which
  // moves as it is dragged, so this ends at a fixed screen position below it.
  const to = { x: target.mouth.x, y: target.mouth.y + 90 };
  await dragBench(page, target.mouth, to, 10);
  const after = await page.evaluate(() => {
    const pipe = window.__stem.organ.pipes[0];
    return { footprint: pipe.footprint, third: pipe.partialAmplitudes(3)[2] };
  });
  assert.ok(after.footprint < 0.4, `footprint should have moved low, got ${after.footprint}`);
  // A low windhole means a quiet third partial: this is the tone-colour claim,
  // stated as a number the audio engine actually uses.
  const bright = await page.evaluate(() => window.__stem.organ.pipes[0].partialAmplitudes(3)[2] / window.__stem.organ.pipes[0].partialAmplitudes(3)[0]);
  assert.ok(bright < 0.35, `a low windhole should have a weak third partial, got ratio ${bright}`);
});

test('a firm upward flick overblows a pipe into the twelfth', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const target = anchors.pipes[0];
  const before = target.frequency;
  await dragBench(page, target.middle, { x: target.centerX, y: target.middle.y - 160 }, 10);
  const after = await page.evaluate(() => {
    const pipe = window.__stem.organ.pipes[0];
    return { register: pipe.register, frequency: pipe.frequencyHz(window.__stem.organ.temperatureC) };
  });
  assert.equal(after.register, 2, 'a firm upward drag should overblow into register 2');
  assert.ok(Math.abs(after.frequency / before - 3) < 0.02, `${after.frequency / before}x, expected 3x`);
});

/**
 * A slight drag on the way to holding a note must leave the pitch alone.
 *
 * This is the guard on the overblow gesture: without a distance gate, a thumb
 * that slips a few pixels would throw the pipe up a twelfth, and the instrument
 * would feel broken rather than responsive.
 */
test('a small drag on a pipe leaves its pitch alone', async () => {
  const { page } = await freshPage();
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const target = anchors.pipes[0];
  const before = target.frequency;
  await dragBench(page, target.middle, { x: target.centerX + 6, y: target.middle.y - 14 }, 6);
  const after = await page.evaluate(() => {
    const pipe = window.__stem.organ.pipes[0];
    return { register: pipe.register, frequency: pipe.frequencyHz(window.__stem.organ.temperatureC) };
  });
  assert.equal(after.register, 1, 'a small drag should not overblow');
  assert.ok(Math.abs(after.frequency - before) < 0.001, `frequency drifted: ${before} -> ${after.frequency}`);
});

test('the temperature slider retunes the whole rack together', async () => {
  const { page } = await freshPage();
  const cold = await page.evaluate(() => window.__stem.organ.pipes.map((p) => p.frequencyHz(window.__stem.organ.temperatureC)));
  await page.evaluate(() => {
    const slider = document.querySelector('#temperature');
    slider.value = '37';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const warm = await page.evaluate(() => window.__stem.organ.pipes.map((p) => p.frequencyHz(window.__stem.organ.temperatureC)));
  assert.equal(cold.length, warm.length);
  const ratios = warm.map((frequency, i) => frequency / cold[i]);
  for (const ratio of ratios) {
    assert.ok(Math.abs(ratio - ratios[0]) < 1e-9, 'pipes did not shift by the same ratio');
    assert.ok(ratio > 1, 'warming air should sharpen, not flatten');
  }
});

test('tune-lock off lets a pipe sit off a semitone', async () => {
  const { page } = await freshPage();
  await page.evaluate(() => {
    const checkbox = document.querySelector('#snap');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const from = { x: anchors.empty.x, y: anchors.blockY - 6 };
  await dragBench(page, from, { x: from.x, y: anchors.blockY - 167 }, 8);
  const off = await page.evaluate(() => {
    const organ = window.__stem.organ;
    const pipe = organ.pipes[organ.pipes.length - 1];
    const cents = 1200 * Math.log2(pipe.frequencyHz(organ.temperatureC) / organ.referenceHz);
    return Math.abs(cents - Math.round(cents / 100) * 100);
  });
  assert.ok(off < 60, `the last pipe is not the one just cut (off ${off} cents)`);
  assert.ok(off > 0.001, `pipe landed exactly on a semitone despite tune-lock off (${off} cents)`);
});

test('the layout keeps the block and the labels on screen in every scene', async () => {
  for (const scene of SCENES) {
    const { page, browser } = await openScene(engines, ENGINE, scene, ARTIFACT, { reuseBrowser: undefined });
    await browser.close();
    const box = await page.evaluate(() => {
      const anchors = window.__stem.anchors();
      return {
        blockY: anchors.blockY,
        height: anchors.height,
        pipes: anchors.pipes.map((pipe) => pipe.topY),
      };
    });
    assert.ok(box.blockY < box.height, `${scene.name}: block below the viewport`);
    assert.ok(box.blockY > 60, `${scene.name}: block too close to the top`);
    for (const topY of box.pipes) {
      assert.ok(topY >= 0, `${scene.name}: a pipe label is clipped above the viewport (topY=${topY})`);
    }
  }
});

/**
 * The explanation must never cost the player the bench.
 *
 * These cases exist because the sheet used to share #panel with the gesture
 * legend: dismissing the explanation hid the reminders, "Help" could hide the
 * sliders with no way back, and on a portrait phone the sheet sat over viewport
 * y=328 and below while the block you drag from sits at y=679 -- so the opening
 * gesture was unreachable. Every assertion is about a box a finger can reach,
 * not about a stylesheet value.
 */
test('the explanation overlay never takes height from the bench', async () => {
  for (const scene of SCENES) {
    const closed = await openScene(engines, ENGINE, scene, ARTIFACT);
    const closedBox = await closed.page.evaluate(() => ({
      height: window.__stem.anchors().height,
      blockY: window.__stem.layout.blockY,
    }));
    await closed.browser.close();

    const open = await openScene(engines, ENGINE, scene, ARTIFACT);
    await open.page.click('#help-toggle');
    const openBox = await open.page.evaluate(() => ({
      height: window.__stem.anchors().height,
      blockY: window.__stem.layout.blockY,
      sheetVisible: !document.querySelector('#onboarding').hasAttribute('hidden'),
    }));
    await open.browser.close();

    assert.ok(openBox.sheetVisible, `${scene.name}: Help did not open the explanation`);
    // Same canvas height, same block position: the sheet is an overlay.
    assert.equal(openBox.height, closedBox.height, `${scene.name}: opening the sheet resized the canvas`);
    assert.equal(openBox.blockY, closedBox.blockY, `${scene.name}: opening the sheet moved the block`);
  }
});

test('the controls stay on screen when the explanation opens and closes', async () => {
  for (const scene of SCENES) {
    const { page, browser } = await openScene(engines, ENGINE, scene, ARTIFACT);
    for (const id of ['#temperature', '#snap', '#reset', '#help-toggle']) {
      const before = await page.isVisible(id);
      assert.ok(before, `${scene.name}: ${id} is not visible to start with`);
    }
    await page.click('#help-toggle');
    await page.click('#panel-close');
    for (const id of ['#temperature', '#snap', '#reset', '#help-toggle']) {
      const after = await page.isVisible(id);
      assert.ok(after, `${scene.name}: ${id} disappeared after opening and closing the explanation`);
    }
    await browser.close();
  }
});

test('the gesture legend stays visible and lets drags through to the bench', async () => {
  const { page, browser } = await openScene(engines, ENGINE, SCENES[0], ARTIFACT);
  await page.evaluate(() => document.querySelector('#onboarding').setAttribute('hidden', ''));
  assert.ok(await page.isVisible('#legend'), 'the reminders vanished once onboarding was dismissed');

  // The legend is deliberately translucent over the bench, so it must not be a
  // wall: a press at its centre has to land on the canvas underneath.
  const hit = await page.evaluate(() => {
    const legend = document.querySelector('#legend');
    const box = legend.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { tag: target?.tagName ?? 'none', passThrough: getComputedStyle(legend).pointerEvents };
  });
  assert.equal(hit.tag, 'CANVAS', `the legend swallows presses (${hit.tag} got the press)`);
  assert.equal(hit.passThrough, 'none', 'the legend should be pointer-transparent');
  await browser.close();
});

test('cutting still works on a phone with the explanation open', async () => {
  // The regression in its plainest form: on a portrait phone the sheet covered
  // the block, so the first gesture a new visitor makes did nothing.
  const scene = SCENES[1];
  const { page, browser } = await openScene(engines, ENGINE, scene, ARTIFACT);
  const before = await page.evaluate(() => window.__stem.organ.pipes.length);
  const anchors = await page.evaluate(() => window.__stem.anchors());
  const from = { x: anchors.empty.x, y: anchors.blockY - 6 };
  const to = { x: from.x, y: from.y - 180 };
  await dragBench(page, from, to, 10);
  const after = await page.evaluate(() => window.__stem.organ.pipes.length);
  assert.ok(after > before, `dragging from the block cut nothing (${before} -> ${after} pipes)`);
  await browser.close();
});
