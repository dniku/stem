#!/usr/bin/env node
/**
 * Assert the built artifact is self-contained and syntactically valid.
 *
 * The whole distribution promise is one file that opens with no network, no
 * sibling files, and no storage. Each of those has a concrete way to break
 * silently — a stray <script src>, a <link rel=stylesheet>, an image reference,
 * an inline module that cannot run on file:// — so each is named here rather
 * than left to present as a blank page.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'index.html');
const html = readFileSync(path, 'utf8');
const problems = [];

if (html.length < 1000) problems.push(`artifact is suspiciously small (${html.length} bytes)`);

// Any external reference breaks offline/sandboxed use. Only bare in-page
// fragments (#anchor) and inline data: URIs may look like a reference.
const external = [...html.matchAll(/<(script|link|img|source|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((match) => match[2])
  .filter((value) => !value.startsWith('#') && !value.startsWith('data:'));
if (external.length > 0) {
  problems.push(`references ${external.length} external resource(s): ${external.join(', ')}`);
}

// Module scripts are refused from file:// and from an opaque-origin iframe.
if (/<script[^>]+type=["']module["']/i.test(html)) {
  problems.push('contains a type="module" script, which will not run from file:// or an opaque origin');
}

// Browser storage is not available in a sandboxed preview iframe, so depending
// on it would make the app work in a tab and fail in the preview.
for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
  if (html.includes(api)) problems.push(`uses ${api}, which is unavailable in a sandboxed opaque-origin iframe`);
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
if (scripts.length === 0) problems.push('no inline script found');
for (const [index, body] of scripts.entries()) {
  try {
    new vm.Script(body, { filename: `inline-script-${index}` });
  } catch (error) {
    problems.push(`inline script ${index} does not parse: ${error.message}`);
  }
}

if (html.includes('__STEM_JS__') || html.includes('__STEM_CSS__') || html.includes('__FONT_FACE__')) {
  problems.push('a build placeholder survived into the artifact');
}

/*
 * The embedded font faces.
 *
 * The artifact declares its own fonts because golden screenshots contain painted
 * text, and `system-ui` resolves to whatever the host provides. This container
 * ships one font, CI ships another, so an embedded face is both the offline
 * promise and the only way a baseline means the same pixels twice.
 *   - Two faces: with one, each engine synthesises its own bold.
 *   - Data URI, not URL: a fetched font is an external dependency.
 *   - wOF2 magic: base64 that decodes to something else is a build error, not a
 *     page that silently renders in a fallback face.
 */
const faces = [...html.matchAll(/@font-face\s*\{[^}]*\}/g)].map((match) => match[0]);
if (faces.length !== 2) {
  problems.push(`expected 2 @font-face rules for the embedded faces, found ${faces.length}`);
}
for (const [index, rule] of faces.entries()) {
  const dataUri = rule.match(/url\(data:font\/woff2;base64,([A-Za-z0-9+/]+={0,2})\)/);
  if (!dataUri) {
    problems.push(`@font-face ${index} has no inline data:font/woff2;base64 source`);
    continue;
  }
  const magic = Buffer.from(dataUri[1], 'base64').subarray(0, 4).toString('latin1');
  if (magic !== 'wOF2') {
    problems.push(`@font-face ${index} decodes to ${JSON.stringify(magic)}, not a WOFF2 signature`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`artifact check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`artifact OK (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, self-contained)\n`);
