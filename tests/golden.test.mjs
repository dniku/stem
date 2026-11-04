#!/usr/bin/env node
/**
 * Golden screenshot tests.
 *
 * Each case is a state a real player would see, reached by real gestures, and
 * rendered deterministically (the page is paused at startup and advanced by
 * frame count, and the context runs with reduced motion). A golden is accepted
 * only by a human looking at it, so --update writes candidates and this script
 * never silently replaces a baseline it disagrees with.
 *
 * Baselines live per engine (tests/golden/<engine>/<name>.png) and there is no
 * cross-engine fallback: engines disagree about sub-pixel text layout, so
 * comparing Firefox pixels against Chromium pixels reports a difference that
 * means nothing.
 *
 *   node tests/golden.test.mjs --engine firefox
 *   node tests/golden.test.mjs --engine firefox --update
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { loadPlaywright, openScene, closeSharedBrowser, dragBench, touchAndHold, stepFrames, SCENES, DEFAULT_ENGINE } from '../tools/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = pathToFileURL(resolve(ROOT, 'index.html')).href;
const DIFF_DIR = join(ROOT, '.tmp', 'golden-actual');

/**
 * Fraction of pixels allowed to differ before a case fails.
 *
 * Small because every scene is deterministic; nonzero because text
 * antialiasing is not byte-exact across driver revisions.
 */
const TOLERANCE_RATIO = 0.0025;

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');

function engineFromArgv(list) {
  const index = list.indexOf('--engine');
  if (index < 0) return DEFAULT_ENGINE;
  const value = list[index + 1];
  if (!['firefox', 'chromium', 'webkit'].includes(value)) {
    throw new Error(`--engine expects firefox, chromium or webkit, got "${value ?? ''}"`);
  }
  return value;
}
const ENGINE = engineFromArgv(argv);

/**
 * Cases under test.
 *
 * `dismissOnboarding: false` keeps the help sheet up, so the first-run
 * experience is itself under test and cannot regress into an empty panel or a
 * wall of text that covers the bench.
 */
const CASES = [
  {
    name: 'first-run',
    description: 'what a visitor sees first: the bench plus the explanation',
    scene: 'desktop',
    dismissOnboarding: false,
    frames: 2,
    expect: (state) => state.pipes >= 3,
  },
  {
    name: 'bench-seeded',
    description: 'three pipes, nothing sounding: the standing waves are visible',
    scene: 'desktop',
    frames: 2,
    expect: (state) => state.pipes === 3,
  },
  {
    name: 'blowing',
    description: 'one pipe held: glow, brighter wave, and the status naming the pitch',
    scene: 'desktop',
    holdFirstPipe: true,
    frames: 2,
    expect: (state) => state.sounding === 1,
  },
  {
    name: 'after-cut',
    description: 'a pipe just cut by dragging up from the block',
    scene: 'desktop',
    cut: { fromAnchor: 'empty', heightPx: 240 },
    frames: 2,
    expect: (state) => state.pipes === 4,
  },
  {
    name: 'overblown',
    description: 'register 2: the standing wave has an extra node',
    scene: 'desktop',
    overblowFirstPipe: true,
    frames: 2,
    expect: (state) => state.firstRegister === 2,
  },
  {
    name: 'phone-portrait-first-run',
    description: 'a phone in portrait, help sheet up over the bench',
    scene: 'phone-portrait',
    dismissOnboarding: false,
    frames: 2,
    expect: (state) => state.pipes >= 3,
  },
  {
    name: 'phone-portrait',
    description: 'a phone in portrait, unobstructed bench',
    scene: 'phone-portrait',
    frames: 2,
    expect: (state) => state.pipes === 3,
  },
  {
    name: 'phone-landscape',
    description: 'a phone on its side: the bench keeps the room',
    scene: 'phone-landscape',
    frames: 2,
    expect: (state) => state.pipes === 3,
  },
];

