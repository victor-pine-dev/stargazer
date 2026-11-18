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
const AMBIENT_LOOP_SECONDS = 8;
const FADE_SECONDS = 0.45;
const SILENT_WAV_SAMPLE_RATE = 22050;
const SILENT_WAV_SAMPLES = 5512; // 0.25s digital silence for iOS playback session unlock
const CRACKLE_VARIANT_COUNT = 12;
const WOOD_POP_VARIANT_COUNT = 6;

let cachedSilentWavDataUri: string | null = null;

/**
 * Applies a constant-0-dB-peak RBJ 2nd-order bandpass filter, clamping cutoff
 * below 42% of the sample rate for unconditional stability on 16 kHz+ devices.
 */
export function applyBiquadBandpass(
  input: Float32Array,
  fc: number,
  q: number,
  sampleRate: number,
): Float32Array {
  const safeSr = Math.max(8000, sampleRate || 44100);
  const safeFc = Math.max(20, Math.min(fc, safeSr * 0.42));
  const safeQ = Math.max(0.1, q);
  const w0 = (2 * Math.PI * safeFc) / safeSr;
  const sinW = Math.sin(w0);
  const cosW = Math.cos(w0);
  const alpha = sinW / (2 * safeQ);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;

  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i] ?? 0;
    const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * Applies a sample-rate-invariant 1-pole lowpass filter with safe Nyquist clamping.
 */
export function applyOnePoleLowpass(
  input: Float32Array,
  fc: number,
  sampleRate: number,
): Float32Array {
  const safeSr = Math.max(8000, sampleRate || 44100);
  const safeFc = Math.max(20, Math.min(fc, safeSr * 0.42));
  const a = Math.exp((-2 * Math.PI * safeFc) / safeSr);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i += 1) {
    y = y * a + (input[i] ?? 0) * (1 - a);
    out[i] = y;
  }
  return out;
}

/**
 * Builds a C1-continuous soft-limiter transfer curve: unity gain inside [-0.7, 0.7]
 * and smooth hyperbolic saturation above -3.1 dBFS, bounded within [-0.95, 0.95].
 */
