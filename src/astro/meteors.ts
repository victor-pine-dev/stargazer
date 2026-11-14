import { altAzToWorldVector, DEG_TO_RAD, RAD_TO_DEG } from './coordinates';

export type MeteorRateMode = 'occasional' | 'shower' | 'fireballs';

export type MeteorShowerName =
  | 'Perseid'
  | 'Geminid'
  | 'Orionid'
  | 'Quadrantid'
  | 'Sporadic';

export interface ActiveMeteor {
  id: string;
  spawnedAtMs: number;
  durationMs: number;
  wakeHoldMs: number;
  startDir: [number, number, number];
  endDir: [number, number, number];
  colorHex: string;
  peakVmag: number;
  angularLengthDeg: number;
  showerName: MeteorShowerName;
}

export interface EvaluatedMeteorState {
  id: string;
  showerName: string;
  colorHex: string;
  peakVmag: number;
  headDir: [number, number, number];
  tailDir: [number, number, number];
  wakeOriginDir: [number, number, number];
  headProgress: number;
  headBrightness: number;
  wakeAlpha: number;
  isHeadActive: boolean;
}

export interface CalmModeSnapshot {
  enabled: boolean;
  zenHud: boolean;
  meteorRate: MeteorRateMode;
  meteorsSpotted: number;
  activeMeteorCount: number;
  lastMeteorLabel: string | null;
}

export interface SpawnMeteorOptions {
  nowMs: number;
  cameraAzDeg: number;
  cameraAltDeg: number;
  rateMode?: MeteorRateMode;
  forceFireball?: boolean;
  random?: () => number;
  idSuffix?: number;
}

const SHOWER_NAMES: readonly MeteorShowerName[] = [
  'Perseid',
  'Geminid',
  'Orionid',
  'Quadrantid',
  'Sporadic',
];

const METEOR_COLORS: readonly string[] = [
  '#6ee7b7', // Emerald Mg/O atmospheric ionization
  '#7dd3fc', // Cyan-white fast Perseid/Orionid streak
  '#fde68a', // Warm sodium amber fireball
  '#c4b5fd', // Violet-white nitrogen emission
];

const RATE_INTERVAL_RANGES_MS: Record<MeteorRateMode, [number, number]> = {
  occasional: [4500, 9500],
  shower: [1800, 4200],
  fireballs: [900, 2200],
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Spherical linear interpolation between two 3D unit vectors.
 */
export function slerpUnitVectors(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const u = clamp01(t);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));

  if (dot > 0.9995) {
    const lx = a[0] + (b[0] - a[0]) * u;
    const ly = a[1] + (b[1] - a[1]) * u;
    const lz = a[2] + (b[2] - a[2]) * u;
    const len = Math.hypot(lx, ly, lz) || 1;
    return [lx / len, ly / len, lz / len];
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta) || 1e-6;
  const wA = Math.sin((1 - u) * theta) / sinTheta;
  const wB = Math.sin(u * theta) / sinTheta;

  const x = a[0] * wA + b[0] * wB;
  const y = a[1] * wA + b[1] * wB;
  const z = a[2] * wA + b[2] * wB;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Generates a realistic meteor trajectory visible within the observer's upper sky hemisphere.
 */