/** Minimal PNG reader: decode IHDR/IDAT to RGBA so engines can be compared fairly. */
function decodePng(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // Un-filter scanlines: PNG filters each row against the previous one.
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * stride;
    const sourceStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[sourceStart + x];
      const left = x >= channels ? out[lineStart + x - channels] : 0;
      const up = y > 0 ? out[lineStart - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[lineStart - stride + x - channels] : 0;
      let result = value;
      if (filter === 1) result = value + left;
      else if (filter === 2) result = value + up;
      else if (filter === 3) result = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`unsupported filter ${filter}`);
      }
      out[lineStart + x] = result & 0xff;
    }
  }
  // Normalise every colour type to RGBA so an RGB capture and an RGBA capture
  // of the same image compare equal.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    if (channels === 4) {
      rgba[i * 4] = out[i * 4];
      rgba[i * 4 + 1] = out[i * 4 + 1];
      rgba[i * 4 + 2] = out[i * 4 + 2];
      rgba[i * 4 + 3] = out[i * 4 + 3];
    } else if (channels === 3) {
      rgba[i * 4] = out[i * 3];
      rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (channels === 2) {
      rgba[i * 4] = out[i * 2];
      rgba[i * 4 + 1] = out[i * 2];
      rgba[i * 4 + 2] = out[i * 2];
      rgba[i * 4 + 3] = out[i * 2 + 1];
    } else {
      rgba[i * 4] = out[i];
      rgba[i * 4 + 1] = out[i];
      rgba[i * 4 + 2] = out[i];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Fraction of pixels that differ at all.
 *
 * A pixel counts as different if any channel differs by any amount: the scenes
 * are deterministic, so the interesting quantity is "did anything move", and a
 * threshold on channel delta would only decide how much slop to hide.
 */
function differenceRatio(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  for (let pixel = 0; pixel < a.rgba.length / 4; pixel += 1) {
    const base = pixel * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      if (a.rgba[base + channel] !== b.rgba[base + channel]) {
        differing += 1;
        break;
      }
    }
  }
  return differing / (a.width * a.height);
}

async function captureCase(engines, testCase) {
  const scene = SCENES.find((candidate) => candidate.name === testCase.scene);
  if (!scene) throw new Error(`unknown scene ${testCase.scene}`);
  const { page, problems, close } = await openScene(engines, ENGINE, scene, ARTIFACT, {
    dismissOnboarding: testCase.dismissOnboarding !== false,
  });
  try {
    const anchors = await page.evaluate(() => window.__stem.anchors());
    if (testCase.cut) {
      const from = anchors.empty ?? anchors.block;
      await dragBench(page, from, { x: from.x, y: from.y - testCase.cut.heightPx }, 10);
    }
    if (testCase.overblowFirstPipe) {
      const pipe = anchors.pipes[0];
      await dragBench(page, pipe.middle, { x: pipe.centerX, y: pipe.middle.y - 140 }, 10);
    }
    if (testCase.holdFirstPipe) await touchAndHold(page, anchors.pipes[0].middle);
    await stepFrames(page, testCase.frames);
    const state = await page.evaluate(() => ({
      pipes: window.__stem.organ.pipes.length,
      sounding: window.__stem.view.sounding.size,
      firstRegister: window.__stem.organ.pipes[0].register,
      status: document.querySelector('#status').textContent,
    }));
    const image = await page.screenshot({ type: 'png' });
    return { image, state, problems };
  } finally {
    // Releases the context only; the browser is shared and closed at the end.
    await close();
  }
}

async function main() {
  mkdirSync(DIFF_DIR, { recursive: true });
  const engines = await loadPlaywright();
  const failures = [];
  const written = [];

  for (const testCase of CASES) {
    const goldenPath = join(ROOT, 'tests', 'golden', ENGINE, `${testCase.name}.png`);
    const { image, state, problems } = await captureCase(engines, testCase);
    const label = `${testCase.name} (${testCase.scene})`;

    if (problems.length > 0) failures.push(`${label}: page reported ${problems.join('; ')}`);
    if (!testCase.expect(state)) {
      failures.push(`${label}: state assertion failed: ${JSON.stringify(state)}`);
    }

    if (UPDATE || !existsSync(goldenPath)) {
      if (UPDATE) {
        mkdirSync(dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, image);
        written.push(goldenPath);
      } else {
        failures.push(`${label}: no baseline at ${goldenPath} (run --update to create it)`);
      }
      continue;
    }
    const expected = decodePng(readFileSync(goldenPath));
    const actual = decodePng(image);
    const ratio = differenceRatio(expected, actual);
    const hash = createHash('sha256').update(image).digest('hex').slice(0, 12);
    writeFileSync(join(DIFF_DIR, `${testCase.name}-actual.png`), image);
    if (ratio > TOLERANCE_RATIO) {
      failures.push(`${label}: ${(ratio * 100).toFixed(3)}% of pixels differ (actual ${hash})`);
    } else {
      process.stdout.write(`ok  ${label}  identical-to-baseline=${ratio === 0} hash=${hash}\n`);
    }
  }

  await closeSharedBrowser();

  if (written.length > 0) {
    process.stdout.write(`\nWrote ${written.length} baseline(s). View every one before accepting:\n`);
    for (const path of written) process.stdout.write(`  ${path}\n`);
  }
  if (failures.length > 0) {
    process.stderr.write(`\nGOLDEN FAILURES (${failures.length}):\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${CASES.length} golden cases passed on ${ENGINE}.\n`);
}

main().catch((error) => {
  process.stderr.write(`golden suite errored: ${error?.stack ?? error}\n`);
  process.exit(1);
});