export function buildSoftLimiterCurve(samples = 1025): Float32Array<ArrayBuffer> {
  const count = Math.max(3, Math.floor(samples));
  const curve = new Float32Array(new ArrayBuffer(count * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < count; i += 1) {
    const x = (i / (count - 1)) * 2 - 1;
    const absX = Math.abs(x);
    if (absX <= 0.7) {
      curve[i] = x;
    } else {
      curve[i] = Math.sign(x) * (0.7 + 0.25 * Math.tanh((absX - 0.7) / 0.25));
    }
  }
  return curve;
}

/**
 * Synthesizes an 8-second seamless warm flame bed (75-520 Hz) with organic
 * breath modulation, zero baked impulses, zero white-noise hiss, and ~-23.3 dBFS RMS.
 */
export function synthesizeFlameBedSamples(
  sampleRate: number,
  durationSeconds = AMBIENT_LOOP_SECONDS,
): Float32Array {
  const safeSr = Math.max(8000, sampleRate || 44100);
  const frameCount = Math.max(1, Math.floor(safeSr * durationSeconds));
  const fadeFrames = Math.min(Math.floor(frameCount * 0.25), Math.floor(safeSr * 0.4));
  const totalFrames = frameCount + fadeFrames;
  const raw = new Float32Array(totalFrames);

  const aHp75 = Math.exp((-2 * Math.PI * Math.min(75, safeSr * 0.42)) / safeSr);
  const aHp175 = Math.exp((-2 * Math.PI * Math.min(175, safeSr * 0.42)) / safeSr);
  const aLp240 = Math.exp((-2 * Math.PI * Math.min(240, safeSr * 0.42)) / safeSr);
  const aLp520 = Math.exp((-2 * Math.PI * Math.min(520, safeSr * 0.42)) / safeSr);
  const aEnvSlow = Math.exp((-2 * Math.PI * 1.6) / safeSr);
  const aEnvLick = Math.exp((-2 * Math.PI * 4.2) / safeSr);

  let lpA1 = 0;
  let lpA2 = 0;
  let lpB1 = 0;
  let lpB2 = 0;
  let lpB3 = 0;
  let hp75In = 0;
  let hp75Out = 0;
  let hp175In = 0;
  let hp175Out = 0;
  let envSlow = 0;
  let envLick = 0;

  for (let i = 0; i < totalFrames; i += 1) {
    const w1 = Math.random() * 2 - 1;
    const w2 = Math.random() * 2 - 1;

    envSlow = envSlow * aEnvSlow + (Math.random() * 2 - 1) * (1 - aEnvSlow);
    envLick = envLick * aEnvLick + (Math.random() * 2 - 1) * (1 - aEnvLick);
    const t = i / safeSr;
    const breath =
      0.78 +
      0.16 * Math.sin(2 * Math.PI * 0.25 * t) +
      0.1 * Math.sin(2 * Math.PI * 0.625 * t + 1.1);
    const mod = Math.max(0.35, Math.min(1.35, breath + envSlow * 1.7 + envLick * 0.65));

    // Hearth low warmth (75-240 Hz)
    lpA1 = lpA1 * aLp240 + w1 * (1 - aLp240);
    lpA2 = lpA2 * aLp240 + lpA1 * (1 - aLp240);
    const hp75 = aHp75 * (hp75Out + lpA2 - hp75In);
    hp75In = lpA2;
    hp75Out = hp75;

    // Lapping flame mid warmth (175-520 Hz, 3-pole LPF for clean phone presence without hiss)
    lpB1 = lpB1 * aLp520 + w2 * (1 - aLp520);
    lpB2 = lpB2 * aLp520 + lpB1 * (1 - aLp520);
    lpB3 = lpB3 * aLp520 + lpB2 * (1 - aLp520);
    const hp175 = aHp175 * (hp175Out + lpB3 - hp175In);
    hp175In = lpB3;
    hp175Out = hp175;

    raw[i] = (hp75 * 1.15 + hp175 * 1.45) * mod;
  }

  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    if (i < fadeFrames) {
      const p = i / fadeFrames;
      out[i] =
        (raw[i] ?? 0) * Math.sin(p * Math.PI * 0.5) +
        (raw[frameCount + i] ?? 0) * Math.cos(p * Math.PI * 0.5);
    } else {
      out[i] = raw[i] ?? 0;
    }
  }

  let mean = 0;
  for (let i = 0; i < frameCount; i += 1) mean += out[i] ?? 0;
  mean /= frameCount;
  let sumSq = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const centered = (out[i] ?? 0) - mean;
    out[i] = centered;
    sumSq += centered * centered;
  }
  const rms = Math.sqrt(sumSq / frameCount) || 1;
  const gain = 0.068 / rms;
  for (let i = 0; i < frameCount; i += 1) {
    out[i] = Math.max(-0.28, Math.min(0.28, (out[i] ?? 0) * gain));
  }
  return out;
}

function finalizeTransientSamples(
  out: Float32Array,
  targetPeak: number,
  edgeCap: number,
): Float32Array {
  const len = out.length;
  const edgeN = Math.max(1, Math.min(edgeCap, Math.floor(len / 6)));
  const win = new Float32Array(len);
  let sumOut = 0;
  let sumWin = 0;

  for (let i = 0; i < len; i += 1) {
    const edge =
      i < edgeN ? i / edgeN : i > len - 1 - edgeN ? (len - 1 - i) / edgeN : 1;
    win[i] = edge;
    const weighted = (out[i] ?? 0) * edge;
    out[i] = weighted;
    sumOut += weighted;
    sumWin += edge;
  }

  const dcRatio = sumWin > 0 ? sumOut / sumWin : 0;
  let peak = 0;
  for (let i = 0; i < len; i += 1) {
    const centered = (out[i] ?? 0) - dcRatio * (win[i] ?? 0);
    out[i] = centered;
    const absVal = Math.abs(centered);
    if (absVal > peak) peak = absVal;
  }

  const scale = peak > 1e-6 ? targetPeak / peak : 0;
  for (let i = 0; i < len; i += 1) {
    out[i] = (out[i] ?? 0) * scale;
  }
  out[0] = 0;
  out[len - 1] = 0;
  return out;
}

