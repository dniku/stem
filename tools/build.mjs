#!/usr/bin/env node
/**
 * Write index.html from src/. Thin wrapper so tests can build in-process.
 *
 * The output path is overridable because the source tree is not always
 * writable: inside `nix build`, src/ is a read-only store path, and writing the
 * artifact beside the sources fails with EACCES, so the package passes $out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArtifact } from './build-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg] = process.argv.slice(2);
const out = outArg === undefined ? join(root, 'index.html') : resolve(outArg);
const page = buildArtifact(root);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
process.stdout.write(`built ${out} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KiB)\n`);
