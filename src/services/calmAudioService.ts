export type CalmAudioPreset =
  | 'fire-night'
  | 'fire-birds'
  | 'fire-only'
  | 'night-only'
  | 'birds-only';

export interface CalmAudioState {
  isPlaying: boolean;
  isMuted: boolean;
  volumePercent: number;
  preset: CalmAudioPreset;
}

const DEFAULT_VOLUME_PERCENT = 65;
const SCHEDULER_INTERVAL_MS = 180;
const AMBIENT_LOOP_SECONDS = 6;
const NOISE_BURST_SECONDS = 0.6;
const FADE_SECONDS = 0.45;

function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME_PERCENT;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    return new AudioCtx();
  } catch {
    return null;
  }
}

export class CalmAudioController {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private fireGain: GainNode | null = null;
  private breezeGain: GainNode | null = null;
  private nightGain: GainNode | null = null;
  private birdsGain: GainNode | null = null;

  private loopSource: AudioBufferSourceNode | null = null;
  private noiseBurstBuffer: AudioBuffer | null = null;
  private schedulerId: number | null = null;

  private nextFireAt = 0;
  private nextSapAt = 0;
  private nextCricketAt = 0;
  private nextFrogAt = 0;
  private nextOwlAt = 0;
  private nextBirdAt = 0;

  private isPlaying = false;
  private isMuted = false;
  private volumePercent = DEFAULT_VOLUME_PERCENT;
  private preset: CalmAudioPreset = 'fire-night';
  private lastSkyDaylight: boolean | null = null;

  public getState(): CalmAudioState {
    return {
      isPlaying: this.isPlaying,
      isMuted: this.isMuted,
      volumePercent: this.volumePercent,
      preset: this.preset,
    };
  }

