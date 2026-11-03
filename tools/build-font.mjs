#!/usr/bin/env node
/**
 * Produce the font faces embedded in the artifact.
 *
 * Why the artifact owns its fonts: the sheet could ask for `system-ui`, which
 * lets the browser pick a face the project does not control. For a reader that
 * is correct behaviour; for a screenshot test it is fatal, and it also breaks
 * "one self-contained file that works offline". This container ships one font,
 * CI ships another, and a full-page golden would then fail on the runner and
 * pass here, for reasons that have nothing to do with the app.
 *
 * Why subsetted: the whole DejaVu Sans file is ~750 KiB and the page draws a few
 * hundred glyphs. Subset and compressed, one face costs ~8 KiB in the artifact.
 *
 * Glyph coverage is a contract, and it is enforced by the build
 * ----------------------------------------------------------------
 * A character missing from the subset falls back silently for that one glyph and
 * re-widens the line -- the exact failure embedding exists to prevent, and one
 * that would reappear only on a machine with different fonts. So rather than
 * trusting a hand-maintained list, COVERAGE below is *computed* from the source:
 * every non-ASCII character actually used in src/ must be in the subset, and this
 * script fails the build if it is not.
 *
 * Run tools/with-fonttools.sh, which supplies pyftsubset, a brotli module built
 * for the same interpreter, and the source fonts from the pinned nixpkgs. The
 * output is committed, so building and viewing the artifact needs neither.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');

/** Ordinary copy: the printable ASCII range. Control characters are excluded on
 *  purpose -- they have no glyph, and demanding one makes the coverage assertion
 *  below fail for a reason that has nothing to do with rendering. */
const BASE = Array.from({ length: 0x007e - 0x0020 + 1 }, (_, i) => String.fromCharCode(0x0020 + i));

/** Comment and markup forms stripped before scanning, so only painted text asks
 *  for a glyph. */
const COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g;
const COMMENT_LINE = /^\s*\/\/.*$/gm;
const TAG = /<[^>]*>/g;

/**
 * Every printable non-ASCII character the app can actually render.
 *
 * Derived from the files, not from a list someone has to remember, so a new
 * typographic character in the copy cannot ship as a missing glyph. Comments and
 * markup are stripped first: a dash in a code comment is never painted, and
 * letting it widen the subset would put bytes in the artifact for nothing.
 */
const SOURCE_FILES = ['src/app.js', 'src/acoustics.js', 'src/audio.js', 'src/page.html', 'src/styles.css'];

function charactersUsedInSource() {
  const used = new Set();
  for (const file of SOURCE_FILES) {
    let text = readFileSync(join(root, file), 'utf8');
    text = text.replace(COMMENT_BLOCK, '').replace(COMMENT_LINE, '');
    if (file.endsWith('.html')) text = text.replace(TAG, ' ');
    for (const character of text) {
      const code = character.codePointAt(0);
      // BASE already covers printable ASCII, so only the non-ASCII remainder is
      // collected here. U+00A0 and above, up to the punctuation the copy uses.
      if (code < 0x00a0 || code > 0x2fff) continue;
      used.add(character);
    }
  }
  return [...used].sort();
}

/** The subset spec: a codepoint range pyftsubset understands. */
function coverageSpec() {
  const characters = [...new Set([...BASE, ...charactersUsedInSource()])];
  return characters.map((character) => `U+${character.codePointAt(0).toString(16).padStart(4, '0')}`).join(',');
}

/**
 * Print the tab-separated codepoints a font's cmap covers.
 *
 * A tiny fonttools call rather than `pyftsubset --print-all-options`, whose
 * output format is a CLI detail this build would then depend on.
 */
const COVERAGE_QUERY = `
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
codes = set()
for table in font['cmap'].tables:
    codes.update(table.cmap.keys())
print('\\t'.join(str(code) for code in sorted(codes)))
`;

const FACES = [
  { out: 'StemSans-regular.woff2', source: 'DejaVuSans.ttf', weight: 400 },
  { out: 'StemSans-bold.woff2', source: 'DejaVuSans-Bold.ttf', weight: 700 },
];

mkdirSync(outDir, { recursive: true });
const coverage = coverageSpec();

for (const face of FACES) {
  const target = join(outDir, face.out);
  execFileSync('pyftsubset', [
    join(process.argv[2] ?? '.', face.source),
    `--unicodes=${coverage}`,
    '--layout-features=*',
    '--flavor=woff2',
    `--output-file=${target}`,
  ], { stdio: 'inherit' });

  // Assert coverage rather than hoping: read back the subset's cmap and require
  // every requested codepoint to be present. A subset that silently dropped a
  // character would render in a fallback face on a different machine, which is
  // the failure this whole file exists to prevent.
  const report = execFileSync('python3', ['-c', COVERAGE_QUERY, target], { encoding: 'utf8' });
  const present = new Set(report.trim().split('\t').map(Number));
  const requested = coverage.split(',').map((entry) => Number.parseInt(entry.slice(2), 16));
  const missing = requested.filter((code) => !present.has(code));
  if (missing.length > 0) {
    throw new Error(
      `${face.out} is missing ${missing.length} glyph(s): ` +
        missing.slice(0, 12).map((code) => `U+${code.toString(16)}`).join(' '),
    );
  }
  const bytes = readFileSync(target);
  if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error(`${face.out} is not a WOFF2 file`);
  }
  writeFileSync(`${target}.base64`, bytes.toString('base64'));
  process.stdout.write(`  ${face.out}: ${bytes.length} bytes, ${requested.length} glyphs, weight ${face.weight}\n`);
}