export function spawnMeteorTrajectory(options: SpawnMeteorOptions): ActiveMeteor {
  const rnd = options.random ?? Math.random;
  const rateMode = options.rateMode ?? 'shower';
  const isFireball =
    Boolean(options.forceFireball) ||
    (rateMode === 'fireballs' ? rnd() < 0.72 : rateMode === 'shower' ? rnd() < 0.24 : rnd() < 0.14);

  const azJitterDeg = (rnd() * 2 - 1) * 52;
  const startAzDeg = normalizeDeg360(options.cameraAzDeg + azJitterDeg);

  const minStartAlt = Math.max(22, Math.min(68, options.cameraAltDeg + 12));
  const startAltDeg = minStartAlt + rnd() * Math.max(4, 78 - minStartAlt);

  // Diagonal downward arc covering ~14-32 deg across the sky while staying well above the horizon
  const targetArcDeg = 14 + rnd() * 18;
  const maxAllowedDrop = Math.max(6, startAltDeg - 7);
  const altDropDeg = Math.min(maxAllowedDrop, targetArcDeg * (0.48 + rnd() * 0.36));
  const endAltDeg = Math.max(7, startAltDeg - altDropDeg);

  const midAltRad = ((startAltDeg + endAltDeg) * 0.5) * DEG_TO_RAD;
  const cosMidAlt = Math.max(0.28, Math.cos(midAltRad));
  const horizDegNeeded = Math.sqrt(Math.max(16, targetArcDeg * targetArcDeg - altDropDeg * altDropDeg));
  const azDirection = rnd() < 0.5 ? -1 : 1;
  const endAzDeg = normalizeDeg360(startAzDeg + (azDirection * horizDegNeeded) / cosMidAlt);

  const startDir = altAzToWorldVector(startAltDeg, startAzDeg);
  const endDir = altAzToWorldVector(endAltDeg, endAzDeg);
  const dot = Math.max(
    -1,
    Math.min(1, startDir[0] * endDir[0] + startDir[1] * endDir[1] + startDir[2] * endDir[2]),
  );
  const angularLengthDeg = Math.acos(dot) * RAD_TO_DEG;

  const durationMs = isFireball ? 850 + rnd() * 550 : 500 + rnd() * 650;
  const wakeHoldMs = isFireball ? 1150 + rnd() * 350 : 900 + rnd() * 420;
  const peakVmag = isFireball ? -(1.5 + rnd() * 2.3) : -1.2 + rnd() * 3.0;

  const showerName = SHOWER_NAMES[Math.floor(rnd() * SHOWER_NAMES.length) % SHOWER_NAMES.length];
  const colorHex = isFireball
    ? rnd() < 0.55
      ? '#fde68a'
      : '#6ee7b7'
    : METEOR_COLORS[Math.floor(rnd() * METEOR_COLORS.length) % METEOR_COLORS.length];

  const suffix = options.idSuffix ?? Math.floor(rnd() * 100_000);
  return {
    id: `meteor-${Math.round(options.nowMs)}-${suffix}`,
    spawnedAtMs: options.nowMs,
    durationMs,
    wakeHoldMs,
    startDir,
    endDir,
    colorHex,
    peakVmag,
    angularLengthDeg,
    showerName,
  };
}

/**
 * Evaluates a meteor's instantaneous sky head/tail/wake vectors and brightness at `nowMs`.
 */
export function evaluateMeteorState(
  meteor: ActiveMeteor,
  nowMs: number,
): EvaluatedMeteorState | null {
  const ageMs = nowMs - meteor.spawnedAtMs;
  if (ageMs < 0 || ageMs > meteor.durationMs + meteor.wakeHoldMs) {
    return null;
  }

  const headProgress = clamp01(ageMs / Math.max(1, meteor.durationMs));
  const isHeadActive = ageMs < meteor.durationMs;

  let tailProgress: number;
  let headBrightness: number;
  let wakeAlpha: number;

  if (isHeadActive) {
    tailProgress = clamp01(headProgress - 0.38);
    // Smooth entry, terminal flare around u=0.68, crisp ablation cutoff toward u=1.0
    const entryRamp = clamp01(headProgress / 0.16);
    const flare = Math.exp(-Math.pow((headProgress - 0.68) / 0.24, 2));
    const burnoutTail = 1 - clamp01((headProgress - 0.86) / 0.14);
    headBrightness = clamp01((0.38 + 0.62 * flare) * entryRamp * burnoutTail);
    wakeAlpha = clamp01(0.45 + 0.55 * entryRamp);
  } else {
    const wakeElapsed = ageMs - meteor.durationMs;
    const wakeFrac = clamp01(wakeElapsed / Math.max(1, meteor.wakeHoldMs));
    tailProgress = clamp01(0.62 + wakeFrac * 0.38);
    headBrightness = 0;
    wakeAlpha = clamp01(Math.pow(1 - wakeFrac, 1.45));
  }

  const wakeOriginProgress = clamp01(headProgress - 0.65);

  return {
    id: meteor.id,
    showerName: meteor.showerName,
    colorHex: meteor.colorHex,
    peakVmag: meteor.peakVmag,
    headDir: slerpUnitVectors(meteor.startDir, meteor.endDir, headProgress),
    tailDir: slerpUnitVectors(meteor.startDir, meteor.endDir, tailProgress),
    wakeOriginDir: slerpUnitVectors(meteor.startDir, meteor.endDir, wakeOriginProgress),
    headProgress,
    headBrightness,
    wakeAlpha,
    isHeadActive,
  };
}

