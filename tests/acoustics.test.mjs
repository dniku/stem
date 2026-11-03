#!/usr/bin/env node
/**
 * Acoustics tests: the model against known-good numbers and named behaviours.
 *
 * These run in plain node, with no browser, because everything in
 * src/acoustics.js is pure. The values checked are published reference values
 * rather than outputs of this code, so a wrong formula fails here rather than
 * agreeing with itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Evaluate the acoustics module as a script.
 *
 * src/acoustics.js has no imports, so it can be loaded as-is, which keeps the
 * artifact's source and the tested source byte-identical.
 */
function loadAcoustics() {
  const source = readFileSync(join(ROOT, 'src', 'acoustics.js'), 'utf8');
  const context = { globalThis: {} };
  const script = new vm.Script(`${source}\n;globalThis.api = { Pipe, Organ, speedOfSound, centsBetween };`);
  script.runInNewContext(context);
  return context.globalThis.api;
}

const { Pipe, Organ, speedOfSound, centsBetween } = loadAcoustics();

/** Tolerance in Hz: 0.05 is a twentieth of a semitone down near 440 Hz. */
const HZ = 0.05;

test('speed of sound matches published reference values', () => {
  // 331.3 m/s at 0 °C and ~343 m/s at 20 °C are the textbook figures for dry air.
  assert.ok(Math.abs(speedOfSound(0) - 331.3) < 0.1, `0 °C gave ${speedOfSound(0)}`);
  assert.ok(Math.abs(speedOfSound(20) - 343.2) < 0.3, `20 °C gave ${speedOfSound(20)}`);
  assert.ok(Math.abs(speedOfSound(37) - 353.0) < 0.4, `37 °C gave ${speedOfSound(37)}`);
  // Monotonic in temperature: the whole "warm air goes sharp" behaviour depends
  // on this being strictly increasing over the slider's range.
  for (let temperature = 5; temperature < 38; temperature += 1) {
    assert.ok(speedOfSound(temperature + 1) > speedOfSound(temperature), `not increasing at ${temperature}`);
  }
});

test('an 8-foot open pipe is middle C, so a stopped one is an octave lower', () => {
  const organ = new Organ();
  // A stopped (closed-at-the-foot) pipe of length L sounds f = c/4L. At 20 °C a
  // 1.6 m stopped pipe is ~53.6 Hz; an open pipe of the same length would be
  // 2c/4L, i.e. double. That factor of two is the defining fact about stopped
  // organ pipes and the reason organ "8 ft" means an octave lower than "8 ft open".
  const stopped = new Pipe(1.6, 0.004);
  const stoppedHz = stopped.frequencyHz(20);
  const asIfOpen = (2 * speedOfSound(20)) / (2 * stopped.effectiveLengthM());
  assert.ok(Math.abs(asIfOpen / stoppedHz - 2) < 1e-9, 'stopped pipe is not an octave below open');
  assert.ok(Math.abs(stoppedHz - 53.6) < 0.4, `1.6 m stopped gave ${stoppedHz}`);
  assert.equal(organ.nearestSemitone(stopped) % 12, 0, 'a 1.6 m stopped pipe should be a C');
});

test('halving the length raises the pitch by exactly an octave', () => {
  const organ = new Organ();
  const long = new Pipe(0.65, 0.012);
  // Halving the *effective* length halves the frequency's denominator. The end
  // correction means the measured length must be halved after subtracting it,
  // which is the subtlety this assertion pins.
  const short = new Pipe(long.lengthM / 2, long.radiusM / 2);
  const longEffective = long.effectiveLengthM();
  const shortEffective = short.effectiveLengthM();
  assert.ok(Math.abs(longEffective / shortEffective - 2) < 1e-9);
  const cents = centsBetween(short.frequencyHz(20), long.frequencyHz(20));
  assert.ok(Math.abs(cents - 1200) < 1e-6, `halving gave ${cents} cents`);
});

test('overblowing lands on a twelfth, not an octave, because a closed pipe has no even partials', () => {
  const pipe = new Pipe(0.42, 0.018);
  const fundamental = pipe.frequencyHz(20);
  pipe.register = 2;
  const second = pipe.frequencyHz(20);
  pipe.register = 3;
  const third = pipe.frequencyHz(20);
  assert.ok(Math.abs(second / fundamental - 3) < 1e-9, `register 2 is ${second / fundamental}x`);
  assert.ok(Math.abs(third / fundamental - 5) < 1e-9, `register 3 is ${third / fundamental}x`);
  // 3x is 1901.955 cents: an octave plus a fifth. The audible surprise this model
  // is meant to teach, stated as a number.
  assert.ok(Math.abs(centsBetween(second, fundamental) - 1901.955) < 0.01);
});

