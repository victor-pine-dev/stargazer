import { raDecToJ2000UnitVector } from '../astro/coordinates';

export interface NamedStarEntry {
  hip: number;
  name: string;
  bayer: string;
  flam: string;
  const: string;
  mag: number;
  bv: number;
  raRad: number;
  decRad: number;
}

export interface ConstellationRecord {
  id: string;
  name: string;
  genitive: string;
  rank: number;
  labelRaRad: number;
  labelDecRad: number;
  lines: Array<Array<[number, number]>>;
  bounds: Array<Array<[number, number]>>;
}

export interface StarCatalogData {
  count: number;
  /** Packed J2000 unit directions [x, y, z] per star */
  positionsJ2000: Float32Array;
  /** Packed per-star metadata [Vmag, BV_color, scintillationPhase, HIP_id] */
  starMeta: Float32Array;
  /** Packed RA/Dec radians [raRad, decRad] per star */
  raDec: Float32Array;
}

export interface LoadedCelestialData {
  stars: StarCatalogData;
  constellations: ConstellationRecord[];
  starNames: Map<number, NamedStarEntry>;
  namedStarList: NamedStarEntry[];
}

/**
 * Deterministically hashes an integer star index / HIP ID into [0, 2*PI) for twinkling phase.
 */
function deterministicPhase(index: number, hip: number): number {
  const seed = Math.sin(index * 12.9898 + hip * 78.233) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return frac * Math.PI * 2;
}

/**
 * Parses the binary stars.bin buffer (5 little-endian Float32 values per star:
 * [RA_rad, Dec_rad, Vmag, BV_color, HIP_id]).
 */
export function parseStarBinary(buffer: ArrayBuffer): StarCatalogData {
  const floatsPerStar = 5;
  const bytesPerStar = floatsPerStar * 4;
  const count = Math.floor(buffer.byteLength / bytesPerStar);
  const view = new DataView(buffer);

  const positionsJ2000 = new Float32Array(count * 3);
  const starMeta = new Float32Array(count * 4);
  const raDec = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const base = i * bytesPerStar;
    const raRad = view.getFloat32(base + 0, true);
    const decRad = view.getFloat32(base + 4, true);
    const vmag = view.getFloat32(base + 8, true);
    const bv = view.getFloat32(base + 12, true);
    const hip = view.getFloat32(base + 16, true);

    const [vx, vy, vz] = raDecToJ2000UnitVector(raRad, decRad);

    const pIdx = i * 3;
    positionsJ2000[pIdx] = vx;
    positionsJ2000[pIdx + 1] = vy;
    positionsJ2000[pIdx + 2] = vz;

    const mIdx = i * 4;
    starMeta[mIdx] = vmag;
    starMeta[mIdx + 1] = bv;
    starMeta[mIdx + 2] = deterministicPhase(i, hip);
    starMeta[mIdx + 3] = hip;

    const rIdx = i * 2;
    raDec[rIdx] = raRad;
    raDec[rIdx + 1] = decRad;
  }

  return {
    count,
    positionsJ2000,
    starMeta,
    raDec,
  };
}

/**
 * Fetches stars.bin, constellations.json, and star-names.json in parallel.
 */
export async function loadCelestialCatalog(): Promise<LoadedCelestialData> {
  const [binRes, constRes, namesRes] = await Promise.all([
    fetch('/data/stars.bin'),
    fetch('/data/constellations.json'),
    fetch('/data/star-names.json'),
  ]);

  if (!binRes.ok || !constRes.ok || !namesRes.ok) {
    throw new Error(
      `Failed to load celestial data (stars: ${binRes.status}, constellations: ${constRes.status}, names: ${namesRes.status})`,
    );
  }

  const [starBuffer, constellations, namesJson] = await Promise.all([
    binRes.arrayBuffer(),
    constRes.json() as Promise<ConstellationRecord[]>,
    namesRes.json() as Promise<Record<string, NamedStarEntry>>,
  ]);

  const stars = parseStarBinary(starBuffer);
  const starNames = new Map<number, NamedStarEntry>();
  const namedStarList: NamedStarEntry[] = [];

  for (const entry of Object.values(namesJson)) {
    starNames.set(entry.hip, entry);
    if (entry.name && entry.mag <= 3.0) {
      namedStarList.push(entry);
    }
  }
  namedStarList.sort((a, b) => a.mag - b.mag);

  return {
    stars,
    constellations,
    starNames,
    namedStarList,
  };
}
