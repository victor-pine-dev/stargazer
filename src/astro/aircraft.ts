import {
  degreesToRadians,
  ecfToLookAngles,
  geodeticToEcf,
  radiansToDegrees,
} from 'satellite.js';
import * as THREE from 'three';
import type { ObserverLocation } from '../services/locationService';
import {
  altAzToWorldVector,
  azimuthToCardinal,
  computeEquatorialToWorldMatrix4,
  DEG_TO_RAD,
  TWO_PI,
} from './coordinates';

const EARTH_RADIUS_KM = 6371.0088;
const FT_TO_KM = 0.0003048;
const FT_TO_M = 0.3048;
const METERS_TO_FEET = 3.280839895013123;
const KNOTS_TO_KM_PER_SEC = 1.852 / 3600;
const KNOTS_TO_KMH = 1.852;
const MPS_TO_KNOTS = 1.9438444924406048;
const MPS_TO_FPM = 196.8503937007874;

const ADSB_CACHE_KEY = 'stargazer.adsbCache.v1';
const ADSB_CACHE_TTL_MS = 90 * 1000;
const ADSB_POLL_INTERVAL_MS = 8000;
const ADSB_SEARCH_RADIUS_NM = 65;

export type AdsbSourceKind =
  | 'adsb-fi'
  | 'adsb-lol'
  | 'opensky'
  | 'adsb-cache'
  | 'simulated-corridor';

export type AircraftFlightPhase = 'Climbing' | 'Descending' | 'Cruising';

export interface RawAdsbAircraftRecord {
  hex: string;
  callsign: string;
  registration: string;
  typeCode: string;
  modelDesc: string;
  operator: string;
  latDeg: number;
  lonDeg: number;
  altBaroFt: number;
  altGeomFt: number;
  groundSpeedKt: number;
  trackDeg: number;
  verticalRateFpm: number;
  squawk: string;
  category: string;
  fetchedAtMs: number;
}

export interface AircraftTrailPoint {
  altDeg: number;
  azDeg: number;
  worldDir: [number, number, number];
  timeOffsetSec: number;
}

export interface AircraftTrackPoint {
  altDeg: number;
  azDeg: number;
  worldDir: [number, number, number];
  timeOffsetSec: number;
}

export interface AircraftTelemetryState {
  id: string;
  hex: string;
  callsign: string;
  displayName: string;
  registration: string;
  typeCode: string;
  modelDesc: string;
  operator: string;
  flightPhase: AircraftFlightPhase;
  altitudeFt: number;
  altitudeKm: number;
  flightLevel: string;
  groundSpeedKt: number;
  speedKmh: number;
  trackDeg: number;
  trackCardinal: string;
  verticalRateFpm: number;
  squawk: string;
  category: string;
  isHeavy: boolean;
  latDeg: number;
  lonDeg: number;
  altDeg: number;
  azDeg: number;
  azCardinal: string;
  raRad: number;
  decRad: number;
  slantRangeKm: number;
  groundDistanceKm: number;
  vmag: number;
  isAboveHorizon: boolean;
  colorHex: string;
  worldDir: [number, number, number];
  nextWorldDir: [number, number, number];
  trailPoints: AircraftTrailPoint[];
  description: string;
}

export interface AircraftSystemSnapshot {
  source: AdsbSourceKind;
  timestampMs: number;
  lastFetchMs: number;
  totalInRange: number;
  aboveHorizonCount: number;
  aircraft: AircraftTelemetryState[];
  selectedArc: AircraftTrackPoint[];
}

