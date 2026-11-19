import {
  degreesLat,
  degreesLong,
  degreesToRadians,
  ecfToEci,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  geodeticToEcf,
  gstime,
  jday,
  propagate,
  radiansToDegrees,
  shadowFraction,
  sunPos,
  twoline2satrec,
  type EciVec3,
  type Kilometer,
  type SatRec,
} from 'satellite.js';
import type { ObserverLocation } from '../services/locationService';
import {
  altAzToWorldVector,
  azimuthToCardinal,
  computeSunPosition,
  TWO_PI,
} from './coordinates';

export const ISS_NORAD_ID = 25544;

const TLE_CACHE_KEY = 'stargazer.tleCache.v1';
const TLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CELESTRAK_URLS = [
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
];

export type SatelliteCategory =
  | 'Space Station'
  | 'Space Telescope'
  | 'Earth Observation'
  | 'Visual Satellite';

export type TleSourceKind = 'celestrak-live' | 'celestrak-cache' | 'embedded';

export interface SatelliteTleRecord {
  noradId: number;
  id: string;
  name: string;
  shortName: string;
  category: SatelliteCategory;
  line1: string;
  line2: string;
  baseMag: number;
  colorHex: string;
  description: string;
}

export interface SatelliteTelemetryState {
  noradId: number;
  id: string;
  name: string;
  shortName: string;
  category: SatelliteCategory;
  altDeg: number;
  azDeg: number;
  azCardinal: string;
  raRad: number;
  decRad: number;
  rangeKm: number;
  altitudeKm: number;
  speedKmS: number;
  subLatDeg: number;
  subLonDeg: number;
  vmag: number;
  isSunlit: boolean;
  shadowFraction: number;
  isAboveHorizon: boolean;
  colorHex: string;
  description: string;
  worldDir: [number, number, number];
}

export interface SatelliteOrbitArcPoint {
  altDeg: number;
  azDeg: number;
  worldDir: [number, number, number];
  isSunlit: boolean;
  timeOffsetSec: number;
}

export interface SatellitePassPrediction {
  noradId: number;
  satName: string;
  startTimeMs: number;
  startAzDeg: number;
  startCardinal: string;
  maxTimeMs: number;
  maxAltDeg: number;
  maxAzDeg: number;
  maxCardinal: string;
  endTimeMs: number;
  endAzDeg: number;
  endCardinal: string;
  durationSec: number;
  isSunlit: boolean;
  peakVmag: number;
  quality: 'Visible Pass' | 'Daylight / Eclipsed';
}

export interface SatelliteSystemSnapshot {
  timestampMs: number;
  tleSource: TleSourceKind;
  satellites: SatelliteTelemetryState[];
  issArc: SatelliteOrbitArcPoint[];
  selectedArc: SatelliteOrbitArcPoint[];
  selectedNoradId: number | null;
  issPasses: SatellitePassPrediction[];
}

export type SatelliteWorkerRequest =
  | {
      type: 'init';
      records: SatelliteTleRecord[];
      tleSource: TleSourceKind;
      timestampMs: number;
      location: ObserverLocation;
      selectedNoradId: number | null;
    }
  | {
      type: 'updateTles';
      records: SatelliteTleRecord[];
      tleSource: TleSourceKind;
      timestampMs: number;
      location: ObserverLocation;
      selectedNoradId: number | null;
    }
  | {
      type: 'propagate';
      timestampMs: number;
      location: ObserverLocation;
      selectedNoradId: number | null;
      recomputePasses?: boolean;
    };

export type SatelliteWorkerResponse = {
  type: 'snapshot';
  snapshot: SatelliteSystemSnapshot;
};

