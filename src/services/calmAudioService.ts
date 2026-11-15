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
const SILENT_WAV_SAMPLE_RATE = 8000;
const SILENT_WAV_SAMPLES = 800; // 0.1s digital silence for iOS playback session unlock

let cachedSilentWavDataUri: string | null = null;

function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME_PERCENT;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getSilentWavDataUri(): string {
  if (cachedSilentWavDataUri) return cachedSilentWavDataUri;

  const dataSize = SILENT_WAV_SAMPLES * 2; // 16-bit mono PCM
  const totalBytes = 44 + dataSize;
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = 1
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  // Sample bytes remain 0x0000 (digital silence)

  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]!);
    }
    cachedSilentWavDataUri = `data:audio/wav;base64,${btoa(binary)}`;
  } else {
    cachedSilentWavDataUri = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  }
  return cachedSilentWavDataUri;
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
  private nightGain: GainNode | null = null;
  private birdsGain: GainNode | null = null;

  private fireLoopSource: AudioBufferSourceNode | null = null;
  private noiseBurstBuffer: AudioBuffer | null = null;
  private keepAliveAudio: HTMLAudioElement | null = null;
  private schedulerId: number | null = null;
  private gestureUnlockBound = false;

  private nextFireAt = 0;
  private nextClusterAt = 0;
  private nextCricketAt = 0;
  private nextFrogAt = 0;
  private nextOwlAt = 0;
  private nextBirdAt = 0;

  private isPlaying = false;
  private isMuted = false;
  private volumePercent = DEFAULT_VOLUME_PERCENT;
  private preset: CalmAudioPreset = 'fire-night';
  private lastSkyDaylight: boolean | null = null;

  private readonly handleUserGestureUnlock = () => {
    if (!this.isPlaying || this.isMuted) return;
    this.unlockIosAudioSession();
    if (this.ctx && (this.ctx.state as string) !== 'running') {
      this.unlockContext(this.ctx);
    }
  };

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
    this.unlockIosAudioSession();

    const ctx = this.ensureContext();
    if (!ctx) {
      return this.getState();
    }

    this.bindGestureUnlock();

    // Synchronously resume and unlock WebKit hardware audio inside the tap gesture
    // BEFORE generating loop buffers or awaiting asynchronous state transitions.
    const resumePromise = this.unlockContext(ctx);
    this.ensureGraphNodes(ctx);

    this.resetScheduleHorizons(ctx.currentTime);
    this.startScheduler();
    this.applyGains();
    this.scheduleTick();

    if (resumePromise) {
      try {
        await resumePromise;
      } catch {
        // iOS/desktop browsers may defer resume until a subsequent touch gesture.
      }
      if (this.isPlaying && this.ctx === ctx && (ctx.state as string) === 'running') {
        this.applyGains();
        this.scheduleTick();
      }
    }

    return this.getState();
  }

  public stop(): CalmAudioState {
    this.isPlaying = false;
    this.stopScheduler();
    this.unbindGestureUnlock();
    this.pauseKeepAliveAudio();
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    }
    return this.getState();
  }

  public setMuted(muted: boolean): CalmAudioState {
    this.isMuted = Boolean(muted);
    if (this.isPlaying && !this.isMuted) {
      this.unlockIosAudioSession();
      if (this.ctx) {
        this.unlockContext(this.ctx);
      }
    } else if (this.isMuted) {
      this.pauseKeepAliveAudio();
    }
    this.applyGains();
    return this.getState();
  }

  public toggleMuted(): CalmAudioState {
    return this.setMuted(!this.isMuted);
  }

  public setVolume(volumePercent: number): CalmAudioState {
    this.volumePercent = clampVolumePercent(volumePercent);
    if (this.isPlaying && !this.isMuted) {
      this.unlockIosAudioSession();
      if (this.ctx) {
        this.unlockContext(this.ctx);
      }
    }
    this.applyGains();
    return this.getState();
  }

  public setPreset(preset: CalmAudioPreset): CalmAudioState {
    this.preset = preset;
    if (this.isPlaying && !this.isMuted) {
      this.unlockIosAudioSession();
      if (this.ctx) {
        this.unlockContext(this.ctx);
      }
    }
    if (this.ctx && this.isPlaying) {
      this.resetScheduleHorizons(this.ctx.currentTime);
      this.applyGains();
      this.scheduleTick();
    } else {
      this.applyGains();
    }
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
    this.unbindGestureUnlock();
    this.pauseKeepAliveAudio();

    if (this.keepAliveAudio) {
      try {
        this.keepAliveAudio.removeAttribute('src');
        if (typeof this.keepAliveAudio.load === 'function') {
          this.keepAliveAudio.load();
        }
      } catch {
        // Ignore DOM stub restrictions on teardown.
      }
      this.keepAliveAudio = null;
    }

    try {
      this.fireLoopSource?.stop();
    } catch {
      // Node may already be stopped.
    }
    this.fireLoopSource = null;
    this.noiseBurstBuffer = null;

    if (this.ctx) {
      this.ctx.onstatechange = null;
      try {
        const closePromise = this.ctx.close?.();
        if (closePromise && typeof closePromise.catch === 'function') {
          closePromise.catch(() => undefined);
        }
      } catch {
        // Ignore already-closed contexts.
      }
    }
    this.ctx = null;
    this.masterGain = null;
    this.fireGain = null;
    this.nightGain = null;
    this.birdsGain = null;
  }

  private unlockIosAudioSession(): void {
    if (typeof navigator !== 'undefined') {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) {
        try {
          nav.audioSession.type = 'playback';
        } catch {
          // Ignore unsupported or read-only audioSession implementations.
        }
      }
    }

    if (!this.isPlaying || this.isMuted) return;
    if (typeof document === 'undefined' || typeof Audio === 'undefined') return;

    if (!this.keepAliveAudio) {
      try {
        const el = new Audio(getSilentWavDataUri());
        el.setAttribute('playsinline', '');
        el.setAttribute('webkit-playsinline', '');
        el.loop = true;
        el.preload = 'auto';
        el.volume = 0.01;
        this.keepAliveAudio = el;
      } catch {
        this.keepAliveAudio = null;
      }
    }

    if (this.keepAliveAudio) {
      try {
        const playResult = this.keepAliveAudio.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(() => undefined);
        }
      } catch {
        // jsdom throws synchronous NotImplementedError on media playback; ignore safely.
      }
    }
  }

  private pauseKeepAliveAudio(): void {
    if (!this.keepAliveAudio) return;
    try {
      this.keepAliveAudio.pause();
    } catch {
      // Ignore partial DOM media stubs.
    }
  }

  private unlockContext(ctx: AudioContext): Promise<void> | null {
    const state = ctx.state as string;
    let resumePromise: Promise<void> | null = null;
    if (state !== 'running' && state !== 'closed') {
      try {
        const maybePromise = ctx.resume();
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => undefined);
          resumePromise = maybePromise;
        }
      } catch {
        // Ignore resume rejections before user gesture.
      }
    }

    try {
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const unlockSource = ctx.createBufferSource();
      unlockSource.buffer = silentBuffer;
      unlockSource.connect(ctx.destination);
      unlockSource.start(0);
    } catch {
      // Ignore unlock failures on mocked/closed contexts.
    }

    return resumePromise;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = createAudioContext();
    if (!ctx) return null;
    this.ctx = ctx;

    ctx.onstatechange = () => {
      if (this.isPlaying && this.ctx === ctx && (ctx.state as string) === 'running') {
        this.resetScheduleHorizons(ctx.currentTime);
        this.applyGains();
        this.scheduleTick();
      }
    };

    return ctx;
  }

  private ensureGraphNodes(ctx: AudioContext): void {
    if (this.masterGain) return;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;

    const fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    fireGain.connect(masterGain);
    this.fireGain = fireGain;

    const nightGain = ctx.createGain();
    nightGain.gain.value = 0;
    nightGain.connect(masterGain);
    this.nightGain = nightGain;

    const birdsGain = ctx.createGain();
    birdsGain.gain.value = 0;
    birdsGain.connect(masterGain);
    this.birdsGain = birdsGain;

    this.noiseBurstBuffer = this.buildNoiseBurstBuffer(ctx);
    this.startAmbientLoops(ctx, fireGain);
  }

  private startAmbientLoops(ctx: AudioContext, fireGain: GainNode): void {
    const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
    const frameCount = Math.floor(sampleRate * AMBIENT_LOOP_SECONDS);
    const fadeFrames = Math.floor(sampleRate * 0.2);
    const totalFrames = frameCount + fadeFrames;

    // Very soft <140 Hz low draft murmur only (<= 0.035 amplitude, zero mid/high noise hiss).
    const rawDraft = new Float32Array(totalFrames);
    const a130 = Math.exp((-2 * Math.PI * 130) / sampleRate);
    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < totalFrames; i += 1) {
      const white = Math.random() * 2 - 1;
      lp1 = lp1 * a130 + white * (1 - a130);
      lp2 = lp2 * a130 + lp1 * (1 - a130);
      rawDraft[i] = Math.max(-0.035, Math.min(0.035, lp2 * 0.16));
    }

    const fireBuffer = ctx.createBuffer(1, frameCount, sampleRate);
    const outFire = fireBuffer.getChannelData(0);

    // Crossfade the sub-140 Hz air draft seamlessly over the 6s boundary.
    for (let i = 0; i < frameCount; i += 1) {
      if (i < fadeFrames) {
        const blend = i / fadeFrames;
        outFire[i] = rawDraft[i]! * blend + rawDraft[frameCount + i]! * (1 - blend);
      } else {
        outFire[i] = rawDraft[i]!;
      }
    }

    // Scatter discrete, clustered dry charcoal/wood micro-crackles across quiet gaps.
    const spikeSamples = Math.max(2, Math.floor(0.0004 * sampleRate));
    let cursor = Math.floor((0.02 + Math.random() * 0.04) * sampleRate);
    let clusterRemaining = 2 + Math.floor(Math.random() * 5);

    while (cursor < frameCount) {
      const impulseSamples = Math.max(
        8,
        Math.floor((0.0006 + Math.random() * 0.0026) * sampleRate)
      );
      const fHigh = 2200 + Math.random() * 3400;
      const tauHigh = 0.0005 + Math.random() * 0.0009;
      const fLow = 550 + Math.random() * 900;
      const tauLow = 0.001 + Math.random() * 0.0018;
      const amp = 0.16 + Math.random() * 0.44;
      const sign = Math.random() < 0.5 ? 1 : -1;

      for (let k = 0; k < impulseSamples; k += 1) {
        const t = k / sampleRate;
        const spike = k < spikeSamples ? (1 - k / spikeSamples) * (Math.random() * 2 - 1) * 0.45 : 0;
        const hi = Math.sin(2 * Math.PI * fHigh * t) * Math.exp(-t / tauHigh) * 0.58;
        const lo = Math.sin(2 * Math.PI * fLow * t) * Math.exp(-t / tauLow) * 0.42;
        const idx = (cursor + k) % frameCount;
        outFire[idx] = (outFire[idx] ?? 0) + sign * amp * (spike + hi + lo);
      }

      clusterRemaining -= 1;
      if (clusterRemaining <= 0) {
        clusterRemaining = 2 + Math.floor(Math.random() * 5);
        cursor += Math.floor((0.055 + Math.random() * 0.13) * sampleRate);
      } else {
        cursor += Math.floor((0.01 + Math.random() * 0.032) * sampleRate);
      }
    }

    for (let i = 0; i < frameCount; i += 1) {
      const sample = outFire[i] ?? 0;
      if (sample > 0.92) outFire[i] = 0.92;
      else if (sample < -0.92) outFire[i] = -0.92;
    }

    const fireSource = ctx.createBufferSource();
    fireSource.buffer = fireBuffer;
    fireSource.loop = true;

    const hearthFilter = ctx.createBiquadFilter();
    hearthFilter.type = 'lowpass';
    hearthFilter.frequency.value = 4800;
    fireSource.connect(hearthFilter);
    hearthFilter.connect(fireGain);

    fireSource.start();
    this.fireLoopSource = fireSource;
  }

  private buildNoiseBurstBuffer(ctx: AudioContext): AudioBuffer {
    const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
    const frameCount = Math.max(1, Math.floor(sampleRate * NOISE_BURST_SECONDS));
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private bindGestureUnlock(): void {
    if (typeof window === 'undefined' || this.gestureUnlockBound) return;
    window.addEventListener('touchend', this.handleUserGestureUnlock, { passive: true });
    window.addEventListener('pointerdown', this.handleUserGestureUnlock, { passive: true });
    window.addEventListener('click', this.handleUserGestureUnlock, { passive: true });
    this.gestureUnlockBound = true;
  }

  private unbindGestureUnlock(): void {
    if (typeof window === 'undefined' || !this.gestureUnlockBound) return;
    window.removeEventListener('touchend', this.handleUserGestureUnlock);
    window.removeEventListener('pointerdown', this.handleUserGestureUnlock);
    window.removeEventListener('click', this.handleUserGestureUnlock);
    this.gestureUnlockBound = false;
  }

  private applyGains(): void {
    if (
      !this.ctx ||
      !this.masterGain ||
      !this.fireGain ||
      !this.nightGain ||
      !this.birdsGain
    ) {
      return;
    }

    const now = this.ctx.currentTime;
    const effectiveMaster = !this.isPlaying || this.isMuted ? 0 : (this.volumePercent / 100) * 0.95;

    const hasFire =
      this.preset === 'fire-night' ||
      this.preset === 'fire-birds' ||
      this.preset === 'fire-only';
    const hasNight = this.preset === 'fire-night' || this.preset === 'night-only';
    const hasBirds = this.preset === 'fire-birds' || this.preset === 'birds-only';

    const fireLevel = hasFire ? 0.75 : 0;
    const nightLevel = hasNight ? 0.9 : 0;
    const birdsLevel = hasBirds ? 0.9 : 0;

    this.masterGain.gain.setTargetAtTime(effectiveMaster, now, 0.12);
    this.fireGain.gain.setTargetAtTime(fireLevel, now, FADE_SECONDS);
    this.nightGain.gain.setTargetAtTime(nightLevel, now, FADE_SECONDS);
    this.birdsGain.gain.setTargetAtTime(birdsLevel, now, FADE_SECONDS);
  }

  private resetScheduleHorizons(now: number): void {
    this.nextFireAt = now + 0.02 + Math.random() * 0.08;
    this.nextClusterAt = now + 0.5 + Math.random() * 0.9;
    this.nextCricketAt = now + 0.08 + Math.random() * 0.22;
    this.nextFrogAt = now + 1.8 + Math.random() * 2.2;
    this.nextOwlAt = now + 4.2 + Math.random() * 4.5;
    this.nextBirdAt = now + 0.08 + Math.random() * 0.25;
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
    if (!this.isPlaying || !this.ctx) return;
    if ((this.ctx.state as string) !== 'running') {
      try {
        const p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        // Ignore resume errors outside gestures.
      }
      return;
    }

    const now = this.ctx.currentTime;
    const horizon = now + 0.32;

    if (this.nextFireAt < now) this.nextFireAt = now + 0.015;
    if (this.nextClusterAt < now) this.nextClusterAt = now + 0.12;
    if (this.nextCricketAt < now) this.nextCricketAt = now + 0.08;
    if (this.nextFrogAt < now) this.nextFrogAt = now + 0.2;
    if (this.nextOwlAt < now) this.nextOwlAt = now + 0.4;
    if (this.nextBirdAt < now) this.nextBirdAt = now + 0.08;

    const hasFire =
      this.preset === 'fire-night' ||
      this.preset === 'fire-birds' ||
      this.preset === 'fire-only';
    const hasNight = this.preset === 'fire-night' || this.preset === 'night-only';
    const hasBirds = this.preset === 'fire-birds' || this.preset === 'birds-only';

    if (hasFire) {
      while (this.nextFireAt < horizon) {
        this.triggerFireSnap(this.nextFireAt);
        if (Math.random() < 0.38) {
          this.triggerFireSnap(this.nextFireAt + 0.018 + Math.random() * 0.034, 0.78);
        }
        this.nextFireAt += 0.16 + Math.random() * 0.44;
      }

      if (this.nextClusterAt < horizon) {
        this.triggerCrackleCluster(this.nextClusterAt);
        this.nextClusterAt = Math.max(horizon, this.nextClusterAt) + 1.1 + Math.random() * 2.3;
      }
    }

    if (hasNight) {
      if (this.nextCricketAt < horizon) {
        this.triggerCricketChirp(this.nextCricketAt);
        this.nextCricketAt = Math.max(horizon, this.nextCricketAt) + 0.55 + Math.random() * 1.1;
      }

      if (this.nextFrogAt < horizon) {
        this.triggerTreeFrog(this.nextFrogAt);
        this.nextFrogAt = Math.max(horizon, this.nextFrogAt) + 3.2 + Math.random() * 4.2;
      }

      if (this.nextOwlAt < horizon) {
        this.triggerOwlHoot(this.nextOwlAt);
        this.nextOwlAt = Math.max(horizon, this.nextOwlAt) + 9.5 + Math.random() * 8.0;
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
      this.nextBirdAt = Math.max(horizon, this.nextBirdAt) + 1.3 + Math.random() * 2.5;
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

    const startAt = Math.max(this.ctx.currentTime + 0.012, at);
    const pan = (Math.random() - 0.5) * 0.45;

    // 1. Crisp fracture click (3.5-7.5 ms) — short high-Q snap without sustained static hiss.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurstBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800 + Math.random() * 2800;
    filter.Q.value = 4.5 + Math.random() * 3.5;

    const clickGain = this.ctx.createGain();
    const peak = (0.42 + Math.random() * 0.33) * amplitudeScale;
    const decay = 0.0035 + Math.random() * 0.004;

    clickGain.gain.setValueAtTime(0.0001, startAt);
    clickGain.gain.linearRampToValueAtTime(peak, startAt + 0.0008);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);

    src.connect(filter);
    filter.connect(clickGain);
    this.connectWithPan(clickGain, this.fireGain, pan);

    const offset = Math.random() * Math.max(0.05, NOISE_BURST_SECONDS - 0.06);
    src.start(startAt, offset, decay + 0.01);

    // 2. Hollow dry-wood pop (9-16 ms) giving physical firewood "tok/pop" body.
    const popOsc = this.ctx.createOscillator();
    popOsc.type = 'triangle';
    const popDur = 0.009 + Math.random() * 0.007;
    const popStartHz = 380 + Math.random() * 380;
    const popEndHz = 130 + Math.random() * 110;
    popOsc.frequency.setValueAtTime(popStartHz, startAt);
    popOsc.frequency.exponentialRampToValueAtTime(popEndHz, startAt + popDur);

    const popGain = this.ctx.createGain();
    const popPeak = (0.22 + Math.random() * 0.16) * amplitudeScale;
    popGain.gain.setValueAtTime(0.0001, startAt);
    popGain.gain.linearRampToValueAtTime(popPeak, startAt + 0.0012);
    popGain.gain.exponentialRampToValueAtTime(0.0001, startAt + popDur);

    popOsc.connect(popGain);
    this.connectWithPan(popGain, this.fireGain, pan);
    popOsc.start(startAt);
    popOsc.stop(startAt + popDur + 0.01);
  }

  private triggerCrackleCluster(at: number): void {
    if (!this.ctx || !this.fireGain) return;

    const count = 4 + Math.floor(Math.random() * 5);
    let cursor = Math.max(this.ctx.currentTime + 0.012, at);
    for (let i = 0; i < count; i += 1) {
      const scale = 0.35 + Math.random() * 0.6;
      this.triggerFireSnap(cursor, scale);
      cursor += 0.014 + Math.random() * 0.024;
    }
  }

  private triggerCricketChirp(at: number): void {
    if (!this.ctx || !this.nightGain) return;

    const startAt = Math.max(this.ctx.currentTime + 0.012, at);
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
    bandpass.Q.value = 2.4;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);

    const peak = 0.16 + Math.random() * 0.08;
    for (let i = 0; i < pulseCount; i += 1) {
      const pStart = startAt + i * pulseGap;
      gain.gain.setValueAtTime(0.0001, pStart);
      gain.gain.linearRampToValueAtTime(peak, pStart + 0.0045);
      gain.gain.linearRampToValueAtTime(0.0001, pStart + pulseLen);
    }

    osc.connect(bandpass);
    bandpass.connect(gain);
    this.connectWithPan(gain, this.nightGain, voice.pan);

    const totalEnd = startAt + pulseCount * pulseGap + 0.03;
    osc.start(startAt);
    osc.stop(totalEnd);
  }

  private triggerTreeFrog(at: number): void {
    if (!this.ctx || !this.nightGain) return;
    const baseAt = Math.max(this.ctx.currentTime + 0.012, at);
    const pan = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.45);
    const peeps = Math.random() < 0.45 ? 2 : 1;

    for (let i = 0; i < peeps; i += 1) {
      const t = Math.max(this.ctx.currentTime + 0.012, baseAt + i * 0.145);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1750, t);
      osc.frequency.exponentialRampToValueAtTime(2160, t + 0.052);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.011);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.058);

      osc.connect(gain);
      this.connectWithPan(gain, this.nightGain, pan);
      osc.start(t);
      osc.stop(t + 0.068);
    }
  }

  private triggerOwlHoot(at: number): void {
    if (!this.ctx || !this.nightGain) return;
    const baseAt = Math.max(this.ctx.currentTime + 0.012, at);
    const pan = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.35);
    const notes = [
      { offset: 0, dur: 0.32, startHz: 350, endHz: 318 },
      { offset: 0.52, dur: 0.15, startHz: 342, endHz: 332 },
      { offset: 0.74, dur: 0.38, startHz: 340, endHz: 298 },
    ];

    for (const note of notes) {
      const t = Math.max(this.ctx.currentTime + 0.012, baseAt + note.offset);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note.startHz, t);
      osc.frequency.exponentialRampToValueAtTime(note.endHz, t + note.dur);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 780;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.17, t + 0.055);
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

    this.scheduleBirdTone(at, 0.21, base, base * 0.98, 0.19, pan);
    this.scheduleBirdTone(at + 0.31, 0.27, base * 0.795, base * 0.78, 0.2, pan);
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
      this.scheduleBirdTone(cursor, dur, f0, f1, 0.16 + Math.random() * 0.06, pan);
      cursor += dur + 0.045 + Math.random() * 0.055;
    }
  }

  private triggerThrushCall(at: number): void {
    if (!this.ctx || !this.birdsGain) return;
    const pan = (Math.random() - 0.5) * 1.3;
    const root = 2420 + Math.random() * 480;

    this.scheduleBirdTone(at, 0.24, root, root * 1.04, 0.19, pan);
    this.scheduleBirdTone(at + 0.29, 0.12, root * 1.24, root * 1.32, 0.17, pan);
    this.scheduleBirdTone(at + 0.43, 0.14, root * 1.18, root * 1.09, 0.16, pan);
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

    const startAt = Math.max(this.ctx.currentTime + 0.012, at);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startHz, startAt);
    osc.frequency.exponentialRampToValueAtTime(endHz, startAt + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = (startHz + endHz) * 0.5;
    filter.Q.value = 1.2;

    const gain = this.ctx.createGain();
    const attack = Math.min(0.025, duration * 0.22);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(filter);
    filter.connect(gain);
    this.connectWithPan(gain, this.birdsGain, pan);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}