/**
 * Synthesizes one of 12 dry-wood/ember crackle transients (variants 9-11 are
 * double-fracture crackles) with smooth endpoints, zero DC, and warm phone voicing.
 */
export function synthesizeCrackleSamples(
  sampleRate: number,
  variantIndex: number,
): Float32Array {
  const safeSr = Math.max(8000, sampleRate || 44100);
  const idx =
    ((Math.floor(variantIndex) % CRACKLE_VARIANT_COUNT) + CRACKLE_VARIANT_COUNT) %
    CRACKLE_VARIANT_COUNT;
  const isDouble = idx >= 9;
  const durSec = isDouble ? 0.026 + (idx - 9) * 0.005 : 0.012 + (idx / 9) * 0.013;
  const len = Math.max(64, Math.floor(safeSr * durSec));
  const rawNoise = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    rawNoise[i] = Math.random() * 2 - 1;
  }

  const fcHi = Math.min(1000 + ((idx * 173) % 1450), safeSr * 0.14);
  const qHi = 1.0 + (idx % 4) * 0.22;
  const fcBody = Math.min(450 + ((idx * 97) % 420), safeSr * 0.1);
  const hiBand = applyOnePoleLowpass(
    applyOnePoleLowpass(applyBiquadBandpass(rawNoise, fcHi, qHi, safeSr), 3000, safeSr),
    3000,
    safeSr,
  );
  const bodyBand = applyBiquadBandpass(rawNoise, fcBody, 1.35, safeSr);

  const out = new Float32Array(len);
  const attackSec = 0.0008 + (idx % 3) * 0.00025;
  const tau = 0.002 + (idx % 5) * 0.0008;
  const secondOffset = isDouble ? Math.floor(len * (0.34 + (idx - 9) * 0.07)) : -1;
  const tailStart = Math.floor(len * 0.68);

  for (let i = 0; i < len; i += 1) {
    const t = i / safeSr;
    let env =
      t < attackSec
        ? 0.5 * (1 - Math.cos((Math.PI * t) / attackSec))
        : Math.exp(-(t - attackSec) / tau);
    if (isDouble && i >= secondOffset) {
      const t2 = (i - secondOffset) / safeSr;
      const env2 =
        t2 < attackSec
          ? 0.5 * (1 - Math.cos((Math.PI * t2) / attackSec))
          : Math.exp(-(t2 - attackSec) / (tau * 0.85));
      env = Math.min(1, env + env2 * 0.72);
    }
    if (i >= tailStart) {
      const u = (i - tailStart) / Math.max(1, len - 1 - tailStart);
      env *= 0.5 * (1 + Math.cos(Math.PI * u));
    }
    out[i] = ((hiBand[i] ?? 0) * 0.68 + (bodyBand[i] ?? 0) * 0.55) * env;
  }

  return finalizeTransientSamples(out, 0.62, 20);
}

/**
 * Synthesizes one of 6 hollow dry-wood pop transients combining a damped woody
 * cavity resonance with a filtered onset snap, zero-padded at both boundaries.
 */