export const DEFAULT_SATELLITE_TLES: SatelliteTleRecord[] = [
  {
    noradId: 25544,
    id: 'sat-25544',
    name: 'ISS (ZARYA)',
    shortName: 'ISS',
    category: 'Space Station',
    line1: '1 25544U 98067A   26318.30312735  .00009396  00000+0  17615-3 0  9993',
    line2: '2 25544  51.6324 277.2306 0007380  24.2289 335.9045 15.49368089595028',
    baseMag: -1.8,
    colorHex: '#38bdf8',
    description:
      'International Space Station orbiting at ~418 km altitude with 109-meter solar arrays.',
  },
  {
    noradId: 48274,
    id: 'sat-48274',
    name: 'CSS (TIANHE)',
    shortName: 'Tiangong',
    category: 'Space Station',
    line1: '1 48274U 21035A   26317.54115615  .00018078  00000+0  20631-3 0  9991',
    line2: '2 48274  41.4674 134.3818 0004386 302.2376  57.8037 15.61773849316499',
    baseMag: -0.6,
    colorHex: '#22d3ee',
    description:
      'Tiangong Space Station core module Tianhe in a 41.5° low-Earth inclination orbit.',
  },
  {
    noradId: 20580,
    id: 'sat-20580',
    name: 'HST',
    shortName: 'Hubble',
    category: 'Space Telescope',
    line1: '1 20580U 90037B   26317.88852192  .00005681  00000+0  16962-3 0  9992',
    line2: '2 20580  28.4708 136.2383 0002298  24.6781 335.3925 15.32290088811548',
    baseMag: 1.6,
    colorHex: '#a78bfa',
    description:
      'Hubble Space Telescope orbiting at ~520 km in a 28.5° low-latitude inclination.',
  },
  {
    noradId: 53807,
    id: 'sat-53807',
    name: 'BLUEWALKER-3',
    shortName: 'BlueWalker 3',
    category: 'Visual Satellite',
    line1: '1 53807U 22111AL  26317.46950096  .00008321  00000+0  21544-3 0  9990',
    line2: '2 53807  53.2292  52.2504 0004153 286.3124  73.7425 15.39951915233199',
    baseMag: 0.8,
    colorHex: '#f472b6',
    description:
      'Large 64 m² phased-array communications demonstrator capable of bright twilight flares.',
  },
  {
    noradId: 27386,
    id: 'sat-27386',
    name: 'ENVISAT',
    shortName: 'Envisat',
    category: 'Earth Observation',
    line1: '1 27386U 02009A   26318.38330508  .00000110  00000+0  49559-4 0  9994',
    line2: '2 27386  98.4043 266.4850 0001249  81.5332  87.3121 14.39094895295083',
    baseMag: 2.1,
    colorHex: '#fbbf24',
    description:
      'Massive 8-ton ESA Earth-observation spacecraft in a high-inclination sun-synchronous orbit.',
  },
  {
    noradId: 16908,
    id: 'sat-16908',
    name: 'AJISAI (EGS)',
    shortName: 'Ajisai',
    category: 'Visual Satellite',
    line1: '1 16908U 86061A   26318.40253850 -.00000104  00000+0 -47921-4 0  9995',
    line2: '2 16908  50.0114  45.4836 0011334 202.1480 285.4621 12.44517686499099',
    baseMag: 2.0,
    colorHex: '#34d399',
    description:
      'Japanese geodetic sphere covered in 318 mirrors producing rapid naked-eye glints.',
  },
  {
    noradId: 22220,
    id: 'sat-22220',
    name: 'SL-16 R/B',
    shortName: 'SL-16 R/B',
    category: 'Visual Satellite',
    line1: '1 22220U 92076B   26318.26322019 -.00000204  00000+0 -77881-4 0  9999',
    line2: '2 22220  71.0016  22.6383 0010495  70.6248 347.0892 14.16887946757180',
    baseMag: 2.2,
    colorHex: '#fb923c',
    description:
      'Zenit-2 upper rocket stage in a 71° orbit, consistently among the brightest night-sky passes.',
  },
  {
    noradId: 25994,
    id: 'sat-25994',
    name: 'TERRA',
    shortName: 'Terra',
    category: 'Earth Observation',
    line1: '1 25994U 99068A   26318.39030904  .00000351  00000+0  80266-4 0  9993',
    line2: '2 25994  97.9264   1.8351 0003553 107.9618 262.6373 14.61197334431549',
    baseMag: 2.8,
    colorHex: '#60a5fa',
    description:
      'NASA EOS flagship climate-monitoring satellite in a morning sun-synchronous orbit.',
  },
  {
    noradId: 27424,
    id: 'sat-27424',
    name: 'AQUA',
    shortName: 'Aqua',
    category: 'Earth Observation',
    line1: '1 27424U 02022A   26318.48237645  .00000799  00000+0  16824-3 0  9992',
    line2: '2 27424  98.4493 290.9370 0001173 107.6453  46.2261 14.62280053305231',
    baseMag: 2.9,
    colorHex: '#38bdf8',
    description:
      'NASA Earth-science spacecraft studying global precipitation and atmospheric water vapor.',
  },
  {
    noradId: 41335,
    id: 'sat-41335',
    name: 'SENTINEL-3A',
    shortName: 'Sentinel-3A',
    category: 'Earth Observation',
    line1: '1 41335U 16011A   26318.43472370  .00000100  00000+0  59396-4 0  9991',
    line2: '2 41335  98.6296  23.6484 0001219  85.2139 274.9181 14.26735525559489',
    baseMag: 3.2,
    colorHex: '#818cf8',
    description:
      'Copernicus oceanography and land-monitoring mission flying at ~800 km sun-synchronous altitude.',
  },
];

