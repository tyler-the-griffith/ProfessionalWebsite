// Multi-stem player. All stems feed ONE Signalsmith Stretch node as interleaved stereo pairs,
// so key and speed changes apply to every stem with sample-accurate sync, then a splitter
// fans them back out into per-stem gain / pan / tone / effect sends.
import SignalsmithStretch from '../vendor/SignalsmithStretch.mjs';
import { appUrl } from './urls.mjs';

const TONES = {
  natural: { hp: 10, low: 0, high: 0, lp: 20000 },
  warm: { hp: 10, low: 3.5, high: -3, lp: 16000 },
  bright: { hp: 60, low: -1.5, high: 4.5, lp: 20000 },
  radio: { hp: 450, low: -6, high: -2, lp: 3400 },
  thin: { hp: 220, low: -3, high: 1, lp: 20000 },
};
export const TONE_NAMES = { natural: 'Natural', warm: 'Warm', bright: 'Bright', radio: 'Radio' };

function impulse(ctx, seconds = 2.6, decay = 3.2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  }
  return buf;
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.stems = [];       // [{id, chain}]
    this.duration = 0;
    this.playing = false;
    this.rate = 1;
    this.semitones = 0;
    this.natural = true;
    this.loop = null;
    this._t = 0;
    this._tAt = 0;
    this.loadToken = 0;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    this.master.connect(limiter).connect(ctx.destination);

    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    this.reverbIn.connect(conv).connect(revOut).connect(this.master);

    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.34;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3800;
    this.echoIn.connect(delay).connect(tone).connect(fb).connect(delay);
    tone.connect(this.master);
  }

  async resume() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  unload() {
    this.loadToken++;
    if (this.node) {
      try { this.node.schedule({ active: false }); } catch { /* already gone */ }
      this.node.dropBuffers?.();
      this.node.disconnect();
    }
    this.stems.forEach((s) => s.out.disconnect());
    this.node = null;
    this.stems = [];
    this.playing = false;
    this.duration = 0;
    this._t = 0;
  }

  /** stems: [{id}] -> fetches /media/<song>/<id>.opus and wires everything up. */
  async load(songId, stems, onProgress = () => {}, version = "original") {
    await this.init();
    this.unload();
    const token = this.loadToken;
    const ctx = this.ctx;
    const decoded = [];
    let done = 0;
    // Fetch in parallel, decode as they arrive.
    await Promise.all(stems.map(async (s, i) => {
      const r = await fetch(appUrl(`/media/${songId}/${s.id}.opus?v=${encodeURIComponent(version)}`));
      if (!r.ok) throw new Error(`Couldn't load the ${s.id} stem`);
      const buf = await ctx.decodeAudioData(await r.arrayBuffer());
      decoded[i] = buf;
      onProgress(++done / stems.length);
    }));
    if (token !== this.loadToken) return false;

    const length = Math.max(...decoded.map((b) => b.length));
    const channels = [];
    decoded.forEach((b) => {
      for (let c = 0; c < 2; c++) {
        const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
        const arr = new Float32Array(length);
        arr.set(src.subarray(0, length));
        channels.push(arr);
      }
    });
    decoded.length = 0;

    const n = channels.length;
    // The bundled worklet reads inputList[0] even while paused. Keep one
    // disconnected input so it receives [] and can play the stored stem buffers.
    const node = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [n] });
    if (token !== this.loadToken) return false;
    await node.addBuffers(channels, channels.map((c) => c.buffer));
    node.setUpdateInterval(0.05, (t) => { this._t = t; this._tAt = ctx.currentTime; });

    const split = ctx.createChannelSplitter(n);
    node.connect(split);
    this.stems = stems.map((s, i) => {
      const merge = ctx.createChannelMerger(2);
      split.connect(merge, 2 * i, 0);
      split.connect(merge, 2 * i + 1, 1);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
      const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220;
      const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 5200;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const rev = ctx.createGain(); rev.gain.value = 0;
      const echo = ctx.createGain(); echo.gain.value = 0;
      merge.connect(hp).connect(low).connect(high).connect(lp).connect(gain).connect(pan);
      pan.connect(this.master);
      pan.connect(rev).connect(this.reverbIn);
      pan.connect(echo).connect(this.echoIn);
      return { id: s.id, out: merge, hp, low, high, lp, gain, pan, rev, echo };
    });
    this.split = split;
    this.node = node;
    this.duration = length / ctx.sampleRate;
    this._t = 0;
    this._tAt = ctx.currentTime;
    node.schedule({ active: false, input: 0, rate: this.rate, semitones: this.semitones,
                    formantCompensation: this.natural, formantBaseHz: 0 });
    return true;
  }

  // ------------------------------------------------------------ transport

  async play() {
    if (!this.node) return;
    await this.resume();
    if (this.time() >= this.duration - 0.05) this.seek(0);
    this.node.schedule({ active: true, rate: this.rate, semitones: this.semitones });
    this.playing = true;
    this._tAt = this.ctx.currentTime;
    this.dispatchEvent(new Event('state'));
  }

  pause() {
    if (!this.node) return;
    this._t = this.time();
    this.node.schedule({ active: false });
    this.playing = false;
    this.dispatchEvent(new Event('state'));
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.node) return;
    t = Math.max(0, Math.min(this.duration - 0.05, t));
    this.node.schedule({ input: t });
    this._t = t;
    this._tAt = this.ctx.currentTime;
  }

  /** Song time (seconds) of what you're hearing right now. */
  time() {
    if (!this.node) return 0;
    let t = this._t;
    if (this.playing) t += (this.ctx.currentTime - this._tAt) * this.rate;
    if (this.loop && t >= this.loop[1]) t = this.loop[0] + ((t - this.loop[0]) % (this.loop[1] - this.loop[0]));
    return Math.max(0, Math.min(this.duration, t));
  }

  setPitch(semitones, natural = this.natural) {
    this.semitones = semitones;
    this.natural = natural;
    this.node?.schedule({ semitones, formantCompensation: natural });
  }

  setRate(rate) {
    this._t = this.time();
    this._tAt = this.ctx?.currentTime || 0;
    this.rate = rate;
    this.node?.schedule({ rate });
  }

  setLoop(range) {
    this.loop = range;
    this.node?.schedule(range ? { loopStart: range[0], loopEnd: range[1] } : { loopStart: 0, loopEnd: 0 });
  }

  // ------------------------------------------------------------ mix

  /** gains: {stemId: {gain, pan, tone, reverb, echo}} — missing stems are silent. */
  applyMix(gains, master = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(master, now, 0.03);
    for (const s of this.stems) {
      const m = gains[s.id] || { gain: 0 };
      s.gain.gain.setTargetAtTime(m.gain ?? 0, now, 0.03);
      s.pan.pan.setTargetAtTime(m.pan ?? 0, now, 0.03);
      s.rev.gain.setTargetAtTime((m.reverb ?? 0) * 0.9, now, 0.05);
      s.echo.gain.setTargetAtTime((m.echo ?? 0) * 0.7, now, 0.05);
      const t = TONES[m.tone] || TONES.natural;
      s.hp.frequency.setTargetAtTime(t.hp, now, 0.05);
      s.low.gain.setTargetAtTime(t.low, now, 0.05);
      s.high.gain.setTargetAtTime(t.high, now, 0.05);
      s.lp.frequency.setTargetAtTime(t.lp, now, 0.05);
    }
  }
}

// Pure mix rules are shared by Stage, Studio previews and exports.
export { VOCAL, BACKING, playableStems, defaultStemMix, stemMix, leadVocalLevel, computeGains } from './mix.js';
