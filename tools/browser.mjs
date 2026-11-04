/**
 * browser.mjs — launching a browser for the checks, and saying so loudly when
 * one cannot start.
 *
 * Playwright is not vendored: it is resolved from PLAYWRIGHT_ENTRY, an absolute
 * path the Nix dev shell sets, because ESM ignores NODE_PATH. A missing variable
 * is an error rather than a skip. A suite that prints "passed" after painting
 * zero pages is worse than one that exits non-zero, because the red build
 * describes the code whereas the green one describes nothing at all.
 *
 * Firefox is the default engine: Chromium's headless shell needs syscalls its
 * sandbox helper is denied in this container, so it dies before it paints. Both
 * remain selectable, and one that cannot start fails with the reason rather than
 * silently testing a different engine.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV = ['PLAYWRIGHT_ENTRY', 'PLAYWRIGHT_BROWSERS_PATH'];

export const DEFAULT_ENGINE = 'firefox';

/** The three shapes the layout is designed and tested against. */
export const SCENES = [
  { name: 'desktop', width: 1280, height: 860, device: false },
  { name: 'phone-portrait', width: 390, height: 844, device: true },
  { name: 'phone-landscape', width: 844, height: 390, device: true },
];

export async function loadPlaywright() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `browser checks need ${missing.join(' and ')}; run inside the pinned shell:\n` +
        '  nix develop --command ./check.sh',
    );
  }
  const entry = process.env.PLAYWRIGHT_ENTRY;
  if (!existsSync(entry)) {
    throw new Error(`PLAYWRIGHT_ENTRY points at a file that does not exist: ${entry}`);
  }
  const loaded = await import(pathToFileURL(entry).href);
  const playwright = loaded.default && loaded.chromium === undefined ? loaded.default : loaded;
  return { chromium: playwright.chromium, firefox: playwright.firefox, webkit: playwright.webkit };
}

/** Collapse Playwright's wall of launch flags to the line that explains a failure. */
function launchFailureDetail(error) {
  const text = String(error?.message ?? error);
  const decisive = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('FATAL') || line.includes('Operation not permitted'));
  return decisive ? `: ${decisive}` : `: ${text.slice(0, 400)}`;
}

/**
 * Open the artifact at one scene's viewport and wait until the app declares
 * itself ready. `requestfailed` and `pageerror` are collected because a bundle
 * that half-works — canvas painted, one control throwing — looks fine in a
 * screenshot and is not fine.
 */
export async function openScene(engines, engineName, scene, url, options = {}) {
  const engine = engines[engineName];
  if (!engine) throw new Error(`this Playwright build does not expose "${engineName}"`);
  // A caller may pass its own browser; otherwise the process-wide pool is used.
  // `ownsBrowser` records which of the two is being used, because only a browser
  // this call launched may be closed by it.
  const ownsBrowser = options.browser === undefined;
  const browser = ownsBrowser
    ? await launchBrowser(engines, engineName)
    : options.browser;
  const closeOnFailure = () => {
    if (ownsBrowser) browser.close().catch(() => {});
  };
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: scene.device ? 2 : 1,
    isMobile: scene.device,
    hasTouch: true,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));

  // Pause at startup so the breathing hint and the wave phase are a fixed frame
  // count rather than whatever the wall clock reached. `paused=1` is honoured
  // inside main(), before the first frame is drawn.
  const pausedUrl = options.pause === false ? url : `${url}${url.includes('?') ? '&' : '?'}paused=1`;
  await page.goto(pausedUrl, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.stemReady === '1', { timeout: 20_000 });
  } catch (error) {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400)).catch(() => '');
    closeOnFailure();
    throw new Error(
      `app never became ready in ${engineName} at ${scene.name}. ` +
        `page errors: ${problems.join(' | ') || 'none reported'}. body text: ${text}`,
      { cause: error },
    );
  }
  // Drop the onboarding sheet so screenshots can show the unobstructed bench,
  // and let a caller keep it up by asking for it.
  if (options.dismissOnboarding !== false) {
    await page.evaluate(() => document.querySelector('#onboarding-close')?.click());
  }
  return {
    browser,
    context,
    page,
    problems,
    /**
     * Finish with this scene.
     *
     * This deliberately releases nothing: `context.close()` silently disconnects
     * the whole browser here and `browser.close()` costs 30 s, so both are
     * deferred to closeSharedBrowser() at the end of the run. It exists so call
     * sites read naturally and so the invariant is stated in one place.
     */
    async close() {},
  };
}