const satrecCache = new Map<string, SatRec>();

function getSatRec(record: SatelliteTleRecord): SatRec {
  const key = `${record.line1}\n${record.line2}`;
  let cached = satrecCache.get(key);
  if (!cached) {
    cached = twoline2satrec(record.line1, record.line2);
    satrecCache.set(key, cached);
  }
  return cached;
}

function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Parses a CelesTrak 3-line (or 2-line) TLE text payload into a Map keyed by NORAD catalog number.
 */
export function parseThreeLineTleText(
  raw: string,
): Map<number, { name: string; line1: string; line2: string }> {
  const result = new Map<number, { name: string; line1: string; line2: string }>();
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  let i = 0;
  while (i < lines.length) {
    const curr = lines[i];
    const next = lines[i + 1];
    const next2 = lines[i + 2];

    if (
      !curr.startsWith('1 ') &&
      !curr.startsWith('2 ') &&
      next?.startsWith('1 ') &&
      next2?.startsWith('2 ')
    ) {
      const noradId = Number(next.slice(2, 7).trim());
      if (Number.isFinite(noradId) && noradId > 0) {
        result.set(noradId, {
          name: curr.trim(),
          line1: next,
          line2: next2,
        });
      }
      i += 3;
      continue;
    }

    if (curr.startsWith('1 ') && next?.startsWith('2 ')) {
      const noradId = Number(curr.slice(2, 7).trim());
      if (Number.isFinite(noradId) && noradId > 0) {
        result.set(noradId, {
          name: `SAT ${noradId}`,
          line1: curr,
          line2: next,
        });
      }
      i += 2;
      continue;
    }

    i += 1;
  }

  return result;
}

/**
 * Merges updated TLE lines into the curated satellite catalog while preserving display metadata.
 */
export function mergeTleUpdates(
  base: SatelliteTleRecord[],
  rawText: string,
): { records: SatelliteTleRecord[]; updatedCount: number } {
  const parsed = parseThreeLineTleText(rawText);
  let updatedCount = 0;

  const records = base.map((entry) => {
    const match = parsed.get(entry.noradId);
    if (!match) return entry;
    updatedCount += 1;
    return {
      ...entry,
      name: match.name || entry.name,
      line1: match.line1,
      line2: match.line2,
    };
  });

  return { records, updatedCount };
}

/**
 * Propagates a single satellite via SGP4 for an instant and observer site.
 */