function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeLon180(lonDeg: number): number {
  return ((((lonDeg + 180) % 360) + 360) % 360) - 180;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function haversineDistanceKm(
  lat1Deg: number,
  lon1Deg: number,
  lat2Deg: number,
  lon2Deg: number,
): number {
  const lat1 = lat1Deg * DEG_TO_RAD;
  const lat2 = lat2Deg * DEG_TO_RAD;
  const dLat = (lat2Deg - lat1Deg) * DEG_TO_RAD;
  const dLon = (lon2Deg - lon1Deg) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat * 0.5);
  const sinLon = Math.sin(dLon * 0.5);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function formatFlightLevel(altitudeFt: number): string {
  if (altitudeFt >= 18000) {
    return `FL${String(Math.round(altitudeFt / 100)).padStart(3, '0')}`;
  }
  return `${Math.round(altitudeFt / 100) * 100} ft`;
}

function altitudeBandColorHex(altitudeFt: number): string {
  if (altitudeFt < 10000) return '#fbbf24'; // Warm amber (low approach/departure)
  if (altitudeFt < 25000) return '#34d399'; // Emerald (mid-altitude climb/descent)
  if (altitudeFt < 35000) return '#38bdf8'; // Cyan sky (cruise lower FL)
  return '#a78bfa'; // Violet (high-altitude jet stream)
}

function classifyFlightPhase(verticalRateFpm: number): AircraftFlightPhase {
  if (verticalRateFpm >= 300) return 'Climbing';
  if (verticalRateFpm <= -300) return 'Descending';
  return 'Cruising';
}

function isHeavyAircraft(typeCode: string, category: string): boolean {
  if (category === 'A4' || category === 'A5') return true;
  return /^(B74|B77|B78|B76|A33|A34|A35|A38|MD11|C17|C5)/.test(typeCode);
}

/**
 * Parses readsb-compatible payloads (`opendata.adsb.fi` `.aircraft` or `api.adsb.lol` `.ac`)
 * into normalized airborne aircraft records, filtering out grounded/surface transponders.
 */
export function parseReadsbResponse(
  payload: unknown,
  fetchedAtMs: number,
): RawAdsbAircraftRecord[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as { aircraft?: unknown; ac?: unknown };
  const rawList = Array.isArray(obj.aircraft)
    ? obj.aircraft
    : Array.isArray(obj.ac)
      ? obj.ac
      : [];

  const records: RawAdsbAircraftRecord[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const ac = item as Record<string, unknown>;
    const latDeg = Number(ac.lat);
    const lonDeg = Number(ac.lon);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;
    if (ac.alt_baro === 'ground') continue;

    const altBaroFt = Number(ac.alt_baro);
    const altGeomFt = Number(ac.alt_geom);
    const effectiveAltFt = Number.isFinite(altGeomFt) ? altGeomFt : altBaroFt;
    if (!Number.isFinite(effectiveAltFt) || effectiveAltFt < 150) continue;

    const hex = typeof ac.hex === 'string' ? ac.hex.trim().toLowerCase() : '';
    if (!hex) continue;

    const seenPosSec = Number(ac.seen_pos);
    const posTimestampMs =
      Number.isFinite(seenPosSec) && seenPosSec >= 0 && seenPosSec <= 30
        ? Math.round(fetchedAtMs - seenPosSec * 1000)
        : fetchedAtMs;

    const baroRate = Number(ac.baro_rate);
    const geomRate = Number(ac.geom_rate);
    const verticalRateFpm = Number.isFinite(baroRate)
      ? baroRate
      : Number.isFinite(geomRate)
        ? geomRate
        : 0;

    records.push({
      hex,
      callsign: typeof ac.flight === 'string' ? ac.flight.trim().toUpperCase() : '',
      registration: typeof ac.r === 'string' ? ac.r.trim().toUpperCase() : '',
      typeCode: typeof ac.t === 'string' ? ac.t.trim().toUpperCase() : '',
      modelDesc: typeof ac.desc === 'string' ? ac.desc.trim() : '',
      operator: typeof ac.ownOp === 'string' ? ac.ownOp.trim() : '',
      latDeg,
      lonDeg,
      altBaroFt: Number.isFinite(altBaroFt) ? Math.round(altBaroFt) : Math.round(effectiveAltFt),
      altGeomFt: Number.isFinite(altGeomFt) ? Math.round(altGeomFt) : Math.round(effectiveAltFt),
      groundSpeedKt: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : 0,
      trackDeg: Number.isFinite(Number(ac.track)) ? normalizeDeg360(Number(ac.track)) : 0,
      verticalRateFpm: Math.round(verticalRateFpm),
      squawk: typeof ac.squawk === 'string' ? ac.squawk.trim() : '',
      category: typeof ac.category === 'string' ? ac.category.trim() : '',
      fetchedAtMs: posTimestampMs,
    });
  }

  return records;
}

/**
 * Parses OpenSky Network `/api/states/all` payloads into normalized airborne records.
 */
export function parseOpenSkyResponse(
  payload: unknown,
  fetchedAtMs: number,
): RawAdsbAircraftRecord[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as { states?: unknown };
  if (!Array.isArray(obj.states)) return [];

  const records: RawAdsbAircraftRecord[] = [];
  for (const row of obj.states) {
    if (!Array.isArray(row) || row.length < 14) continue;
    if (row[8] === true) continue; // on_ground

    const lonDeg = Number(row[5]);
    const latDeg = Number(row[6]);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;

    const baroM = row[7] === null || row[7] === undefined ? NaN : Number(row[7]);
    const geoM = row[13] === null || row[13] === undefined ? NaN : Number(row[13]);
    const altBaroFt = Number.isFinite(baroM) ? baroM * METERS_TO_FEET : NaN;
    const altGeomFt = Number.isFinite(geoM) ? geoM * METERS_TO_FEET : NaN;
    const effectiveAltFt = Number.isFinite(altGeomFt) ? altGeomFt : altBaroFt;
    if (!Number.isFinite(effectiveAltFt) || effectiveAltFt < 150) continue;

    const hex = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
    if (!hex) continue;

    const timePosSec = Number(row[3]);
    const posTimestampMs =
      Number.isFinite(timePosSec) && timePosSec > 0
        ? Math.min(fetchedAtMs, Math.round(timePosSec * 1000))
        : fetchedAtMs;

    const velMps = Number(row[9]);
    const track = Number(row[10]);
    const vRateMps = Number(row[11]);

    records.push({
      hex,
      callsign: typeof row[1] === 'string' ? row[1].trim().toUpperCase() : '',
      registration: '',
      typeCode: '',
      modelDesc: '',
      operator: typeof row[2] === 'string' ? row[2].trim() : '',
      latDeg,
      lonDeg,
      altBaroFt: Number.isFinite(altBaroFt) ? Math.round(altBaroFt) : Math.round(effectiveAltFt),
      altGeomFt: Number.isFinite(altGeomFt) ? Math.round(altGeomFt) : Math.round(effectiveAltFt),
      groundSpeedKt: Number.isFinite(velMps) ? velMps * MPS_TO_KNOTS : 0,
      trackDeg: Number.isFinite(track) ? normalizeDeg360(track) : 0,
      verticalRateFpm: Number.isFinite(vRateMps) ? Math.round(vRateMps * MPS_TO_FPM) : 0,
      squawk: typeof row[14] === 'string' ? row[14].trim() : '',
      category: '',
      fetchedAtMs: posTimestampMs,
    });
  }

  return records;
}

function advanceGeodeticUnclamped(
  latDeg: number,
  lonDeg: number,
  altitudeFt: number,
  groundSpeedKt: number,
  trackDeg: number,
  verticalRateFpm: number,
  dtSec: number,
): { latDeg: number; lonDeg: number; altitudeFt: number } {
  const speedKmPerSec = Math.max(0, groundSpeedKt) * KNOTS_TO_KM_PER_SEC;
  const distKm = speedKmPerSec * dtSec;
  const angRad = distKm / EARTH_RADIUS_KM;
  const brngRad = trackDeg * DEG_TO_RAD;

  const lat1 = latDeg * DEG_TO_RAD;
  const lon1 = lonDeg * DEG_TO_RAD;

  let nextLatDeg = latDeg;
  let nextLonDeg = lonDeg;
  if (Math.abs(angRad) > 1e-11) {
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const cosAng = Math.cos(angRad);
    const sinAng = Math.sin(angRad);
    const lat2 = Math.asin(
      clamp(sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brngRad), -1, 1),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brngRad) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2),
      );
    nextLatDeg = lat2 / DEG_TO_RAD;
    nextLonDeg = normalizeLon180(lon2 / DEG_TO_RAD);
  }

  const nextAltFt = clamp(altitudeFt + (verticalRateFpm / 60) * dtSec, 150, 60000);
  return {
    latDeg: nextLatDeg,
    lonDeg: nextLonDeg,
    altitudeFt: nextAltFt,
  };
}