  public async start(): Promise<CalmAudioState> {
    this.isPlaying = true;
    const ctx = this.ensureGraph();
    if (!ctx) {
      return this.getState();
    }

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Browsers may block resume until a user gesture occurs.
      }
    }

    this.resetScheduleHorizons(ctx.currentTime);
    this.startScheduler();
    this.applyGains();
    return this.getState();
  }

  public stop(): CalmAudioState {
    this.isPlaying = false;
    this.stopScheduler();
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    }
    return this.getState();
  }

  public setMuted(muted: boolean): CalmAudioState {
    this.isMuted = Boolean(muted);
    this.applyGains();
    return this.getState();
  }

  public toggleMuted(): CalmAudioState {
    return this.setMuted(!this.isMuted);
  }

  public setVolume(volumePercent: number): CalmAudioState {
    this.volumePercent = clampVolumePercent(volumePercent);
    this.applyGains();
    return this.getState();
  }

  public setPreset(preset: CalmAudioPreset): CalmAudioState {
    this.preset = preset;
    if (this.ctx && this.isPlaying) {
      this.resetScheduleHorizons(this.ctx.currentTime);
    }
    this.applyGains();
    return this.getState();
  }

  public syncSkyDaylight(isDaylight: boolean): CalmAudioState {
    if (this.lastSkyDaylight === null) {
      this.lastSkyDaylight = isDaylight;
      return this.getState();
    }

    if (this.lastSkyDaylight !== isDaylight) {
      this.lastSkyDaylight = isDaylight;
      if (isDaylight) {
        if (this.preset === 'fire-night') this.preset = 'fire-birds';
        else if (this.preset === 'night-only') this.preset = 'birds-only';
      } else {
        if (this.preset === 'fire-birds') this.preset = 'fire-night';
        else if (this.preset === 'birds-only') this.preset = 'night-only';
      }
      if (this.ctx && this.isPlaying) {
        this.resetScheduleHorizons(this.ctx.currentTime);
      }
      this.applyGains();
    }

    return this.getState();
  }

  public dispose(): void {
    this.isPlaying = false;
    this.stopScheduler();

    try {
      this.loopSource?.stop();
    } catch {
      // Node may already be stopped.
    }
    this.loopSource = null;
    this.noiseBurstBuffer = null;

    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.masterGain = null;
    this.fireGain = null;
    this.breezeGain = null;
    this.nightGain = null;
    this.birdsGain = null;
  }

  private ensureGraph(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = createAudioContext();
    if (!ctx) return null;
    this.ctx = ctx;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;

    const fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    fireGain.connect(masterGain);
    this.fireGain = fireGain;

    const breezeGain = ctx.createGain();
    breezeGain.gain.value = 0;
    breezeGain.connect(masterGain);
    this.breezeGain = breezeGain;

    const nightGain = ctx.createGain();
    nightGain.gain.value = 0;
    nightGain.connect(masterGain);
    this.nightGain = nightGain;

    const birdsGain = ctx.createGain();
    birdsGain.gain.value = 0;
    birdsGain.connect(masterGain);
    this.birdsGain = birdsGain;

    this.noiseBurstBuffer = this.buildNoiseBurstBuffer(ctx);
    this.startAmbientLoop(ctx, fireGain, breezeGain);
    return ctx;
  }

  private startAmbientLoop(
    ctx: AudioContext,
    fireGain: GainNode,
    breezeGain: GainNode
  ): void {
    const sampleRate = ctx.sampleRate;
    const frameCount = Math.floor(sampleRate * AMBIENT_LOOP_SECONDS);
    const fadeFrames = Math.floor(sampleRate * 0.25);
    const totalFrames = frameCount + fadeFrames;

    const rawFire = new Float32Array(totalFrames);
    const rawBreeze = new Float32Array(totalFrames);

    let rumble = 0;
    let emberLp = 0;
    let crackleEnv = 0;
    let breezeLp = 0;
    let breezeAir = 0;

    for (let i = 0; i < totalFrames; i += 1) {
      const white = Math.random() * 2 - 1;
      rumble = rumble * 0.992 + white * 0.045;
      emberLp = emberLp * 0.94 + white * 0.08;

      if (Math.random() < 0.0045) {
        crackleEnv = 0.22 + Math.random() * 0.35;
      } else {
        crackleEnv *= 0.965;
      }
      const emberPop = white * crackleEnv;
      rawFire[i] = Math.max(-0.9, Math.min(0.9, rumble * 1.45 + (emberLp - rumble) * 0.65 + emberPop * 0.42));

      const windWhite = Math.random() * 2 - 1;
      breezeLp = breezeLp * 0.985 + windWhite * 0.025;
      breezeAir = breezeAir * 0.88 + windWhite * 0.022;
      const cycle = (2 * Math.PI * (i % frameCount)) / frameCount;
      const swell = 0.62 + 0.38 * Math.sin(cycle) * Math.sin(cycle * 0.5 + 0.7);
      rawBreeze[i] = Math.max(-0.8, Math.min(0.8, (breezeLp * 1.15 + breezeAir * 0.4) * swell));
    }

    const buffer = ctx.createBuffer(2, frameCount, sampleRate);
    const outFire = buffer.getChannelData(0);
    const outBreeze = buffer.getChannelData(1);

    // Crossfade the final tail back into the head so the 6s loop wraps without clicks.
    for (let i = 0; i < frameCount; i += 1) {
      if (i < fadeFrames) {
        const blend = i / fadeFrames;
        outFire[i] = rawFire[i] * blend + rawFire[frameCount + i] * (1 - blend);
        outBreeze[i] = rawBreeze[i] * blend + rawBreeze[frameCount + i] * (1 - blend);
      } else {
        outFire[i] = rawFire[i];
        outBreeze[i] = rawBreeze[i];
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);

    const hearthFilter = ctx.createBiquadFilter();
    hearthFilter.type = 'lowpass';
    hearthFilter.frequency.value = 1850;
    splitter.connect(hearthFilter, 0);
    hearthFilter.connect(fireGain);

    const breezeFilter = ctx.createBiquadFilter();
    breezeFilter.type = 'bandpass';
    breezeFilter.frequency.value = 390;
    breezeFilter.Q.value = 0.65;
    splitter.connect(breezeFilter, 1);
    breezeFilter.connect(breezeGain);

    source.start();
    this.loopSource = source;
  }

  private buildNoiseBurstBuffer(ctx: AudioContext): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const frameCount = Math.max(1, Math.floor(sampleRate * NOISE_BURST_SECONDS));
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private applyGains(): void {
    if (!this.ctx || !this.masterGain || !this.fireGain || !this.breezeGain || !this.nightGain || !this.birdsGain) {
      return;
    }

    const now = this.ctx.currentTime;
    const effectiveMaster = !this.isPlaying || this.isMuted ? 0 : (this.volumePercent / 100) * 0.72;

    const hasFire =
      this.preset === 'fire-night' ||
      this.preset === 'fire-birds' ||
      this.preset === 'fire-only';
    const hasNight = this.preset === 'fire-night' || this.preset === 'night-only';
    const hasBirds = this.preset === 'fire-birds' || this.preset === 'birds-only';

    const fireLevel = hasFire ? 0.85 : 0;
    const breezeLevel = hasNight || hasBirds ? 0.34 : 0.14;
    const nightLevel = hasNight ? 0.78 : 0;
    const birdsLevel = hasBirds ? 0.78 : 0;

    this.masterGain.gain.setTargetAtTime(effectiveMaster, now, 0.18);
    this.fireGain.gain.setTargetAtTime(fireLevel, now, FADE_SECONDS);
    this.breezeGain.gain.setTargetAtTime(breezeLevel, now, FADE_SECONDS);
    this.nightGain.gain.setTargetAtTime(nightLevel, now, FADE_SECONDS);
    this.birdsGain.gain.setTargetAtTime(birdsLevel, now, FADE_SECONDS);
  }

  private resetScheduleHorizons(now: number): void {
    this.nextFireAt = now + 0.08 + Math.random() * 0.25;
    this.nextSapAt = now + 0.9 + Math.random() * 1.4;
    this.nextCricketAt = now + 0.25 + Math.random() * 0.7;
    this.nextFrogAt = now + 2.2 + Math.random() * 2.8;
    this.nextOwlAt = now + 5.5 + Math.random() * 6.5;
    this.nextBirdAt = now + 0.2 + Math.random() * 0.7;
  }

  private startScheduler(): void {
    if (typeof window === 'undefined' || this.schedulerId !== null) return;
    this.schedulerId = window.setInterval(() => {
      this.scheduleTick();
    }, SCHEDULER_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (typeof window === 'undefined' || this.schedulerId === null) return;
    window.clearInterval(this.schedulerId);
    this.schedulerId = null;
  }

  private scheduleTick(): void {
    if (!this.isPlaying || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const horizon = now + 0.32;

    const hasFire =
      this.preset === 'fire-night' ||
      this.preset === 'fire-birds' ||
      this.preset === 'fire-only';
    const hasNight = this.preset === 'fire-night' || this.preset === 'night-only';
    const hasBirds = this.preset === 'fire-birds' || this.preset === 'birds-only';

    if (hasFire) {
      while (this.nextFireAt < horizon) {
        this.triggerFireSnap(this.nextFireAt);
        if (Math.random() < 0.32) {
          this.triggerFireSnap(this.nextFireAt + 0.016 + Math.random() * 0.032, 0.75);
        }
        this.nextFireAt += 0.14 + Math.random() * 0.52;
      }

      if (this.nextSapAt < horizon) {
        this.triggerSapSizzle(this.nextSapAt);
        this.nextSapAt = Math.max(horizon, this.nextSapAt) + 1.8 + Math.random() * 3.4;
      }
    }

    if (hasNight) {
      if (this.nextCricketAt < horizon) {
        this.triggerCricketChirp(this.nextCricketAt);
        this.nextCricketAt = Math.max(horizon, this.nextCricketAt) + 0.55 + Math.random() * 1.15;
      }

      if (this.nextFrogAt < horizon) {
        this.triggerTreeFrog(this.nextFrogAt);
        this.nextFrogAt = Math.max(horizon, this.nextFrogAt) + 3.4 + Math.random() * 4.6;
      }

      if (this.nextOwlAt < horizon) {
        this.triggerOwlHoot(this.nextOwlAt);
        this.nextOwlAt = Math.max(horizon, this.nextOwlAt) + 10.5 + Math.random() * 9.0;
      }
    }

    if (hasBirds && this.nextBirdAt < horizon) {
      const roll = Math.random();
      if (roll < 0.36) {
        this.triggerChickadee(this.nextBirdAt);
      } else if (roll < 0.76) {
        this.triggerSongbirdPhrase(this.nextBirdAt);
      } else {
        this.triggerThrushCall(this.nextBirdAt);
      }
      this.nextBirdAt = Math.max(horizon, this.nextBirdAt) + 1.4 + Math.random() * 2.8;
    }
  }

  private connectWithPan(source: AudioNode, target: AudioNode, pan: number): void {
    if (!this.ctx) return;
    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      source.connect(panner);
      panner.connect(target);
      return;
    }
    source.connect(target);
  }

  private triggerFireSnap(at: number, amplitudeScale = 1): void {
    if (!this.ctx || !this.fireGain || !this.noiseBurstBuffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurstBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400 + Math.random() * 2100;
    filter.Q.value = 2.0 + Math.random() * 3.2;

    const gain = this.ctx.createGain();
    const peak = (0.16 + Math.random() * 0.28) * amplitudeScale;
    const decay = 0.006 + Math.random() * 0.011;

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.0014);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    src.connect(filter);
    filter.connect(gain);
    this.connectWithPan(gain, this.fireGain, (Math.random() - 0.5) * 0.45);

    const offset = Math.random() * Math.max(0.05, NOISE_BURST_SECONDS - 0.08);
    src.start(at, offset, decay + 0.02);
  }

  private triggerSapSizzle(at: number): void {
    if (!this.ctx || !this.fireGain || !this.noiseBurstBuffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurstBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 2750 + Math.random() * 1400;

    const gain = this.ctx.createGain();
    const duration = 0.085 + Math.random() * 0.075;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.065 + Math.random() * 0.05, at + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    src.connect(filter);
    filter.connect(gain);
    this.connectWithPan(gain, this.fireGain, (Math.random() - 0.5) * 0.35);

    const offset = Math.random() * Math.max(0.05, NOISE_BURST_SECONDS - duration - 0.04);
    src.start(at, offset, duration + 0.02);
  }

  private triggerCricketChirp(at: number): void {
    if (!this.ctx || !this.nightGain) return;

    const voices = [
      { freq: 4180, pan: -0.64 },
      { freq: 4440, pan: 0.58 },
      { freq: 3120, pan: 0.24 },
    ];
    const voice = voices[Math.floor(Math.random() * voices.length)]!;
    const pulseCount = 3 + Math.floor(Math.random() * 3);
    const pulseLen = 0.019;
    const pulseGap = 0.03;

    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = voice.freq + (Math.random() - 0.5) * 35;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = voice.freq;
    bandpass.Q.value = 4.2;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);

    const peak = 0.045 + Math.random() * 0.025;
    for (let i = 0; i < pulseCount; i += 1) {
      const pStart = at + i * pulseGap;
      gain.gain.setValueAtTime(0.0001, pStart);
      gain.gain.linearRampToValueAtTime(peak, pStart + 0.0045);
      gain.gain.linearRampToValueAtTime(0.0001, pStart + pulseLen);
    }

    osc.connect(bandpass);
    bandpass.connect(gain);
    this.connectWithPan(gain, this.nightGain, voice.pan);

    const totalEnd = at + pulseCount * pulseGap + 0.03;
    osc.start(at);
    osc.stop(totalEnd);
  }

  private triggerTreeFrog(at: number): void {
    if (!this.ctx || !this.nightGain) return;
    const pan = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.45);
    const peeps = Math.random() < 0.45 ? 2 : 1;

    for (let i = 0; i < peeps; i += 1) {
      const t = at + i * 0.145;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1820, t);
      osc.frequency.exponentialRampToValueAtTime(2180, t + 0.052);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.042, t + 0.011);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.058);

      osc.connect(gain);
      this.connectWithPan(gain, this.nightGain, pan);
      osc.start(t);
      osc.stop(t + 0.068);
    }
  }

  private triggerOwlHoot(at: number): void {
    if (!this.ctx || !this.nightGain) return;
    const pan = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.35);
    const notes = [
      { offset: 0, dur: 0.32, startHz: 350, endHz: 318 },
      { offset: 0.52, dur: 0.15, startHz: 342, endHz: 332 },
      { offset: 0.74, dur: 0.38, startHz: 340, endHz: 298 },
    ];

    for (const note of notes) {
      const t = at + note.offset;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.startHz, t);
      osc.frequency.exponentialRampToValueAtTime(note.endHz, t + note.dur);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 520;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.046, t + 0.055);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);

      osc.connect(filter);
      filter.connect(gain);
      this.connectWithPan(gain, this.nightGain, pan);
      osc.start(t);
      osc.stop(t + note.dur + 0.02);
    }
  }

  private triggerChickadee(at: number): void {
    if (!this.ctx || !this.birdsGain) return;
    const pan = (Math.random() - 0.5) * 1.4;
    const base = 3350 + Math.random() * 240;

    this.scheduleBirdTone(at, 0.21, base, base * 0.98, 0.05, pan);
    this.scheduleBirdTone(at + 0.31, 0.27, base * 0.795, base * 0.78, 0.052, pan);
  }

  private triggerSongbirdPhrase(at: number): void {
    if (!this.ctx || !this.birdsGain) return;
    const pan = (Math.random() - 0.5) * 1.5;
    const syllables = 3 + Math.floor(Math.random() * 3);
    let cursor = at;

    for (let i = 0; i < syllables; i += 1) {
      const dur = 0.08 + Math.random() * 0.065;
      const f0 = 2250 + Math.random() * 1450;
      const sweep = Math.random() < 0.5 ? 1.18 + Math.random() * 0.14 : 0.78 + Math.random() * 0.1;
      const f1 = Math.max(1900, Math.min(4300, f0 * sweep));
      this.scheduleBirdTone(cursor, dur, f0, f1, 0.044 + Math.random() * 0.018, pan);
      cursor += dur + 0.045 + Math.random() * 0.055;
    }
  }

  private triggerThrushCall(at: number): void {
    if (!this.ctx || !this.birdsGain) return;
    const pan = (Math.random() - 0.5) * 1.3;
    const root = 2420 + Math.random() * 480;

    this.scheduleBirdTone(at, 0.24, root, root * 1.04, 0.048, pan);
    this.scheduleBirdTone(at + 0.29, 0.12, root * 1.24, root * 1.32, 0.042, pan);
    this.scheduleBirdTone(at + 0.43, 0.14, root * 1.18, root * 1.09, 0.04, pan);
  }

  private scheduleBirdTone(
    at: number,
    duration: number,
    startHz: number,
    endHz: number,
    peak: number,
    pan: number
  ): void {
    if (!this.ctx || !this.birdsGain) return;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startHz, at);
    osc.frequency.exponentialRampToValueAtTime(endHz, at + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = (startHz + endHz) * 0.5;
    filter.Q.value = 1.6;

    const gain = this.ctx.createGain();
    const attack = Math.min(0.025, duration * 0.22);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(filter);
    filter.connect(gain);
    this.connectWithPan(gain, this.birdsGain, pan);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }
}