export function propagateSatelliteState(
  record: SatelliteTleRecord,
  date: Date,
  location: ObserverLocation,
  sunVecEciAu?: EciVec3<number>,
): SatelliteTelemetryState | null {
  const satrec = getSatRec(record);
  const pv = propagate(satrec, date);
  if (!pv || !pv.position || !pv.velocity) {
    return null;
  }

  const posEci = pv.position as EciVec3<Kilometer>;
  const velEci = pv.velocity;
  const gmst = gstime(date);

  const observerGd = {
    longitude: degreesToRadians(location.longitude),
    latitude: degreesToRadians(location.latitude),
    height: location.elevation / 1000,
  };

  const posEcf = eciToEcf(posEci, gmst);
  const look = ecfToLookAngles(observerGd, posEcf);
  const satGeodetic = eciToGeodetic(posEci, gmst);

  const altDeg = radiansToDegrees(look.elevation);
  const azDeg = normalizeDeg360(radiansToDegrees(look.azimuth));
  const rangeKm = look.rangeSat;
  const altitudeKm = satGeodetic.height;
  const speedKmS = Math.hypot(velEci.x, velEci.y, velEci.z);

  const subLatDeg = degreesLat(satGeodetic.latitude);
  const subLonDeg = degreesLong(satGeodetic.longitude);

  const observerEci = ecfToEci(geodeticToEcf(observerGd), gmst);
  const topoX = posEci.x - observerEci.x;
  const topoY = posEci.y - observerEci.y;
  const topoZ = posEci.z - observerEci.z;
  const topoLen = Math.hypot(topoX, topoY, topoZ) || 1;
  const raRad = ((Math.atan2(topoY, topoX) % TWO_PI) + TWO_PI) % TWO_PI;
  const decRad = Math.asin(Math.max(-1, Math.min(1, topoZ / topoLen)));

  const rsun = sunVecEciAu ?? sunPos(jday(date)).rsun;
  const rawShadow = shadowFraction(rsun, posEci);
  const shadowFrac = Number.isFinite(rawShadow) ? Math.max(0, Math.min(1, rawShadow)) : 0;
  const isSunlit = shadowFrac < 0.5;

  const rangeMagOffset = 5 * Math.log10(Math.max(120, rangeKm) / 1000);
  const shadowDimming = shadowFrac * 6.5;
  const vmag = Math.max(-4.8, Math.min(12.0, record.baseMag + rangeMagOffset + shadowDimming));

  return {
    noradId: record.noradId,
    id: record.id,
    name: record.name,
    shortName: record.shortName,
    category: record.category,
    altDeg,
    azDeg,
    azCardinal: azimuthToCardinal(azDeg),
    raRad,
    decRad,
    rangeKm,
    altitudeKm,
    speedKmS,
    subLatDeg,
    subLonDeg,
    vmag,
    isSunlit,
    shadowFraction: shadowFrac,
    isAboveHorizon: altDeg > -0.5,
    colorHex: record.colorHex,
    description: record.description,
    worldDir: altAzToWorldVector(altDeg, azDeg),
  };
}

/**
 * Propagates every tracked satellite for the given timestamp and observer coordinates.
 */
export function propagateAllSatellites(
  records: SatelliteTleRecord[],
  date: Date,
  location: ObserverLocation,
): SatelliteTelemetryState[] {
  const rsun = sunPos(jday(date)).rsun;
  const results: SatelliteTelemetryState[] = [];
  for (const record of records) {
    const state = propagateSatelliteState(record, date, location, rsun);
    if (state) {
      results.push(state);
    }
  }
  return results;
}

/**
 * Samples a continuous sky-dome orbital trajectory arc centered around `centerDate` (±halfSpanMinutes).
 */
export function computeSatelliteOrbitArc(
  record: SatelliteTleRecord,
  centerDate: Date,
  location: ObserverLocation,
  halfSpanMinutes = 46,
  stepSec = 45,
): SatelliteOrbitArcPoint[] {
  const centerMs = centerDate.getTime();
  const halfSpanSec = Math.round(halfSpanMinutes * 60);
  const points: SatelliteOrbitArcPoint[] = [];

  for (let offsetSec = -halfSpanSec; offsetSec <= halfSpanSec; offsetSec += stepSec) {
    const sampleDate = new Date(centerMs + offsetSec * 1000);
    const state = propagateSatelliteState(record, sampleDate, location);
    if (!state) continue;
    points.push({
      altDeg: state.altDeg,
      azDeg: state.azDeg,
      worldDir: state.worldDir,
      isSunlit: state.isSunlit,
      timeOffsetSec: offsetSec,
    });
  }

  return points;
}