/**
 * Dead-reckons an aircraft's geodetic `(latDeg, lonDeg, altitudeFt)` over `dtSec`
 * (clamped to `[-30, +75]` seconds so stale ADS-B snapshots never runaway).
 */
export function extrapolateAircraftGeodetic(
  rec: RawAdsbAircraftRecord,
  dtSec: number,
): { latDeg: number; lonDeg: number; altitudeFt: number } {
  const clampedDt = clamp(dtSec, -30, 75);
  const baseAltFt = rec.altGeomFt > 0 ? rec.altGeomFt : rec.altBaroFt;
  return advanceGeodeticUnclamped(
    rec.latDeg,
    rec.lonDeg,
    baseAltFt,
    rec.groundSpeedKt,
    rec.trackDeg,
    rec.verticalRateFpm,
    clampedDt,
  );
}

const tempLookWorldVec = new THREE.Vector3();
const tempInvEqMatrix = new THREE.Matrix4();

/**
 * Computes exact WGS-84 topocentric look angles (`altDeg`, `azDeg`, `slantRangeKm`)
 * from the observer to an aircraft at `(latDeg, lonDeg, altitudeFt)`.
 */
export function computeAircraftLookAngles(
  latDeg: number,
  lonDeg: number,
  altitudeFt: number,
  observer: ObserverLocation,
  eqToWorld?: THREE.Matrix4,
): {
  altDeg: number;
  azDeg: number;
  slantRangeKm: number;
  groundDistanceKm: number;
  altitudeKm: number;
  raRad: number;
  decRad: number;
  worldDir: [number, number, number];
} {
  const altitudeKm = altitudeFt * FT_TO_KM;
  const observerGd = {
    longitude: degreesToRadians(observer.longitude),
    latitude: degreesToRadians(observer.latitude),
    height: observer.elevation / 1000,
  };
  const aircraftGd = {
    longitude: degreesToRadians(lonDeg),
    latitude: degreesToRadians(latDeg),
    height: altitudeKm,
  };

  const acEcf = geodeticToEcf(aircraftGd);
  const look = ecfToLookAngles(observerGd, acEcf);
  const altDeg = radiansToDegrees(look.elevation);
  const azDeg = normalizeDeg360(radiansToDegrees(look.azimuth));
  const slantRangeKm = look.rangeSat;
  const groundDistanceKm = haversineDistanceKm(
    observer.latitude,
    observer.longitude,
    latDeg,
    lonDeg,
  );
  const worldDir = altAzToWorldVector(altDeg, azDeg);

  let raRad = 0;
  let decRad = 0;
  if (eqToWorld) {
    tempInvEqMatrix.copy(eqToWorld).transpose();
    tempLookWorldVec.set(worldDir[0], worldDir[1], worldDir[2]).applyMatrix4(tempInvEqMatrix).normalize();
    decRad = Math.asin(clamp(tempLookWorldVec.z, -1, 1));
    raRad = ((Math.atan2(tempLookWorldVec.y, tempLookWorldVec.x) % TWO_PI) + TWO_PI) % TWO_PI;
  }

  return {
    altDeg,
    azDeg,
    slantRangeKm,
    groundDistanceKm,
    altitudeKm,
    raRad,
    decRad,
    worldDir,
  };
}