/**
 * Manages stochastic and on-demand shooting stars for Calm / Relax Mode.
 */
export class MeteorShowerController {
  private activeMeteors: ActiveMeteor[] = [];
  private rateMode: MeteorRateMode = 'shower';
  private meteorsSpotted = 0;
  private lastMeteorLabel: string | null = null;
  private nextSpawnPerfMs = 0;
  private sequenceCounter = 0;

  setRateMode(mode: MeteorRateMode, nowMs = performance.now()): void {
    this.rateMode = mode;
    this.scheduleNextSpawn(nowMs);
  }

  getRateMode(): MeteorRateMode {
    return this.rateMode;
  }

  getMeteorsSpotted(): number {
    return this.meteorsSpotted;
  }

  getLastMeteorLabel(): string | null {
    return this.lastMeteorLabel;
  }

  getActiveCount(): number {
    return this.activeMeteors.length;
  }

  scheduleWelcomeMeteor(nowMs: number, delayMs = 600): void {
    this.nextSpawnPerfMs = nowMs + delayMs;
  }

  clear(): void {
    this.activeMeteors = [];
    this.nextSpawnPerfMs = 0;
  }

  private scheduleNextSpawn(nowMs: number): void {
    const [minMs, maxMs] = RATE_INTERVAL_RANGES_MS[this.rateMode];
    this.nextSpawnPerfMs = nowMs + minMs + Math.random() * (maxMs - minMs);
  }

  private recordMeteor(meteor: ActiveMeteor): void {
    this.activeMeteors.push(meteor);
    if (this.activeMeteors.length > 12) {
      this.activeMeteors.shift();
    }
    this.meteorsSpotted += 1;
    const tag = meteor.peakVmag <= -1.5 ? 'Fireball' : meteor.showerName;
    this.lastMeteorLabel = `${tag} (m ${meteor.peakVmag.toFixed(1)})`;
  }

  triggerWishMeteor(nowMs: number, cameraAzDeg: number, cameraAltDeg: number): ActiveMeteor {
    this.sequenceCounter += 1;
    const meteor = spawnMeteorTrajectory({
      nowMs,
      cameraAzDeg,
      cameraAltDeg,
      rateMode: this.rateMode,
      forceFireball: true,
      idSuffix: this.sequenceCounter,
    });
    this.recordMeteor(meteor);
    this.scheduleNextSpawn(nowMs);
    return meteor;
  }

  update(
    nowMs: number,
    enabled: boolean,
    cameraAzDeg: number,
    cameraAltDeg: number,
    reducedMotion = false,
  ): EvaluatedMeteorState[] {
    if (enabled && !reducedMotion) {
      if (this.nextSpawnPerfMs === 0) {
        this.scheduleNextSpawn(nowMs);
      } else if (nowMs >= this.nextSpawnPerfMs) {
        this.sequenceCounter += 1;
        const meteor = spawnMeteorTrajectory({
          nowMs,
          cameraAzDeg,
          cameraAltDeg,
          rateMode: this.rateMode,
          idSuffix: this.sequenceCounter,
        });
        this.recordMeteor(meteor);
        this.scheduleNextSpawn(nowMs);
      }
    }

    const evaluated: EvaluatedMeteorState[] = [];
    const stillAlive: ActiveMeteor[] = [];

    for (const meteor of this.activeMeteors) {
      if (nowMs < meteor.spawnedAtMs) {
        stillAlive.push(meteor);
        if (meteor.spawnedAtMs - nowMs <= 50) {
          const state = evaluateMeteorState(meteor, meteor.spawnedAtMs);
          if (state) evaluated.push(state);
        }
        continue;
      }
      const state = evaluateMeteorState(meteor, nowMs);
      if (state) {
        stillAlive.push(meteor);
        evaluated.push(state);
      }
    }

    this.activeMeteors = stillAlive;
    return evaluated;
  }
}