test('a wider bore sits flat of a narrow one at the same measured length', () => {
  const narrow = new Pipe(0.4, 0.006);
  const wide = new Pipe(0.4, 0.040);
  assert.equal(wide.lengthM, narrow.lengthM);
  assert.ok(wide.effectiveLengthM() > narrow.effectiveLengthM());
  const cents = centsBetween(wide.frequencyHz(20), narrow.frequencyHz(20));
  assert.ok(cents < 0, `wide pipe was not flatter (${cents} cents)`);
  // The end correction is 0.6 radii, so the flatness is proportional to the
  // change in radius and is audible for a fat pipe: ~0.6*(0.040-0.006)/0.41 ≈ 5%.
  assert.ok(cents < -40, `expected an audible shift, got ${cents} cents`);
});

test('warming the air sharpens every pipe by the same relative amount', () => {
  const organ = new Organ();
  const pipes = [new Pipe(0.65, 0.012), new Pipe(0.31, 0.02), new Pipe(0.12, 0.008)];
  const cold = pipes.map((pipe) => pipe.frequencyHz(15));
  const warm = pipes.map((pipe) => pipe.frequencyHz(30));
  const ratios = warm.map((frequency, i) => frequency / cold[i]);
  // Same ratio for all three: pitch shift is a property of the air, not the pipe.
  for (const ratio of ratios) assert.ok(Math.abs(ratio - ratios[0]) < 1e-12);
  // 15 -> 30 °C is a 2.55% speed change, i.e. 43.9 cents: audible, and the
  // reason an organ that has been playing for an hour is out of tune.
  const cents = centsBetween(ratios[0] * 440, 440);
  assert.ok(cents > 43 && cents < 45, `15 -> 30 °C shift gave ${cents} cents`);
  assert.ok(organ.temperatureC === 20, 'Organ should default to a 20 °C reference');
});

test('partial amplitudes: closed pipe means zero even partials, and footprint changes colour', () => {
  const dark = new Pipe(0.4, 0.012, 0.05);
  const bright = new Pipe(0.4, 0.012, 0.95);
  const darkParts = dark.partialAmplitudes(6);
  const brightParts = bright.partialAmplitudes(6);
  assert.equal(darkParts.length, 6);
  for (const [index, value] of darkParts.entries()) {
    if ((index + 1) % 2 === 0) assert.equal(value, 0, `even partial ${index + 1} should be silent`);
  }
  // A bright footprint has relatively more energy in partial 3 than a dark one.
  const darkRatio = darkParts[2] / darkParts[0];
  const brightRatio = brightParts[2] / brightParts[0];
  assert.ok(brightRatio > darkRatio, `bright ${brightRatio} should exceed dark ${darkRatio}`);
  // Both decay: a pipe is not a sawtooth.
  assert.ok(darkParts[4] < darkParts[0] && brightParts[4] < brightParts[0]);
});

test('snapping changes length, never the meaning of length', () => {
  const organ = new Organ();
  const pipe = new Pipe(0.6371, 0.012);
  const before = organ.nearestSemitone(pipe);
  organ.snapPipe(pipe);
  const afterHz = pipe.frequencyHz(organ.temperatureC);
  const expectedHz = organ.referenceHz * Math.pow(2, before / 12);
  assert.ok(Math.abs(afterHz - expectedHz) < HZ, `${afterHz} vs ${expectedHz}`);
  // The end correction must still be present after snapping, otherwise snapping
  // would silently redefine length and the width control would stop working.
  assert.ok(Math.abs(pipe.effectiveLengthM() - (pipe.lengthM + 0.6 * pipe.radiusM)) < 1e-12);
  // And snapping twice is a no-op: the pipe is already on a semitone.
  const twice = pipe.lengthM;
  organ.snapPipe(pipe);
  assert.ok(Math.abs(pipe.lengthM - twice) < 1e-9);
});

test('two pipes a few cents apart beat at their difference', () => {
  // The behaviour the tune-lock-off control exists for: the beat frequency is an
  // observable consequence of two close frequencies, so state it as a number.
  const a = new Pipe(0.4, 0.012);
  const b = new Pipe(0.4, 0.032);
  const difference = Math.abs(a.frequencyHz(20) - b.frequencyHz(20));
  assert.ok(difference > 1 && difference < 40, `difference was ${difference} Hz`);
  const cents = Math.abs(centsBetween(a.frequencyHz(20), b.frequencyHz(20)));
  assert.ok(cents < 100, `${cents} cents is more than a semitone apart`);
});