/**
 * Propagates a single aircraft record via dead-reckoning to `nowMs`, returning full
 * topocentric sky coordinates, velocity-aligned `nextWorldDir`, contrail points, and metadata.
 */
export function propagateAircraftState(
  rec: RawAdsbAircraftRecord,
  observer: ObserverLocation,
  nowMs: number,
  eqToWorld?: THREE.Matrix4,
): AircraftTelemetryState {
  const matrix = eqToWorld ?? computeEquatorialToWorldMatrix4(new Date(nowMs), observer.latitude, observer.longitude);
  const dtSec = (nowMs - rec.fetchedAtMs) / 1000;
  const currGeo = extrapolateAircraftGeodetic(rec, dtSec);
  const currLook = computeAircraftLookAngles(
    currGeo.latDeg,
    currGeo.lonDeg,
    currGeo.altitudeFt,
    observer,
    matrix,
  );

  // Project 5 seconds ahead along heading & climb rate so GPU billboards point nose-first along velocity
  const effectiveSpeedKt = rec.groundSpeedKt >= 25 ? rec.groundSpeedKt : 120;
  const nextGeo = advanceGeodeticUnclamped(
    currGeo.latDeg,
    currGeo.lonDeg,
    currGeo.altitudeFt,
    effectiveSpeedKt,
    rec.trackDeg,
    rec.verticalRateFpm,
    5,
  );
  const nextLook = computeAircraftLookAngles(
    nextGeo.latDeg,
    nextGeo.lonDeg,
    nextGeo.altitudeFt,
    observer,
  );

  // Build short trailing contrail (-36s to 0s)
  const trailPoints: AircraftTrailPoint[] = [];
  const trailOffsets = [-36, -24, -12, 0];
  for (const offsetSec of trailOffsets) {
    if (offsetSec === 0) {
      trailPoints.push({
        altDeg: currLook.altDeg,
        azDeg: currLook.azDeg,
        worldDir: currLook.worldDir,
        timeOffsetSec: 0,
      });
    } else {
      const ptGeo = advanceGeodeticUnclamped(
        currGeo.latDeg,
        currGeo.lonDeg,
        currGeo.altitudeFt,
        rec.groundSpeedKt,
        rec.trackDeg,
        rec.verticalRateFpm,
        offsetSec,
      );
      const ptLook = computeAircraftLookAngles(
        ptGeo.latDeg,
        ptGeo.lonDeg,
        ptGeo.altitudeFt,
        observer,
      );
      trailPoints.push({
        altDeg: ptLook.altDeg,
        azDeg: ptLook.azDeg,
        worldDir: ptLook.worldDir,
        timeOffsetSec: offsetSec,
      });
    }
  }

  const callsign = rec.callsign || rec.registration || rec.hex.toUpperCase();
  const displayName = rec.typeCode ? `${callsign} · ${rec.typeCode}` : callsign;
  const flightLevel = formatFlightLevel(currGeo.altitudeFt);
  const flightPhase = classifyFlightPhase(rec.verticalRateFpm);
  const speedKmh = rec.groundSpeedKt * KNOTS_TO_KMH;
  const trackCardinal = azimuthToCardinal(rec.trackDeg);
  const azCardinal = azimuthToCardinal(currLook.azDeg);
  const colorHex = altitudeBandColorHex(currGeo.altitudeFt);
  const heavy = isHeavyAircraft(rec.typeCode, rec.category);

  // Approximate visual magnitude of aircraft strobe/fuselage from slant range
  const vmag = clamp(-2.2 + 5 * Math.log10(Math.max(4, currLook.slantRangeKm) / 10), -2.5, 4.8);

  const modelLabel = rec.modelDesc || rec.typeCode || 'Airborne Transponder';
  const opLabel = rec.operator ? `${rec.operator} · ` : '';
  const regLabel = rec.registration ? `Reg ${rec.registration} · ` : '';
  const squawkLabel = rec.squawk ? ` · Squawk ${rec.squawk}` : '';
  const description = `${opLabel}${modelLabel}. ${regLabel}${flightPhase} at ${Math.round(currGeo.altitudeFt).toLocaleString('en-US')} ft (${Math.round(currGeo.altitudeFt * FT_TO_M).toLocaleString('en-US')} m), ${Math.round(rec.groundSpeedKt)} kt (${Math.round(speedKmh)} km/h) heading ${Math.round(rec.trackDeg)}° ${trackCardinal}${squawkLabel}.`;

  return {
    id: `ac-${rec.hex}`,
    hex: rec.hex,
    callsign,
    displayName,
    registration: rec.registration,
    typeCode: rec.typeCode,
    modelDesc: rec.modelDesc,
    operator: rec.operator,
    flightPhase,
    altitudeFt: currGeo.altitudeFt,
    altitudeKm: currLook.altitudeKm,
    flightLevel,
    groundSpeedKt: rec.groundSpeedKt,
    speedKmh,
    trackDeg: rec.trackDeg,
    trackCardinal,
    verticalRateFpm: rec.verticalRateFpm,
    squawk: rec.squawk,
    category: rec.category,
    isHeavy: heavy,
    latDeg: currGeo.latDeg,
    lonDeg: currGeo.lonDeg,
    altDeg: currLook.altDeg,
    azDeg: currLook.azDeg,
    azCardinal,
    raRad: currLook.raRad,
    decRad: currLook.decRad,
    slantRangeKm: currLook.slantRangeKm,
    groundDistanceKm: currLook.groundDistanceKm,
    vmag,
    isAboveHorizon: currLook.altDeg > -0.5,
    colorHex,
    worldDir: currLook.worldDir,
    nextWorldDir: nextLook.worldDir,
    trailPoints,
    description,
  };
}