function refineHorizonCrossing(
  record: SatelliteTleRecord,
  tLowMs: number,
  tHighMs: number,
  rising: boolean,
  location: ObserverLocation,
): { timeMs: number; azDeg: number; altDeg: number } {
  let lo = tLowMs;
  let hi = tHighMs;
  for (let iter = 0; iter < 7; iter++) {
    const mid = (lo + hi) * 0.5;
    const state = propagateSatelliteState(record, new Date(mid), location);
    if (!state) break;
    const above = state.altDeg >= 0;
    if (rising ? above : !above) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const timeMs = Math.round((lo + hi) * 0.5);
  const finalState = propagateSatelliteState(record, new Date(timeMs), location);
  return {
    timeMs,
    azDeg: finalState?.azDeg ?? 0,
    altDeg: finalState?.altDeg ?? 0,
  };
}

/**
 * Predicts upcoming local satellite passes peaking above `minPeakAltDeg` within the forecast window.
 */
export function predictUpcomingPasses(
  record: SatelliteTleRecord,
  startDate: Date,
  location: ObserverLocation,
  options?: {
    hoursAhead?: number;
    stepSec?: number;
    minPeakAltDeg?: number;
    maxPasses?: number;
  },
): SatellitePassPrediction[] {
  const hoursAhead = options?.hoursAhead ?? 36;
  const stepSec = options?.stepSec ?? 20;
  const minPeakAltDeg = options?.minPeakAltDeg ?? 10;
  const maxPasses = options?.maxPasses ?? 10;

  const startWindowMs = startDate.getTime();
  // Look 15 min earlier so an active in-progress pass captures its true rise time
  const scanBeginMs = startWindowMs - 15 * 60 * 1000;
  const scanEndMs = startWindowMs + hoursAhead * 3_600_000;
  const stepMs = stepSec * 1000;

  const passes: SatellitePassPrediction[] = [];
  let inPass = false;
  let passStartMs = scanBeginMs;
  let passStartAzDeg = 0;
  let coarseMaxMs = scanBeginMs;
  let coarseMaxAlt = -90;
  let prevState: SatelliteTelemetryState | null = null;
  let prevMs = scanBeginMs;

  for (let tMs = scanBeginMs; tMs <= scanEndMs; tMs += stepMs) {
    const state = propagateSatelliteState(record, new Date(tMs), location);
    if (!state) continue;

    if (!inPass && state.altDeg >= 0) {
      inPass = true;
      if (prevState && prevState.altDeg < 0) {
        const rise = refineHorizonCrossing(record, prevMs, tMs, true, location);
        passStartMs = rise.timeMs;
        passStartAzDeg = rise.azDeg;
      } else {
        passStartMs = tMs;
        passStartAzDeg = state.azDeg;
      }
      coarseMaxMs = tMs;
      coarseMaxAlt = state.altDeg;
    } else if (inPass && state.altDeg >= 0) {
      if (state.altDeg > coarseMaxAlt) {
        coarseMaxAlt = state.altDeg;
        coarseMaxMs = tMs;
      }
    } else if (inPass && state.altDeg < 0) {
      const setCrossing = refineHorizonCrossing(record, prevMs, tMs, false, location);
      inPass = false;

      if (setCrossing.timeMs > startWindowMs && coarseMaxAlt >= minPeakAltDeg) {
        let bestPeakState = propagateSatelliteState(record, new Date(coarseMaxMs), location);
        let bestPeakMs = coarseMaxMs;
        for (let dt = -stepSec * 1000; dt <= stepSec * 1000; dt += 2000) {
          const probeMs = coarseMaxMs + dt;
          const probe = propagateSatelliteState(record, new Date(probeMs), location);
          if (probe && (!bestPeakState || probe.altDeg > bestPeakState.altDeg)) {
            bestPeakState = probe;
            bestPeakMs = probeMs;
          }
        }

        if (bestPeakState && bestPeakState.altDeg >= minPeakAltDeg) {
          const sunAtPeak = computeSunPosition(
            new Date(bestPeakMs),
            location.latitude,
            location.longitude,
            location.elevation,
          );
          const isOpticallyVisible = bestPeakState.isSunlit && sunAtPeak.altDeg < -4;

          passes.push({
            noradId: record.noradId,
            satName: record.name,
            startTimeMs: passStartMs,
            startAzDeg: passStartAzDeg,
            startCardinal: azimuthToCardinal(passStartAzDeg),
            maxTimeMs: bestPeakMs,
            maxAltDeg: bestPeakState.altDeg,
            maxAzDeg: bestPeakState.azDeg,
            maxCardinal: azimuthToCardinal(bestPeakState.azDeg),
            endTimeMs: setCrossing.timeMs,
            endAzDeg: setCrossing.azDeg,
            endCardinal: azimuthToCardinal(setCrossing.azDeg),
            durationSec: Math.max(1, Math.round((setCrossing.timeMs - passStartMs) / 1000)),
            isSunlit: bestPeakState.isSunlit,
            peakVmag: bestPeakState.vmag,
            quality: isOpticallyVisible ? 'Visible Pass' : 'Daylight / Eclipsed',
          });

          if (passes.length >= maxPasses) {
            break;
          }
        }
      }
    }

    prevState = state;
    prevMs = tMs;
  }

  return passes;
}

interface StoredTleCache {
  fetchedAtMs: number;
  records: SatelliteTleRecord[];
}

function isValidCachedTleRecord(raw: unknown): raw is SatelliteTleRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.noradId === 'number' &&
    Number.isFinite(r.noradId) &&
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.line1 === 'string' &&
    typeof r.line2 === 'string' &&
    typeof r.baseMag === 'number' &&
    Number.isFinite(r.baseMag)
  );
}

