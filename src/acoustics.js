/**
 * acoustics.js — the physics of a pipe. No DOM, no Web Audio.
 *
 * Everything here is a closed-form consequence of two facts about a cylindrical
 * pipe that is closed at one end (a foot) and open at the other:
 *
 *   1. Standing waves fit a quarter wavelength in the effective length, so the
 *      resonances sit at f_n = (2n - 1) c / 4 L_eff. The odd multiple is what
 *      makes a stopped pipe sound an octave lower than an open pipe of the same
 *      length, and it is also why the upper notes of one pipe are NOT octaves.
 *   2. The open end does not end at the rim: the air just outside moves with the
 *      air just inside, so the pipe behaves as if it were longer than it is.
 *      End correction ~0.6 radii. Both consequences below - pitch drops, and
 *      wide pipes go flat relative to narrow ones - are things the user can see.
 *
 * Temperature enters through c = 331.3 * sqrt(1 + T/273.15): warming the air
 * sharpens every pipe, which is the real reason organs are hard to keep in tune.
 *
 * Units are SI throughout. Lengths are metres.
 */

/** Speed of sound in dry air, in m/s, at a Celsius temperature. */
function speedOfSound(temperatureC) {
  return 331.3 * Math.sqrt(1 + temperatureC / 273.15);
}

/**
 * Fractional frequency change when a 440 Hz reference is A440. Returned in
 * cents so the readout says "sharp by 9 cents" rather than a raw ratio.
 */
function centsBetween(frequencyHz, referenceHz) {
  return 1200 * Math.log2(frequencyHz / referenceHz);
}

/**
 * A flue pipe: the smallest thing that still has all the behaviour below.
 *
 * `lengthM` is the measured length from foot to mouth-top. `radiusM` drives the
 * end correction and therefore the pipe's stretch. `temperatureC` is shared by
 * every pipe in the organ, so it lives on the Organ, not here.
 */
class Pipe {
  constructor(lengthM, radiusM, footprint = 0.5) {
    this.lengthM = lengthM;
    this.radiusM = radiusM;
    /** Where the windhole sits along the pipe, 0 = foot, 1 = top. See toneColor. */
    this.footprint = footprint;
  }

  /** Effective acoustic length: measured length plus the open-end correction. */
  effectiveLengthM() {
    return this.lengthM + 0.6 * this.radiusM;
  }

  /**
   * The register (harmonic number) a pipe is speaking on.
   *
   * A real flue pipe jumps to the next available resonance when the wind is
   * pushed harder: overblowing. A stopped pipe's resonances are at 1, 3, 5...,
   * so overblowing lands on a twelfth (3x), not an octave (2x). That is the
   * single most characteristic sound of an organ and it is free here.
   */
  register = 1;

  /**
   * Fundamental in Hz for the current register, at the given air temperature.
   *
   * register 1 -> c/4L, register 2 -> 3c/4L, register 3 -> 5c/4L.
   */
  frequencyHz(temperatureC) {
    const c = speedOfSound(temperatureC);
    return ((2 * this.register - 1) * c) / (4 * this.effectiveLengthM());
  }

  /**
   * Relative amplitudes of the partials that make up the tone.
   *
   * Where the windhole blows on the pipe decides which partials get excited -
   * a footprint near the foot favours the fundamental (flutey), one near the
   * top drags in the odd partials (stringy). Index n is partial n+1. This is
   * not decoration: it is the reason two pipes of the same pitch can look
   * identical in tune and sound completely different.
   */
  partialAmplitudes(count = 8) {
    const f = this.footprint;
    const amplitudes = [];
    for (let n = 1; n <= count; n += 1) {
      // A closed pipe has no even partials; keep them at zero rather than
      // omitting them, so partial index and array index stay the same thing.
      const closedPipe = n % 2 === 1 ? 1 : 0;
      const slope = Math.pow(n, -(1.4 - 1.1 * f));
      amplitudes.push(closedPipe * slope);
    }
    return amplitudes;
  }
}

/**
 * The organ: a set of pipes sharing one air temperature and one reference pitch.
 *
 * Temperature and reference are properties of the instrument rather than the
 * pipe, because that is what makes them interesting: change one and every pipe
 * moves, so tuning is relative and the user can watch the whole rack go sharp
 * together.
 */
class Organ {
  /** Celsius. 20 is the conventional reference for organ pitch. */
  temperatureC = 20;

  /**
   * Semitone scale the rack snaps to when snapping is on.
   *
   * Equal temperament, relative to `referenceHz` as semitone 0. The organ's own
   * physics does not care about this - a pipe produces whatever frequency its
   * length gives it - so this is purely a user aid, and turning it off lets two
   * pipes beat against each other, which is the point of the whole view.
   */
  snapped = true;

  referenceHz = 261.63; // middle C

  /** @type {Pipe[]} */
  pipes = [];

  /** Nominal pitch class of a pipe if it were tuned to the nearest semitone. */
  nearestSemitone(pipe) {
    return Math.round(centsBetween(pipe.frequencyHz(this.temperatureC), this.referenceHz) / 100);
  }

  /** Snap a pipe to the nearest semitone by rewriting its length. */
  snapPipe(pipe) {
    const semitones = this.nearestSemitone(pipe);
    const targetHz = this.referenceHz * Math.pow(2, semitones / 12);
    const c = speedOfSound(this.temperatureC);
    // Invert f = c/4L for the length, keeping the end correction in place so
    // snapping does not silently change what "length" means.
    pipe.lengthM = (c * (2 * pipe.register - 1)) / (4 * targetHz) - 0.6 * pipe.radiusM;
    return pipe;
  }
}