/**
 * Computes a `-60s` to `+90s` sky trajectory arc across the celestial dome for a selected aircraft.
 */
export function computeAircraftSkyArc(
  rec: RawAdsbAircraftRecord,
  observer: ObserverLocation,
  nowMs: number,
  stepSec = 5,
): AircraftTrackPoint[] {
  const dtNowSec = (nowMs - rec.fetchedAtMs) / 1000;
  const nowGeo = extrapolateAircraftGeodetic(rec, dtNowSec);
  const points: AircraftTrackPoint[] = [];

  for (let offsetSec = -60; offsetSec <= 90; offsetSec += stepSec) {
    const ptGeo = advanceGeodeticUnclamped(
      nowGeo.latDeg,
      nowGeo.lonDeg,
      nowGeo.altitudeFt,
      rec.groundSpeedKt,
      rec.trackDeg,
      rec.verticalRateFpm,
      offsetSec,
    );
    const look = computeAircraftLookAngles(ptGeo.latDeg, ptGeo.lonDeg, ptGeo.altitudeFt, observer);
    points.push({
      altDeg: look.altDeg,
      azDeg: look.azDeg,
      worldDir: look.worldDir,
      timeOffsetSec: offsetSec,
    });
  }

  return points;
}

interface SimulatedCorridorTemplate {
  hex: string;
  callsign: string;
  registration: string;
  typeCode: string;
  modelDesc: string;
  operator: string;
  offsetNorthKm: number;
  offsetEastKm: number;
  altitudeFt: number;
  groundSpeedKt: number;
  trackDeg: number;
  verticalRateFpm: number;
  category: string;
}