/*
 * How to drive a browser in this container, measured rather than assumed.
 *
 * Every number below is from Playwright 1.64.1 and Firefox 157 on this machine;
 * they are not general truths about Playwright and should be re-measured if the
 * toolchain moves.
 *
 *   browser.close()            30.0 s, for about:blank as much as for the app
 *   context.close()             0.0 s — and it takes the browser down with it
 *   newPage + goto + ready      0.4 s, repeated indefinitely on one context
 *   launch                      0.6 s
 *
 * So the only shape that is both correct and quick is: launch one browser, open
 * one context per scene, and *never* close a context or a browser mid-run.
 * Closing a context is free but fatal (it disconnects the browser), and closing a
 * browser is survivable but costs 30 s, so both happen once, at teardown.
 *
 * Isolation is not lost by keeping a context: every scene gets its own context
 * anyway (viewport, isMobile, hasTouch and locale differ), and each case loads a
 * fresh document. What is shared is the browser process, which holds no app state.
 */
let shared = null;

async function launchBrowser(engines, engineName) {
  if (shared && shared.name === engineName) return shared.browser;
  if (shared) await shared.browser.close().catch(() => {});
  const engine = engines[engineName];
  const args = engineName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [];
  let browser;
  try {
    browser = await engine.launch({ args });
  } catch (error) {
    throw new Error(`${engineName} could not start${launchFailureDetail(error)}`, { cause: error });
  }
  shared = { browser, name: engineName };
  return browser;
}

/** Close the pooled browser. Call once, from a test runner's teardown. */
export async function closeSharedBrowser() {
  if (!shared) return;
  const { browser } = shared;
  shared = null;
  await browser.close().catch(() => {});
}

/**
 * Perform one touch drag on the bench.
 *
 * Delivered as a synthetic PointerEvent sequence with pointerType 'touch' in
 * both engines: the app is touched on Android and moused on a desktop, and one
 * scripted gesture should exercise one code path in both. Firefox's touchscreen
 * API is unimplemented, so a test leaning on it would quietly test nothing.
 */
export async function dragBench(page, from, to, samples = 12) {
  await page.evaluate(
    async ({ from, to, samples }) => {
      const bench = document.querySelector('#bench');
      const init = (point) => ({
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      });
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      bench.dispatchEvent(new PointerEvent('pointerdown', init(from)));
      for (let i = 1; i <= samples; i += 1) {
        const t = i / samples;
        const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        bench.dispatchEvent(new PointerEvent('pointermove', init(point)));
        await nextFrame();
      }
      bench.dispatchEvent(new PointerEvent('pointerup', { ...init(to), buttons: 0 }));
    },
    { from, to, samples },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/** Tap and hold: the pointer stays down, so a note is sounding when captured. */
export async function touchAndHold(page, point) {
  await page.evaluate(({ point }) => {
    const bench = document.querySelector('#bench');
    const init = {
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    };
    bench.dispatchEvent(new PointerEvent('pointerdown', init));
    bench.dispatchEvent(new PointerEvent('pointermove', init));
  }, { point });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

export async function releaseTouch(page) {
  await page.evaluate(() => {
    const bench = document.querySelector('#bench');
    bench.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 9, pointerType: 'touch', isPrimary: true, buttons: 0, bubbles: true,
    }));
  });
}

/**
 * Drag with the browser's own input pipeline rather than synthetic events.
 *
 * Synthetic PointerEvents are convenient but they are not pointers: they have no
 * active pointer id, so `setPointerCapture` rejects them, and a page that ignores
 * that failure silently does nothing. Where a test's whole point is "a person
 * grabs this and drags", drive the real thing -- `page.mouse` produces trusted
 * events that go through hit testing, capture and hover state exactly as a touch
 * does. Use this for gestures whose correctness depends on which element the
 * press lands on; the synthetic helpers remain useful for bulk motion.
 */
export async function dragBenchWithMouse(page, from, to, samples = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/** Press and hold with real input, so a note is sounding when captured. */
export async function holdWithMouse(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/**
 * Advance the app deterministically: draw N frames with the clock taken over.
 *
 * Pausing first is what makes a captured frame meaningful — the page runs its
 * own requestAnimationFrame loop, so while that is live the number of frames
 * between here and a screenshot is whatever the wall clock allows.
 */
export async function stepFrames(page, count) {
  await page.evaluate(() => {
    window.__stem.view.paused = true;
  });
  await page.evaluate((n) => window.__stem.stepFrames(n), count);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