function readCachedTles(allowExpired = false): SatelliteTleRecord[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(TLE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTleCache>;
    if (
      !parsed ||
      !Array.isArray(parsed.records) ||
      typeof parsed.fetchedAtMs !== 'number' ||
      !Number.isFinite(parsed.fetchedAtMs)
    ) {
      return null;
    }
    if (!allowExpired && Date.now() - parsed.fetchedAtMs > TLE_CACHE_TTL_MS) {
      return null;
    }
    const validRecords = parsed.records.filter(isValidCachedTleRecord);
    return validRecords.length > 0 ? validRecords : null;
  } catch {
    return null;
  }
}

function writeCachedTles(records: SatelliteTleRecord[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const payload: StoredTleCache = {
      fetchedAtMs: Date.now(),
      records,
    };
    localStorage.setItem(TLE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

/**
 * Fetches live CelesTrak GP TLE elements for space stations and bright visual satellites,
 * caching results for 2 hours and gracefully falling back to embedded TLEs offline.
 */
export async function fetchLiveCelesTrakTles(forceRefresh = false): Promise<{
  records: SatelliteTleRecord[];
  source: TleSourceKind;
  updatedCount: number;
}> {
  if (!forceRefresh) {
    const freshCache = readCachedTles(false);
    if (freshCache && freshCache.length > 0) {
      return {
        records: freshCache,
        source: 'celestrak-cache',
        updatedCount: freshCache.length,
      };
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const responses = await Promise.allSettled(
      CELESTRAK_URLS.map(async (url) => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.text();
      }),
    );
    clearTimeout(timeoutId);

    const combinedText = responses
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value)
      .join('\n');

    if (combinedText.trim().length > 0) {
      const merged = mergeTleUpdates(DEFAULT_SATELLITE_TLES, combinedText);
      if (merged.updatedCount > 0) {
        writeCachedTles(merged.records);
        return {
          records: merged.records,
          source: 'celestrak-live',
          updatedCount: merged.updatedCount,
        };
      }
    }
  } catch {
    // Network/CORS offline fallback handled below
  }

  const staleCache = readCachedTles(true);
  if (staleCache && staleCache.length > 0) {
    return {
      records: staleCache,
      source: 'celestrak-cache',
      updatedCount: staleCache.length,
    };
  }

  return {
    records: DEFAULT_SATELLITE_TLES,
    source: 'embedded',
    updatedCount: 0,
  };
}

/**
 * Coordinates background SGP4 propagation, orbital arcs, and pass predictions via Web Worker
 * with synchronous fallback in non-Worker environments.
 */
export class SatelliteTrackerController {
  private worker: Worker | null = null;
  private records: SatelliteTleRecord[] = DEFAULT_SATELLITE_TLES;
  private tleSource: TleSourceKind = 'embedded';
  private snapshot: SatelliteSystemSnapshot;
  private readonly onSnapshot?: (snapshot: SatelliteSystemSnapshot) => void;

  private lastPropagateDispatchMs = 0;
  private lastPassTimestampMs = 0;
  private lastPassLocationKey = '';
  private workerBusy = false;

  constructor(
    initialLocation: ObserverLocation,
    initialTimestampMs: number,
    onSnapshot?: (snapshot: SatelliteSystemSnapshot) => void,
  ) {
    this.onSnapshot = onSnapshot;
    this.snapshot = this.computeSyncSnapshot(
      initialTimestampMs,
      initialLocation,
      null,
      true,
    );
    this.lastPassTimestampMs = initialTimestampMs;
    this.lastPassLocationKey = `${initialLocation.latitude.toFixed(3)},${initialLocation.longitude.toFixed(3)}`;

    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('../workers/satelliteWorker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.addEventListener('message', (event: MessageEvent<SatelliteWorkerResponse>) => {
          this.workerBusy = false;
          if (event.data?.type === 'snapshot') {
            this.snapshot = event.data.snapshot;
            this.onSnapshot?.(this.snapshot);
          }
        });
        this.worker.addEventListener('error', () => {
          this.workerBusy = false;
          this.worker?.terminate();
          this.worker = null;
        });

        const initMsg: SatelliteWorkerRequest = {
          type: 'init',
          records: this.records,
          tleSource: this.tleSource,
          timestampMs: initialTimestampMs,
          location: initialLocation,
          selectedNoradId: null,
        };
        this.worker.postMessage(initMsg);
      } catch {
        this.worker = null;
      }
    }
  }

  private computeSyncSnapshot(
    timestampMs: number,
    location: ObserverLocation,
    selectedNoradId: number | null,
    recomputePasses: boolean,
  ): SatelliteSystemSnapshot {
    const date = new Date(timestampMs);
    const satellites = propagateAllSatellites(this.records, date, location);
    const issRec = this.records.find((r) => r.noradId === ISS_NORAD_ID) ?? this.records[0];
    const issArc = issRec ? computeSatelliteOrbitArc(issRec, date, location) : [];
    const selectedRec =
      selectedNoradId && selectedNoradId !== ISS_NORAD_ID
        ? this.records.find((r) => r.noradId === selectedNoradId)
        : undefined;
    const selectedArc = selectedRec ? computeSatelliteOrbitArc(selectedRec, date, location) : [];
    const issPasses =
      recomputePasses && issRec
        ? predictUpcomingPasses(issRec, date, location)
        : this.snapshot?.issPasses ?? [];

    return {
      timestampMs,
      tleSource: this.tleSource,
      satellites,
      issArc,
      selectedArc,
      selectedNoradId,
      issPasses,
    };
  }

  getSnapshot(): SatelliteSystemSnapshot {
    return this.snapshot;
  }

  getRecords(): SatelliteTleRecord[] {
    return this.records;
  }

  requestUpdate(
    timestampMs: number,
    location: ObserverLocation,
    selectedNoradId: number | null,
    forceImmediate = false,
  ): void {
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const locKey = `${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
    const needsPasses =
      locKey !== this.lastPassLocationKey ||
      Math.abs(timestampMs - this.lastPassTimestampMs) > 20 * 60 * 1000 ||
      this.snapshot.issPasses.length === 0;

    if (!forceImmediate && nowPerf - this.lastPropagateDispatchMs < 110) {
      return;
    }
    if (this.worker && this.workerBusy && !forceImmediate) {
      return;
    }

    this.lastPropagateDispatchMs = nowPerf;
    if (needsPasses) {
      this.lastPassLocationKey = locKey;
      this.lastPassTimestampMs = timestampMs;
    }

    if (this.worker) {
      this.workerBusy = true;
      const req: SatelliteWorkerRequest = {
        type: 'propagate',
        timestampMs,
        location,
        selectedNoradId,
        recomputePasses: needsPasses,
      };
      this.worker.postMessage(req);
      return;
    }

    this.snapshot = this.computeSyncSnapshot(timestampMs, location, selectedNoradId, needsPasses);
    this.onSnapshot?.(this.snapshot);
  }

  async refreshTles(
    location: ObserverLocation,
    timestampMs: number,
    selectedNoradId: number | null,
    forceFetch = false,
  ): Promise<{ source: TleSourceKind; updatedCount: number }> {
    const res = await fetchLiveCelesTrakTles(forceFetch);
    this.records = res.records;
    this.tleSource = res.source;
    this.lastPassTimestampMs = timestampMs;
    this.lastPassLocationKey = `${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;

    if (this.worker) {
      this.workerBusy = true;
      const msg: SatelliteWorkerRequest = {
        type: 'updateTles',
        records: this.records,
        tleSource: this.tleSource,
        timestampMs,
        location,
        selectedNoradId,
      };
      this.worker.postMessage(msg);
    } else {
      this.snapshot = this.computeSyncSnapshot(timestampMs, location, selectedNoradId, true);
      this.onSnapshot?.(this.snapshot);
    }

    return { source: res.source, updatedCount: res.updatedCount };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