const SIMULATED_CORRIDORS: SimulatedCorridorTemplate[] = [
  {
    hex: 'a1b2c3',
    callsign: 'UAL418',
    registration: 'N37518',
    typeCode: 'B738',
    modelDesc: 'BOEING 737-800',
    operator: 'UNITED AIRLINES',
    offsetNorthKm: 18,
    offsetEastKm: -24,
    altitudeFt: 34000,
    groundSpeedKt: 468,
    trackDeg: 68,
    verticalRateFpm: 0,
    category: 'A3',
  },
  {
    hex: '4076e2',
    callsign: 'BAW117',
    registration: 'G-XWBJ',
    typeCode: 'A35K',
    modelDesc: 'AIRBUS A350-1000',
    operator: 'BRITISH AIRWAYS',
    offsetNorthKm: -12,
    offsetEastKm: 28,
    altitudeFt: 38000,
    groundSpeedKt: 504,
    trackDeg: 286,
    verticalRateFpm: 0,
    category: 'A5',
  },
  {
    hex: '3c6444',
    callsign: 'DLH402',
    registration: 'D-ABYA',
    typeCode: 'B748',
    modelDesc: 'BOEING 747-8I',
    operator: 'LUFTHANSA',
    offsetNorthKm: 6,
    offsetEastKm: 9,
    altitudeFt: 36500,
    groundSpeedKt: 512,
    trackDeg: 242,
    verticalRateFpm: -128,
    category: 'A5',
  },
  {
    hex: '86e910',
    callsign: 'ANA106',
    registration: 'JA894A',
    typeCode: 'B789',
    modelDesc: 'BOEING 787-9 DREAMLINER',
    operator: 'ALL NIPPON AIRWAYS',
    offsetNorthKm: -22,
    offsetEastKm: -16,
    altitudeFt: 39000,
    groundSpeedKt: 495,
    trackDeg: 318,
    verticalRateFpm: 0,
    category: 'A5',
  },
  {
    hex: 'a8821d',
    callsign: 'DAL882',
    registration: 'N821DN',
    typeCode: 'A321',
    modelDesc: 'AIRBUS A321NEO',
    operator: 'DELTA AIR LINES',
    offsetNorthKm: 11,
    offsetEastKm: 15,
    altitudeFt: 16800,
    groundSpeedKt: 342,
    trackDeg: 194,
    verticalRateFpm: 1650,
    category: 'A3',
  },
  {
    hex: '394c09',
    callsign: 'AFR066',
    registration: 'F-HTYN',
    typeCode: 'A359',
    modelDesc: 'AIRBUS A350-900',
    operator: 'AIR FRANCE',
    offsetNorthKm: -8,
    offsetEastKm: -31,
    altitudeFt: 37000,
    groundSpeedKt: 489,
    trackDeg: 76,
    verticalRateFpm: 0,
    category: 'A5',
  },
  {
    hex: 'ab1904',
    callsign: 'SWA2083',
    registration: 'N8692F',
    typeCode: 'B738',
    modelDesc: 'BOEING 737 MAX 8',
    operator: 'SOUTHWEST AIRLINES',
    offsetNorthKm: -15,
    offsetEastKm: 7,
    altitudeFt: 11400,
    groundSpeedKt: 285,
    trackDeg: 25,
    verticalRateFpm: -1150,
    category: 'A3',
  },
  {
    hex: 'a512ef',
    callsign: 'EJA512',
    registration: 'N512QS',
    typeCode: 'C68A',
    modelDesc: 'CESSNA CITATION LATITUDE',
    operator: 'NETJETS AVIATION',
    offsetNorthKm: 26,
    offsetEastKm: 4,
    altitudeFt: 28000,
    groundSpeedKt: 412,
    trackDeg: 148,
    verticalRateFpm: 640,
    category: 'A2',
  },
  {
    hex: '484c51',
    callsign: 'KLM641',
    registration: 'PH-BHA',
    typeCode: 'B789',
    modelDesc: 'BOEING 787-9 DREAMLINER',
    operator: 'KLM ROYAL DUTCH AIRLINES',
    offsetNorthKm: 32,
    offsetEastKm: -19,
    altitudeFt: 35000,
    groundSpeedKt: 478,
    trackDeg: 224,
    verticalRateFpm: 0,
    category: 'A5',
  },
  {
    hex: '7c6b12',
    callsign: 'QFA12',
    registration: 'VH-ZNA',
    typeCode: 'B789',
    modelDesc: 'BOEING 787-9 DREAMLINER',
    operator: 'QANTAS AIRWAYS',
    offsetNorthKm: -34,
    offsetEastKm: 21,
    altitudeFt: 31000,
    groundSpeedKt: 465,
    trackDeg: 352,
    verticalRateFpm: 0,
    category: 'A5',
  },
];

/**
 * Deterministic regional air traffic generator anchored to the observer's coordinates
 * so remote observatories or offline sessions remain populated with realistic traffic.
 */
export function generateSimulatedCorridorTraffic(
  observer: ObserverLocation,
  nowMs: number,
): RawAdsbAircraftRecord[] {
  const cosLat = Math.max(0.2, Math.cos(observer.latitude * DEG_TO_RAD));
  // Loop traffic gently every 12 minutes so aircraft continuously cross the sky dome
  const cycleSec = ((nowMs / 1000) % 720) - 360;

  return SIMULATED_CORRIDORS.map((tpl) => {
    const baseLat = clamp(observer.latitude + tpl.offsetNorthKm / 111.32, -89.5, 89.5);
    const baseLon = normalizeLon180(observer.longitude + tpl.offsetEastKm / (111.32 * cosLat));
    const speedKmSec = tpl.groundSpeedKt * KNOTS_TO_KM_PER_SEC;
    // Scale cycle travel distance into a local 90 km corridor box around the observer
    const travelCycleSec = (cycleSec % 160) * 0.65;
    const moved = advanceGeodeticUnclamped(
      baseLat,
      baseLon,
      tpl.altitudeFt,
      tpl.groundSpeedKt,
      tpl.trackDeg,
      tpl.verticalRateFpm * 0.15,
      travelCycleSec + (speedKmSec > 0 ? 0 : 0),
    );

    return {
      hex: tpl.hex,
      callsign: tpl.callsign,
      registration: tpl.registration,
      typeCode: tpl.typeCode,
      modelDesc: tpl.modelDesc,
      operator: tpl.operator,
      latDeg: moved.latDeg,
      lonDeg: moved.lonDeg,
      altBaroFt: Math.round(moved.altitudeFt),
      altGeomFt: Math.round(moved.altitudeFt),
      groundSpeedKt: tpl.groundSpeedKt,
      trackDeg: tpl.trackDeg,
      verticalRateFpm: tpl.verticalRateFpm,
      squawk: '1200',
      category: tpl.category,
      fetchedAtMs: nowMs,
    };
  });
}

