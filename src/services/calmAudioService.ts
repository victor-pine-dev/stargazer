export type CalmAudioPreset = 'campfire-music' | 'campfire-only' | 'music-only';

export interface CalmAudioState {
  isPlaying: boolean;
  isMuted: boolean;
  volumePercent: number;
  preset: CalmAudioPreset;
}

const PAD_CHORDS_HZ: ReadonlyArray<readonly [number, number, number, number]> = [
  [146.83, 220.0, 277.18, 329.63], // Dmaj9 (D3, A3, C#4, E4)
  [123.47, 185.0, 246.94, 293.66], // Bm11  (B2, F#3, B3, D4)
  [98.0, 196.0, 246.94, 329.63],   // Gmaj9 (G2, G3, B3, E4)
  [110.0, 220.0, 277.18, 329.63],  // Aadd9 (A2, A3, C#4, E4)
];

const CHORD_INTERVAL_MS = 9000;

interface PadVoice {
  sine: OscillatorNode;
  triangle: OscillatorNode;
}

interface AudioGraphNodes {
  ctx: AudioContext;
  masterGain: GainNode;
  campfireBusGain: GainNode;
  musicBusGain: GainNode;
  noiseSource: AudioBufferSourceNode;
  lfoNodes: OscillatorNode[];
  padVoices: PadVoice[];
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/**
 * Generates a seamless 4-second stereo noise buffer:
 * - Ch 0: Warm brown/pink low-end hearth airflow
 * - Ch 1: Stochastic wood crackle & ember snap transients
 */
function createCampfireNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const durationSec = 4;
  const sampleCount = Math.floor(ctx.sampleRate * durationSec);
  const buffer = ctx.createBuffer(2, sampleCount, ctx.sampleRate);

  const rumbleData = buffer.getChannelData(0);
  const crackleData = buffer.getChannelData(1);

  let brown = 0;
  let crackleDecay = 0;
  let crackleSign = 1;

  for (let i = 0; i < sampleCount; i++) {
    const white = Math.random() * 2 - 1;
    // Leaky integrator for smooth brown/pink hearth roar
    brown = (brown + 0.028 * white) / 1.028;
    rumbleData[i] = Math.max(-1, Math.min(1, brown * 3.1));

    // Sparse stochastic ember pops & wood crackles
    const trigger = Math.random();
    if (trigger < 0.0014) {
      crackleDecay = 0.35 + Math.random() * 0.65;
      crackleSign = Math.random() < 0.5 ? -1 : 1;
    } else if (trigger < 0.0045) {
      crackleDecay = Math.max(crackleDecay, 0.08 + Math.random() * 0.18);
      crackleSign = Math.random() < 0.5 ? -1 : 1;
    }

    const impulse = crackleDecay * crackleSign * (0.55 + Math.random() * 0.45);
    crackleData[i] = Math.max(-1, Math.min(1, impulse + white * 0.018));
    crackleDecay *= 0.962;
  }

  // Crossfade edges slightly for click-free looping
  const fadeSamples = Math.min(512, Math.floor(sampleCount * 0.02));
  for (let i = 0; i < fadeSamples; i++) {
    const w = i / fadeSamples;
    const tailIdx = sampleCount - 1 - i;
    rumbleData[i] = rumbleData[i] * w + rumbleData[tailIdx] * (1 - w);
    crackleData[i] *= w;
    crackleData[tailIdx] *= w;
  }

  return buffer;
}

/**
 * Synthesizes a cozy crackling campfire + generative cosmic ambient pad using Web Audio API.
 */
export class CalmAudioController {
  private state: CalmAudioState = {
    isPlaying: false,
    isMuted: false,
    volumePercent: 65,
    preset: 'campfire-music',
  };

  private graph: AudioGraphNodes | null = null;
  private chordIndex = 0;
  private chordTimerId: number | null = null;

  getState(): CalmAudioState {
    return { ...this.state };
  }

  async start(): Promise<CalmAudioState> {
    this.state.isPlaying = true;

    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) {
      return this.getState();
    }

    if (!this.graph) {
      this.graph = this.buildAudioGraph(new AudioCtx());
    }

