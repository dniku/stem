/**
 * audio.js — turning Pipe objects into sound, honestly.
 *
 * One oscillator per active pipe, at exactly the frequency acoustics.js
 * predicts, plus the low odd partials that partialAmplitudes() describes. When
 * two pipes are close in frequency the difference tone that appears in the
 * speakers is therefore the one the maths says must appear: beating at |f1 - f2|
 * is an observable consequence of the model, not a sound effect layered on top.
 *
 * Audio is created lazily on the first deliberate user gesture. Browsers refuse
 * to start an AudioContext without one, and the sandboxed preview iframe is the
 * worst case of that, so the app must be fully usable - and fully legible -
 * with no audio at all. `state` reports which of the three possible worlds we
 * are in so the UI can say so rather than looking broken.
 */

/**
 * Amplitude of one pipe's summed partials, and how many voices are allowed.
 *
 * Each voice peaks at PARTIAL_PEAK after normalisation, so N voices at the worst
 * in-phase moment reach N * PARTIAL_PEAK * MASTER_GAIN. Keeping that under 1.0
 * is the whole clipping story: 6 * 0.16 * 0.9 = 0.864.
 */
const PARTIAL_PEAK = 0.16;
const MASTER_GAIN = 0.9;
const MAX_VOICES = 6;

/** Why there is no sound, if there is no sound. */
const AudioState = {
  NotStarted: 'not-started',
  Running: 'running',
  /** The browser has created the context but is waiting for a user gesture. */
  Suspended: 'suspended',
  /** Constructing Web Audio threw: no AudioContext in this browser. */
  Unavailable: 'unavailable',
};

class AudioEngine {
  state = AudioState.NotStarted;

  /** One voice per pipe id. Voices are kept so a note can be stopped cleanly. */
  voices = new Map();

  /** Shared gain so a mistuned cluster of many pipes cannot clip the output. */
  master = null;

  /** Measured peak of the master bus, 0..1, for the meter in the UI. */
  level = 0;

  analyser = null;

  /**
   * Create the context. Safe to call on every gesture; it only does work the
   * first time, and records why it cannot.
   */
  start() {
    if (this.state === AudioState.Running) {
      void this.context.resume();
      return this.state;
    }
    if (this.state === AudioState.Unavailable) return this.state;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('no AudioContext constructor');
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.analyser = this.context.createAnalyser();
      // A small FFT keeps the level meter cheap; 256 bins is plenty for a bar.
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.7;
      this.levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.state = this.context.state === 'running' ? AudioState.Running : AudioState.Suspended;
    } catch (error) {
      this.state = AudioState.Unavailable;
      this.reason = String(error && error.message ? error.message : error);
    }
    return this.state;
  }

  /** Resume after a suspend, e.g. when the tab regains focus on Android. */
  resume() {
    if (this.context && this.context.state !== 'running') {
      void this.context.resume().then(() => {
        this.state = AudioState.Running;
      }).catch(() => {});
    }
  }

  /**
   * Start (or retune) the voice for one pipe.
   *
   * `pipe` is read through the same interface acoustics.js defines, so the
   * frequency a listener hears and the frequency a label shows are computed by
   * one function on one object. That is the whole point: the picture cannot
   * disagree with the pitch.
   */
  noteOn(id, pipe, organ) {
    if (this.state !== AudioState.Running || !this.context) return;
    const now = this.context.currentTime;
    const frequency = pipe.frequencyHz(organ.temperatureC);
    let voice = this.voices.get(id);
    if (voice === undefined && this.voices.size >= MAX_VOICES) {
      // A seventh voice at the worst in-phase moment would clip everything, so
      // the newest note is refused. The count is left on `refused` for the UI to
      // say so: a silent limit reads as a broken key, not as a polyphony budget.
      this.refused = (this.refused ?? 0) + 1;
      return;
    }
    if (voice) {
      // Retune smoothly. A jump here would click, and a click on a slider drag
      // is the difference between an instrument and a broken speaker.
      for (const oscillator of voice.oscillators) {
        oscillator.frequency.setTargetAtTime(frequency * oscillator.stemRatio, now, 0.01);
      }
      voice.envelope.gain.setTargetAtTime(voice.targetGain, now, 0.03);
      return;
    }

    const envelope = this.context.createGain();
    envelope.gain.value = 0;
    const oscillators = [];
    const amplitudes = pipe.partialAmplitudes(5);
    // Normalise so a bright tone is not louder than a dark one: the mix is
    // divided by the sum of partials, keeping total effort constant regardless
    // of footprint position.
    const total = amplitudes.reduce((sum, value) => sum + value, 0) || 1;
    for (const [index, amplitude] of amplitudes.entries()) {
      if (amplitude <= 0) continue;
      const oscillator = this.context.createOscillator();
      oscillator.type = 'sine';
      oscillator.stemRatio = index + 1;
      oscillator.frequency.value = frequency * oscillator.stemRatio;
      const partial = this.context.createGain();
      // Per-pipe peak is exactly PARTIAL_PEAK: dividing by the sum of partials
      // normalises each voice to that amplitude whatever its colour, which is
      // what makes the headroom calculation below depend only on the number of
      // voices. With PARTIAL_PEAK at 0.16 and master at 0.9, worst-case in-phase
      // summation clips at about 7 voices, so MAX_VOICES caps below that rather
      // than trusting nobody will stack that many.
      partial.gain.value = (amplitude / total) * PARTIAL_PEAK;
      oscillator.connect(partial).connect(envelope);
      oscillator.start();
      oscillators.push(oscillator);
    }
    envelope.connect(this.master);
    const targetGain = 1;
    envelope.gain.setTargetAtTime(targetGain, now, 0.02);
    this.voices.set(id, { oscillators, envelope, targetGain });
  }

  /** Release one voice. The oscillators are stopped, not merely muted, so a
   *  long session does not accumulate them. */
  noteOff(id) {
    const voice = this.voices.get(id);
    if (!voice || !this.context) return;
    const now = this.context.currentTime;
    voice.envelope.gain.setTargetAtTime(0, now, 0.05);
    const stopAt = now + 0.3;
    for (const oscillator of voice.oscillators) oscillator.stop(stopAt);
    this.voices.delete(id);
  }

  /** Silence everything, e.g. when the pointer leaves the instrument. */
  allOff() {
    for (const id of [...this.voices.keys()]) this.noteOff(id);
  }

  /** Peak master level since the last call, for the level meter. */
  readLevel() {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let peak = 0;
    for (const sample of this.levelBuffer) {
      const deviation = Math.abs(sample - 128) / 128;
      if (deviation > peak) peak = deviation;
    }
    this.level = peak;
    return peak;
  }
}