function readCachedAdsb(
  observer: ObserverLocation,
  nowMs: number,
): { source: AdsbSourceKind; records: RawAdsbAircraftRecord[]; fetchedAtMs: number } | null {
  try {
    const raw = localStorage.getItem(ADSB_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      lat: number;
      lon: number;
      fetchedAtMs: number;
      source: AdsbSourceKind;
      records: RawAdsbAircraftRecord[];
    };
    if (!parsed || !Array.isArray(parsed.records)) return null;
    if (nowMs - parsed.fetchedAtMs > ADSB_CACHE_TTL_MS) return null;
    if (
      Math.abs(parsed.lat - observer.latitude) > 0.25 ||
      Math.abs(parsed.lon - observer.longitude) > 0.25
    ) {
      return null;
    }
    return {
      source: 'adsb-cache',
      records: parsed.records,
      fetchedAtMs: parsed.fetchedAtMs,
    };
  } catch {
    return null;
  }
}

function writeCachedAdsb(
  observer: ObserverLocation,
  source: AdsbSourceKind,
  records: RawAdsbAircraftRecord[],
  fetchedAtMs: number,
): void {
  try {
    localStorage.setItem(
      ADSB_CACHE_KEY,
      JSON.stringify({
        lat: observer.latitude,
        lon: observer.longitude,
        fetchedAtMs,
        source,
        records: records.slice(0, 140),
      }),
    );
  } catch {
    // Ignore storage quota errors
  }
}

function mapProxySource(rawSource: unknown): AdsbSourceKind {
  if (rawSource === 'adsb.fi' || rawSource === 'adsb-fi') return 'adsb-fi';
  if (rawSource === 'adsb.lol' || rawSource === 'adsb-lol') return 'adsb-lol';
  if (rawSource === 'opensky') return 'opensky';
  return 'adsb-fi';
}

function isNormalizedAdsbArray(list: unknown): list is RawAdsbAircraftRecord[] {
  if (!Array.isArray(list)) return false;
  if (list.length === 0) return true;
  const first = list[0] as Record<string, unknown>;
  return typeof first.hex === 'string' && typeof first.latDeg === 'number' && typeof first.lonDeg === 'number';
}