    const { ctx } = this.graph;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Ignore autoplay resume rejection until next user gesture
      }
    }

    this.applyGains();
    this.startChordProgressionTimer();
    return this.getState();
  }

  stop(): CalmAudioState {
    this.state.isPlaying = false;
    this.stopChordProgressionTimer();

    if (this.graph) {
      const { ctx, masterGain } = this.graph;
      const now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(0, now, 0.14);
    }

    return this.getState();
  }

  setMuted(muted: boolean): CalmAudioState {
    this.state.isMuted = muted;
    this.applyGains();
    return this.getState();
  }

  toggleMuted(): CalmAudioState {
    return this.setMuted(!this.state.isMuted);
  }

  setVolume(volumePercent: number): CalmAudioState {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    this.state.volumePercent = clamped;
    this.applyGains();
    return this.getState();
  }

  setPreset(preset: CalmAudioPreset): CalmAudioState {
    this.state.preset = preset;
    this.applyGains();
    return this.getState();
  }

  dispose(): void {
    this.stopChordProgressionTimer();
    this.state.isPlaying = false;

    if (!this.graph) return;
    const { ctx, noiseSource, lfoNodes, padVoices } = this.graph;
    try {
      noiseSource.stop();
    } catch {
      // Ignore already-stopped source
    }
    for (const lfo of lfoNodes) {
      try {
        lfo.stop();
      } catch {
        // Ignore already-stopped LFO
      }
    }
    for (const voice of padVoices) {
      try {
        voice.sine.stop();
        voice.triangle.stop();
      } catch {
        // Ignore already-stopped oscillator
      }
    }
    void ctx.close().catch(() => {});
    this.graph = null;
  }

  private buildAudioGraph(ctx: AudioContext): AudioGraphNodes {
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    // Gentle soft limiter/compressor on master output to prevent peaks
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // 1. Campfire Bus (Warm brown rumble + crackling ember snaps)
    const campfireBusGain = ctx.createGain();
    campfireBusGain.gain.value = 0;
    campfireBusGain.connect(masterGain);

    const noiseBuffer = createCampfireNoiseBuffer(ctx);
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const splitter = ctx.createChannelSplitter(2);
    noiseSource.connect(splitter);

    // Layer A: Warm hearth rumble (175 Hz lowpass + 0.28 Hz gentle LFO)
    const rumbleLowpass = ctx.createBiquadFilter();
    rumbleLowpass.type = 'lowpass';
    rumbleLowpass.frequency.value = 175;
    rumbleLowpass.Q.value = 0.65;

    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.42;

    const rumbleLfo = ctx.createOscillator();
    rumbleLfo.type = 'sine';
    rumbleLfo.frequency.value = 0.28;
    const rumbleLfoDepth = ctx.createGain();
    rumbleLfoDepth.gain.value = 0.1;
    rumbleLfo.connect(rumbleLfoDepth);
    rumbleLfoDepth.connect(rumbleGain.gain);

    splitter.connect(rumbleLowpass, 0);
    rumbleLowpass.connect(rumbleGain);
    rumbleGain.connect(campfireBusGain);

    // Layer B: Wood crackle & ember snap (900 Hz highpass -> 1650 Hz resonant bandpass)
    const crackleHighpass = ctx.createBiquadFilter();
    crackleHighpass.type = 'highpass';
    crackleHighpass.frequency.value = 900;

    const crackleBandpass = ctx.createBiquadFilter();
    crackleBandpass.type = 'bandpass';
    crackleBandpass.frequency.value = 1650;
    crackleBandpass.Q.value = 2.2;

    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0.34;

    splitter.connect(crackleHighpass, 1);
    crackleHighpass.connect(crackleBandpass);
    crackleBandpass.connect(crackleGain);
    crackleGain.connect(campfireBusGain);

    // 2. Ambient Stargazing Music Pad Bus
    const musicBusGain = ctx.createGain();
    musicBusGain.gain.value = 0;
    musicBusGain.connect(masterGain);

    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 520;
    padFilter.Q.value = 0.7;

    // Slow breathing LFO on pad warmth filter
    const padFilterLfo = ctx.createOscillator();
    padFilterLfo.type = 'sine';
    padFilterLfo.frequency.value = 0.09;
    const padFilterDepth = ctx.createGain();
    padFilterDepth.gain.value = 140;
    padFilterLfo.connect(padFilterDepth);
    padFilterDepth.connect(padFilter.frequency);

    // Stereo ping-pong / ambient tail delay (0.38s L, 0.52s R, lowpass-damped feedback 0.32)
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0.75;
    padFilter.connect(dryGain);
    dryGain.connect(musicBusGain);

    const delayL = ctx.createDelay(1.0);
    delayL.delayTime.value = 0.38;
    const delayR = ctx.createDelay(1.0);
    delayR.delayTime.value = 0.52;

    const feedbackDampL = ctx.createBiquadFilter();
    feedbackDampL.type = 'lowpass';
    feedbackDampL.frequency.value = 950;
    const feedbackDampR = ctx.createBiquadFilter();
    feedbackDampR.type = 'lowpass';
    feedbackDampR.frequency.value = 950;

    const fbGainL = ctx.createGain();
    fbGainL.gain.value = 0.32;
    const fbGainR = ctx.createGain();
    fbGainR.gain.value = 0.32;

    const wetMerger = ctx.createChannelMerger(2);
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.42;

    padFilter.connect(delayL);
    padFilter.connect(delayR);

    delayL.connect(feedbackDampL);
    feedbackDampL.connect(fbGainL);
    fbGainL.connect(delayR);

    delayR.connect(feedbackDampR);
    feedbackDampR.connect(fbGainR);
    fbGainR.connect(delayL);

    delayL.connect(wetMerger, 0, 0);
    delayR.connect(wetMerger, 0, 1);
    wetMerger.connect(wetGain);
    wetGain.connect(musicBusGain);

    const initialChord = PAD_CHORDS_HZ[0];
    const padVoices: PadVoice[] = initialChord.map((freq, idx) => {
      const sine = ctx.createOscillator();
      sine.type = 'sine';
      sine.frequency.value = freq;
      sine.detune.value = (idx - 1.5) * 3.5;

      const triangle = ctx.createOscillator();
      triangle.type = 'triangle';
      triangle.frequency.value = freq;
      triangle.detune.value = (1.5 - idx) * 5.0;

      const sineGain = ctx.createGain();
      sineGain.gain.value = idx === 0 ? 0.14 : 0.1;
      const triGain = ctx.createGain();
      triGain.gain.value = 0.045;

      sine.connect(sineGain);
      triangle.connect(triGain);
      sineGain.connect(padFilter);
      triGain.connect(padFilter);

      sine.start();
      triangle.start();
      return { sine, triangle };
    });

    noiseSource.start();
    rumbleLfo.start();
    padFilterLfo.start();

    return {
      ctx,
      masterGain,
      campfireBusGain,
      musicBusGain,
      noiseSource,
      lfoNodes: [rumbleLfo, padFilterLfo],
      padVoices,
    };
  }

  private startChordProgressionTimer(): void {
    if (this.chordTimerId !== null || typeof window === 'undefined') return;
    this.chordTimerId = window.setInterval(() => {
      this.advanceChord();
    }, CHORD_INTERVAL_MS);
  }

  private stopChordProgressionTimer(): void {
    if (this.chordTimerId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.chordTimerId);
      this.chordTimerId = null;
    }
  }

  private advanceChord(): void {
    if (!this.graph || !this.state.isPlaying) return;
    this.chordIndex = (this.chordIndex + 1) % PAD_CHORDS_HZ.length;
    const chord = PAD_CHORDS_HZ[this.chordIndex];
    const now = this.graph.ctx.currentTime;

    this.graph.padVoices.forEach((voice, idx) => {
      const freq = chord[idx] ?? chord[0];
      voice.sine.frequency.setTargetAtTime(freq, now, 1.8);
      voice.triangle.frequency.setTargetAtTime(freq, now, 1.8);
    });
  }

  private applyGains(): void {
    if (!this.graph) return;
    const { ctx, masterGain, campfireBusGain, musicBusGain } = this.graph;
    const now = ctx.currentTime;

    const effectiveMaster =
      !this.state.isPlaying || this.state.isMuted
        ? 0
        : (this.state.volumePercent / 100) * 0.85;

    const fireLevel =
      this.state.preset === 'music-only' ? 0 : 0.72;
    const musicLevel =
      this.state.preset === 'campfire-only' ? 0 : 0.56;

    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(effectiveMaster, now, 0.16);

    campfireBusGain.gain.cancelScheduledValues(now);
    campfireBusGain.gain.setTargetAtTime(fireLevel, now, 0.18);

    musicBusGain.gain.cancelScheduledValues(now);
    musicBusGain.gain.setTargetAtTime(musicLevel, now, 0.22);
  }
}