export function synthesizeWoodPopSamples(
  sampleRate: number,
  variantIndex: number,
): Float32Array {
  const safeSr = Math.max(8000, sampleRate || 44100);
  const idx =
    ((Math.floor(variantIndex) % WOOD_POP_VARIANT_COUNT) + WOOD_POP_VARIANT_COUNT) %
    WOOD_POP_VARIANT_COUNT;
  const durSec = 0.028 + idx * 0.004;
  const len = Math.max(64, Math.floor(safeSr * durSec));
  const rawNoise = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    rawNoise[i] = Math.random() * 2 - 1;
  }

  const snapFc = Math.min(1100 + idx * 140, safeSr * 0.14);
  const snapRaw = applyOnePoleLowpass(
    applyBiquadBandpass(rawNoise, snapFc, 1.2, safeSr),
    2800,
    safeSr,
  );
  let snapPeak = 0;
  for (let i = 0; i < len; i += 1) {
    const absVal = Math.abs(snapRaw[i] ?? 0);
    if (absVal > snapPeak) snapPeak = absVal;
  }
  const snapNorm = snapPeak > 1e-6 ? 1 / snapPeak : 0;

  const out = new Float32Array(len);
  const f0 = 260 + idx * 38;
  const f1 = f0 * 0.78;
  const attackSec = 0.0016;
  const tauBody = 0.0065 + idx * 0.0011;
  const tauSnap = 0.0026;
  const tailStart = Math.floor(len * 0.7);
  let phase1 = 0;
  let phase2 = 0;

  for (let i = 0; i < len; i += 1) {
    const t = i / safeSr;
    const frac = Math.min(1, t / 0.016);
    const freq = f0 + (f1 - f0) * frac;
    phase1 += (2 * Math.PI * freq) / safeSr;
    phase2 += (2 * Math.PI * freq * 1.58) / safeSr;

    const atk = t < attackSec ? 0.5 * (1 - Math.cos((Math.PI * t) / attackSec)) : 1;
    const bodyEnv = atk * Math.exp(-t / tauBody);
    const snapEnv =
      t < 0.0008
        ? 0.5 * (1 - Math.cos((Math.PI * t) / 0.0008))
        : Math.exp(-(t - 0.0008) / tauSnap);
    const tail =
      i >= tailStart
        ? 0.5 * (1 + Math.cos((Math.PI * (i - tailStart)) / Math.max(1, len - 1 - tailStart)))
        : 1;

    const wood =
      Math.sin(phase1) * 0.62 +
      Math.sin(phase2) * 0.22 * Math.exp(-t / (tauBody * 0.5));
    const snap = (snapRaw[i] ?? 0) * snapNorm * snapEnv * 0.72;
    out[i] = (wood * bodyEnv * 0.62 + snap) * tail;
  }

  return finalizeTransientSamples(out, 0.6, 24);
}

function safeDisconnect(...nodes: Array<AudioNode | null | undefined>): void {
  for (const node of nodes) {
    if (!node) continue;
    try {
      if (typeof node.disconnect === 'function') {
        node.disconnect();
      }
    } catch {
      // Ignore already-disconnected or mocked nodes.
    }
  }
}