export async function fetchLiveAdsbTraffic(
  observer: ObserverLocation,
): Promise<{ source: AdsbSourceKind; records: RawAdsbAircraftRecord[]; fetchedAtMs: number }> {
  const nowMs = Date.now();
  const proxyUrl = `/api/aircraft?lat=${observer.latitude.toFixed(4)}&lon=${observer.longitude.toFixed(4)}&radius=${ADSB_SEARCH_RADIUS_NM}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    const res = await fetch(proxyUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json()) as {
        source?: string;
        fetchedAtMs?: number;
        aircraft?: unknown;
      };
      const fetchedAtMs = Number.isFinite(Number(data.fetchedAtMs)) ? Number(data.fetchedAtMs) : nowMs;
      const records = isNormalizedAdsbArray(data.aircraft)
        ? data.aircraft
        : parseReadsbResponse(data, fetchedAtMs);

      if (records.length > 0) {
        const source = mapProxySource(data.source);
        writeCachedAdsb(observer, source, records, fetchedAtMs);
        return { source, records, fetchedAtMs };
      }
    }
  } catch {
    // Fall through to cached or simulated corridor fallback
  }

  const cached = readCachedAdsb(observer, nowMs);
  if (cached && cached.records.length > 0) {
    return cached;
  }

  return {
    source: 'simulated-corridor',
    records: generateSimulatedCorridorTraffic(observer, nowMs),
    fetchedAtMs: nowMs,
  };
}

/**
 * Coordinates live ADS-B polling every 8 seconds and 60 FPS dead-reckoning sky propagation.
 */
export class AircraftTrackerController {
  private records: RawAdsbAircraftRecord[] = [];
  private source: AdsbSourceKind = 'simulated-corridor';
  private lastFetchMs = 0;
  private lastFetchLocationKey = '';
  private lastPropagateMs = 0;
  private fetchInFlight = false;
  private disposed = false;
  private snapshot: AircraftSystemSnapshot;
  private readonly onSnapshot?: (snapshot: AircraftSystemSnapshot) => void;

  constructor(
    initialLocation: ObserverLocation,
    initialTimestampMs: number,
    onSnapshot?: (snapshot: AircraftSystemSnapshot) => void,
  ) {
    this.onSnapshot = onSnapshot;
    this.records = generateSimulatedCorridorTraffic(initialLocation, initialTimestampMs);
    this.snapshot = this.computeSnapshot(initialTimestampMs, initialLocation, null);
  }

  private resolveEvalTimestampMs(simTimestampMs: number): number {
    const wallNowMs = Date.now();
    // Live ADS-B stays meaningful near current real time; freeze interpolation when scrubbing hours away
    if (Math.abs(simTimestampMs - wallNowMs) <= 120_000) {
      return simTimestampMs;
    }
    return this.lastFetchMs > 0 ? this.lastFetchMs : wallNowMs;
  }

  private computeSnapshot(
    simTimestampMs: number,
    location: ObserverLocation,
    selectedHex: string | null,
    eqToWorld?: THREE.Matrix4,
  ): AircraftSystemSnapshot {
    const evalMs = this.resolveEvalTimestampMs(simTimestampMs);
    const activeRecords =
      this.source === 'simulated-corridor'
        ? generateSimulatedCorridorTraffic(location, evalMs)
        : this.records;

    const matrix =
      eqToWorld ??
      computeEquatorialToWorldMatrix4(new Date(evalMs), location.latitude, location.longitude);

    const propagated = activeRecords.map((rec) =>
      propagateAircraftState(rec, location, evalMs, matrix),
    );

    // Prioritize above-horizon aircraft, selected aircraft, highest elevation angle, and closest slant range
    propagated.sort((a, b) => {
      if (a.isAboveHorizon !== b.isAboveHorizon) return a.isAboveHorizon ? -1 : 1;
      if (selectedHex) {
        if (a.hex === selectedHex && b.hex !== selectedHex) return -1;
        if (b.hex === selectedHex && a.hex !== selectedHex) return 1;
      }
      if (Math.abs(a.altDeg - b.altDeg) > 4) return b.altDeg - a.altDeg;
      return a.slantRangeKm - b.slantRangeKm;
    });

    const aboveHorizonCount = propagated.filter((ac) => ac.isAboveHorizon).length;
    const selectedRec = selectedHex
      ? activeRecords.find((r) => r.hex === selectedHex)
      : undefined;
    const selectedArc = selectedRec
      ? computeAircraftSkyArc(selectedRec, location, evalMs)
      : [];

    return {
      source: this.source,
      timestampMs: evalMs,
      lastFetchMs: this.lastFetchMs,
      totalInRange: propagated.length,
      aboveHorizonCount,
      aircraft: propagated,
      selectedArc,
    };
  }

  getSnapshot(): AircraftSystemSnapshot {
    return this.snapshot;
  }

  requestUpdate(
    simTimestampMs: number,
    location: ObserverLocation,
    selectedHex: string | null,
    forceImmediate = false,
    eqToWorld?: THREE.Matrix4,
    enabled = true,
  ): void {
    if (this.disposed || !enabled) return;

    const nowWallMs = Date.now();
    const locKey = `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
    const locationChanged = locKey !== this.lastFetchLocationKey;

    if (
      !this.fetchInFlight &&
      (locationChanged || nowWallMs - this.lastFetchMs >= ADSB_POLL_INTERVAL_MS)
    ) {
      void this.refreshLiveTraffic(location, simTimestampMs, selectedHex, false);
    }

    const nowPerf = typeof performance !== 'undefined' ? performance.now() : nowWallMs;
    if (!forceImmediate && nowPerf - this.lastPropagateMs < 30) {
      return;
    }
    this.lastPropagateMs = nowPerf;
    this.snapshot = this.computeSnapshot(simTimestampMs, location, selectedHex, eqToWorld);
  }

  async refreshLiveTraffic(
    location: ObserverLocation,
    simTimestampMs: number,
    selectedHex: string | null,
    forceImmediate = true,
  ): Promise<{ source: AdsbSourceKind; count: number }> {
    if (this.disposed) {
      return { source: this.source, count: this.records.length };
    }
    if (this.fetchInFlight && !forceImmediate) {
      return { source: this.source, count: this.records.length };
    }

    this.fetchInFlight = true;
    const targetLocKey = `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
    try {
      const result = await fetchLiveAdsbTraffic(location);
      if (this.disposed) {
        return { source: result.source, count: result.records.length };
      }
      this.source = result.source;
      this.records = result.records;
      this.lastFetchMs = result.fetchedAtMs;
      this.lastFetchLocationKey = targetLocKey;
      this.snapshot = this.computeSnapshot(simTimestampMs, location, selectedHex);
      this.onSnapshot?.(this.snapshot);
      return { source: result.source, count: result.records.length };
    } finally {
      this.fetchInFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
