import * as Astronomy from 'astronomy-engine';
import * as THREE from 'three';

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

export type TwilightPhase =
  | 'Daylight'
  | 'Civil Twilight'
  | 'Nautical Twilight'
  | 'Astronomical Twilight'
  | 'Night';

export interface SunTelemetry {
  altDeg: number;
  azDeg: number;
  raRad: number;
  decRad: number;
  worldDir: [number, number, number];
  twilightPhase: TwilightPhase;
}

/**
 * Converts J2000 Right Ascension and Declination (in radians) to a unit 3D vector
 * in the Equatorial frame (+X = vernal equinox, +Y = RA 6h, +Z = North Celestial Pole).
 */
export function raDecToJ2000UnitVector(raRad: number, decRad: number): [number, number, number] {
  const cosDec = Math.cos(decRad);
  return [
    cosDec * Math.cos(raRad),
    cosDec * Math.sin(raRad),
    Math.sin(decRad),
  ];
}

/**
 * Computes Local Apparent Sidereal Time (LAST) in radians [0, 2*PI) from UTC Date and observer longitude.
 */
export function computeLocalApparentSiderealTimeRad(date: Date, longitudeDeg: number): number {
  // Astronomy.SiderealTime returns Greenwich Apparent Sidereal Time in sidereal hours [0, 24).
  const gastHours = Astronomy.SiderealTime(date);
  const lastHours = (((gastHours + longitudeDeg / 15) % 24) + 24) % 24;
  return (lastHours / 24) * TWO_PI;
}

/**
 * Computes the proper 3D rotation Matrix4 mapping J2000 Equatorial unit vectors
 * directly to Three.js world space (+X = East, +Y = Up/Zenith, -Z = North, +Z = South).
 */
export function computeEquatorialToWorldMatrix4(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  outMatrix: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
  const theta = computeLocalApparentSiderealTimeRad(date, longitudeDeg);
  const phi = latitudeDeg * DEG_TO_RAD;

  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  return outMatrix.set(
    -sinTheta, cosTheta, 0, 0,
    cosPhi * cosTheta, cosPhi * sinTheta, sinPhi, 0,
    sinPhi * cosTheta, sinPhi * sinTheta, -cosPhi, 0,
    0, 0, 0, 1,
  );
}

/**
 * Converts a Three.js world-space direction vector (+X East, +Y Zenith, -Z North)
 * to horizontal Altitude and Azimuth in degrees (Azimuth 0=N, 90=E, 180=S, 270=W).
 */
export function worldVectorToAltAz(x: number, y: number, z: number): { altDeg: number; azDeg: number } {
  const len = Math.hypot(x, y, z) || 1;
  const nx = x / len;
  const ny = Math.max(-1, Math.min(1, y / len));
  const nz = z / len;

  const altDeg = Math.asin(ny) * RAD_TO_DEG;
  const azRad = ((Math.atan2(nx, -nz) % TWO_PI) + TWO_PI) % TWO_PI;
  return {
    altDeg,
    azDeg: azRad * RAD_TO_DEG,
  };
}

/**
 * Converts horizontal Altitude and Azimuth (in degrees) into a Three.js unit world vector
 * (+X = East, +Y = Zenith, -Z = North).
 */
export function altAzToWorldVector(altDeg: number, azDeg: number): [number, number, number] {
  const altRad = altDeg * DEG_TO_RAD;
  const azRad = azDeg * DEG_TO_RAD;
  const cosAlt = Math.cos(altRad);
  return [
    cosAlt * Math.sin(azRad),
    Math.sin(altRad),
    -cosAlt * Math.cos(azRad),
  ];
}

/**
 * Converts J2000 RA/Dec (radians) to instantaneous local Altitude and Azimuth (degrees).
 */
export function raDecToAltAz(
  raRad: number,
  decRad: number,
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
): { altDeg: number; azDeg: number } {
  const [vx, vy, vz] = raDecToJ2000UnitVector(raRad, decRad);
  const mat = computeEquatorialToWorldMatrix4(date, latitudeDeg, longitudeDeg);
  const vec = new THREE.Vector3(vx, vy, vz).applyMatrix4(mat);
  return worldVectorToAltAz(vec.x, vec.y, vec.z);
}

/**
 * Classifies twilight stage from solar altitude in degrees.
 */
export function classifyTwilight(sunAltDeg: number): TwilightPhase {
  if (sunAltDeg > -0.833) return 'Daylight';
  if (sunAltDeg > -6) return 'Civil Twilight';
  if (sunAltDeg > -12) return 'Nautical Twilight';
  if (sunAltDeg > -18) return 'Astronomical Twilight';
  return 'Night';
}

/**
 * Computes topocentric solar position and twilight state via astronomy-engine (VSOP87).
 */
export function computeSunPosition(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  elevationM = 0,
): SunTelemetry {
  const observer = new Astronomy.Observer(latitudeDeg, longitudeDeg, elevationM);
  const eq = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, 'normal');

  return {
    altDeg: hor.altitude,
    azDeg: hor.azimuth,
    raRad: (eq.ra / 24) * TWO_PI,
    decRad: eq.dec * DEG_TO_RAD,
    worldDir: altAzToWorldVector(hor.altitude, hor.azimuth),
    twilightPhase: classifyTwilight(hor.altitude),
  };
}

/**
 * Formats an angle in radians (or hours when isRadians=false) as HHh MMm SSs.
 */
export function formatHMS(value: number, isRadians = true): string {
  const totalHours = isRadians ? (((value % TWO_PI) + TWO_PI) % TWO_PI) * (24 / TWO_PI) : (((value % 24) + 24) % 24);
  const h = Math.floor(totalHours);
  const mFloat = (totalHours - h) * 60;
  const m = Math.floor(mFloat);
  const s = Math.floor((mFloat - m) * 60);
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Formats degrees as signed DD° MM'.
 */
export function formatDMS(deg: number): string {
  const sign = deg < 0 ? '−' : '+';
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.round((abs - d) * 60);
  const finalD = m === 60 ? d + 1 : d;
  const finalM = m === 60 ? 0 : m;
  return `${sign}${String(finalD).padStart(2, '0')}° ${String(finalM).padStart(2, '0')}'`;
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * Maps azimuth [0, 360) degrees to a 16-point compass rose label.
 */
export function azimuthToCardinal(azDeg: number): string {
  const normalized = ((azDeg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return CARDINALS[idx];
}