function bindVoiceCleanup(
  source: AudioScheduledSourceNode,
  ...nodes: Array<AudioNode | null | undefined>
): void {
  source.onended = () => {
    source.onended = null;
    safeDisconnect(source, ...nodes);
  };
}

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
  private crackleBuffers: AudioBuffer[] = [];
  private woodPopBuffers: AudioBuffer[] = [];
  private firePanLanes: AudioNode[] = [];
  private lastCrackleIdx = -1;
  private lastWoodPopIdx = -1;
  private keepAliveAudio: HTMLAudioElement | null = null;
  private schedulerId: number | null = null;
  private gestureUnlockBound = false;

  private nextFireAt = 0;
  private nextClusterAt = 0;
  private nextWoodPopAt = 0;
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
      if (this.ctx && (this.ctx.state as string) !== 'running') {
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
      if (this.ctx && (this.ctx.state as string) !== 'running') {
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
      if (this.ctx && (this.ctx.state as string) !== 'running') {
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
    safeDisconnect(
      this.fireLoopSource,
      ...this.firePanLanes,
      this.fireGain,
      this.nightGain,
      this.birdsGain,
      this.masterGain,
    );
    this.fireLoopSource = null;
    this.crackleBuffers = [];
    this.woodPopBuffers = [];
    this.firePanLanes = [];
    this.lastCrackleIdx = -1;
    this.lastWoodPopIdx = -1;

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

    if (this.keepAliveAudio && this.keepAliveAudio.paused !== false) {
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
      bindVoiceCleanup(unlockSource);
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

    let mixDestination: AudioNode = masterGain;
    if (typeof ctx.createWaveShaper === 'function') {
      const limiter = ctx.createWaveShaper();
      limiter.curve = buildSoftLimiterCurve();
      try {
        limiter.oversample = '2x';
      } catch {
        // Ignore read-only oversample stubs.
      }
      limiter.connect(masterGain);
      mixDestination = limiter;
    }

    if (typeof ctx.createDynamicsCompressor === 'function') {
      const compressor = ctx.createDynamicsCompressor();
      if (compressor.threshold) compressor.threshold.value = -12;
      if (compressor.knee) compressor.knee.value = 14;
      if (compressor.ratio) compressor.ratio.value = 5;
      if (compressor.attack) compressor.attack.value = 0.003;
      if (compressor.release) compressor.release.value = 0.16;
      compressor.connect(mixDestination);
      mixDestination = compressor;
    }

    const fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    fireGain.connect(mixDestination);
    this.fireGain = fireGain;

    const nightGain = ctx.createGain();
    nightGain.gain.value = 0;
    nightGain.connect(mixDestination);
    this.nightGain = nightGain;

    const birdsGain = ctx.createGain();
    birdsGain.gain.value = 0;
    birdsGain.connect(mixDestination);
    this.birdsGain = birdsGain;

    const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
    const fireHighpass = ctx.createBiquadFilter();
    fireHighpass.type = 'highpass';
    fireHighpass.frequency.value = Math.min(75, sampleRate * 0.42);
    if (fireHighpass.Q) fireHighpass.Q.value = 0.707;

    const fireLowpass = ctx.createBiquadFilter();
    fireLowpass.type = 'lowpass';
    fireLowpass.frequency.value = Math.min(3400, sampleRate * 0.42);
    if (fireLowpass.Q) fireLowpass.Q.value = 0.65;

    fireHighpass.connect(fireLowpass);
    fireLowpass.connect(fireGain);

    if (typeof ctx.createStereoPanner === 'function') {
      this.firePanLanes = [-0.28, 0, 0.28].map((pan) => {
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        panner.connect(fireHighpass);
        return panner;
      });
    } else {
      this.firePanLanes = [fireHighpass];
    }

    this.crackleBuffers = Array.from({ length: CRACKLE_VARIANT_COUNT }, (_, idx) =>
      this.buildBufferFromSamples(ctx, synthesizeCrackleSamples(sampleRate, idx)),
    );
    this.woodPopBuffers = Array.from({ length: WOOD_POP_VARIANT_COUNT }, (_, idx) =>
      this.buildBufferFromSamples(ctx, synthesizeWoodPopSamples(sampleRate, idx)),
    );

    const bedSamples = synthesizeFlameBedSamples(sampleRate, AMBIENT_LOOP_SECONDS);
    const fireBuffer = this.buildBufferFromSamples(ctx, bedSamples);
    const fireSource = ctx.createBufferSource();
    fireSource.buffer = fireBuffer;
    fireSource.loop = true;
    fireSource.connect(fireHighpass);
    fireSource.start();
    this.fireLoopSource = fireSource;
  }

  private buildBufferFromSamples(ctx: AudioContext, samples: Float32Array): AudioBuffer {
    const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
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
    const effectiveMaster = !this.isPlaying || this.isMuted ? 0 : (this.volumePercent / 100) * 0.88;

    const hasFire =
      this.preset === 'fire-night' ||
      this.preset === 'fire-birds' ||
      this.preset === 'fire-only';
    const hasNight = this.preset === 'fire-night' || this.preset === 'night-only';
    const hasBirds = this.preset === 'fire-birds' || this.preset === 'birds-only';

    const fireLevel = hasFire ? 0.82 : 0;
    const nightLevel = hasNight ? 0.82 : 0;
    const birdsLevel = hasBirds ? 0.82 : 0;

    this.masterGain.gain.setTargetAtTime(effectiveMaster, now, 0.12);
    this.fireGain.gain.setTargetAtTime(fireLevel, now, FADE_SECONDS);
    this.nightGain.gain.setTargetAtTime(nightLevel, now, FADE_SECONDS);
    this.birdsGain.gain.setTargetAtTime(birdsLevel, now, FADE_SECONDS);
  }

  private resetScheduleHorizons(now: number): void {
    this.nextFireAt = now + 0.02 + Math.random() * 0.08;
    this.nextClusterAt = now + 1.0 + Math.random() * 1.4;
    this.nextWoodPopAt = now + 0.8 + Math.random() * 1.6;
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
    if (this.nextWoodPopAt < now) this.nextWoodPopAt = now + 0.2;
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
        this.triggerFireCrackle(this.nextFireAt);
        if (Math.random() < 0.35) {
          this.triggerFireCrackle(this.nextFireAt + 0.026 + Math.random() * 0.042, 0.62);
        }
        this.nextFireAt += 0.18 + Math.random() * 0.38;
      }

      if (this.nextClusterAt < horizon) {
        this.triggerCrackleCluster(this.nextClusterAt);
        this.nextClusterAt = Math.max(horizon, this.nextClusterAt) + 1.8 + Math.random() * 2.6;
      }

      if (this.nextWoodPopAt < horizon) {
        this.triggerWoodPop(this.nextWoodPopAt);
        if (Math.random() < 0.45) {
          this.triggerFireCrackle(this.nextWoodPopAt + 0.045 + Math.random() * 0.065, 0.55);
        }
        this.nextWoodPopAt = Math.max(horizon, this.nextWoodPopAt) + 1.6 + Math.random() * 2.6;
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

  private connectWithPan(source: AudioNode, target: AudioNode, pan: number): AudioNode | null {
    if (!this.ctx) return null;
    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      source.connect(panner);
      panner.connect(target);
      return panner;
    }
    source.connect(target);
    return null;
  }

  private triggerBufferedFireVoice(
    buffers: AudioBuffer[],
    lastIdx: number,
    at: number,
    gainMin: number,
    gainMax: number,
    rateMin: number,
    rateMax: number,
    amplitudeScale: number,
  ): number {
    if (!this.ctx || !this.fireGain || buffers.length === 0) return lastIdx;

    let idx = Math.floor(Math.random() * buffers.length);
    if (buffers.length > 1 && idx === lastIdx) {
      idx = (idx + 1 + Math.floor(Math.random() * (buffers.length - 1))) % buffers.length;
    }
    const buffer = buffers[idx];
    if (!buffer) return lastIdx;

    const startAt = Math.max(this.ctx.currentTime + 0.012, at);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (src.playbackRate) {
      src.playbackRate.value = rateMin + Math.random() * (rateMax - rateMin);
    }

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = (gainMin + Math.random() * (gainMax - gainMin)) * amplitudeScale;

    const lane =
      this.firePanLanes[Math.floor(Math.random() * this.firePanLanes.length)] ?? this.fireGain;
    src.connect(voiceGain);
    voiceGain.connect(lane);
    bindVoiceCleanup(src, voiceGain);
    src.start(startAt);
    return idx;
  }

  private triggerFireCrackle(at: number, amplitudeScale = 1): void {
    this.lastCrackleIdx = this.triggerBufferedFireVoice(
      this.crackleBuffers,
      this.lastCrackleIdx,
      at,
      0.24,
      0.65,
      0.88,
      1.12,
      amplitudeScale,
    );
  }

  private triggerWoodPop(at: number, amplitudeScale = 1): void {
    this.lastWoodPopIdx = this.triggerBufferedFireVoice(
      this.woodPopBuffers,
      this.lastWoodPopIdx,
      at,
      0.32,
      0.6,
      0.9,
      1.1,
      amplitudeScale,
    );
  }

  private triggerCrackleCluster(at: number): void {
    if (!this.ctx || !this.fireGain) return;

    const count = 2 + Math.floor(Math.random() * 3);
    let cursor = Math.max(this.ctx.currentTime + 0.012, at);
    for (let i = 0; i < count; i += 1) {
      const taper = 1 - i * 0.14;
      const scale = (0.3 + Math.random() * 0.32) * Math.max(0.45, taper);
      this.triggerFireCrackle(cursor, scale);
      cursor += 0.032 + Math.random() * 0.056;
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
    gain.gain.value = 0;
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
    const panner = this.connectWithPan(gain, this.nightGain, voice.pan);
    bindVoiceCleanup(osc, bandpass, gain, panner);

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
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.011);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.058);

      osc.connect(gain);
      const panner = this.connectWithPan(gain, this.nightGain, pan);
      bindVoiceCleanup(osc, gain, panner);
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
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.17, t + 0.055);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);

      osc.connect(filter);
      filter.connect(gain);
      const panner = this.connectWithPan(gain, this.nightGain, pan);
      bindVoiceCleanup(osc, filter, gain, panner);
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
    gain.gain.value = 0;
    const attack = Math.min(0.025, duration * 0.22);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(filter);
    filter.connect(gain);
    const panner = this.connectWithPan(gain, this.birdsGain, pan);
    bindVoiceCleanup(osc, filter, gain, panner);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}
