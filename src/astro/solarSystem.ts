import * as Astronomy from 'astronomy-engine';
import { altAzToWorldVector, DEG_TO_RAD, TWO_PI } from './coordinates';

export type SolarSystemBodyId =
  | 'sun'
  | 'moon'
  | 'mercury'
  | 'venus'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

export type LunarPhaseName =
  | 'New Moon'
  | 'Waxing Crescent'
  | 'First Quarter'
  | 'Waxing Gibbous'
  | 'Full Moon'
  | 'Waning Gibbous'
  | 'Third Quarter'
  | 'Waning Crescent';

export interface SolarSystemBodyState {
  id: SolarSystemBodyId;
  name: string;
  raRad: number;
  decRad: number;
  altDeg: number;
  azDeg: number;
  worldDir: [number, number, number];
  vmag: number;
  distAu: number;
  phaseFraction: number;
  phaseAngleDeg: number;
  ringTiltDeg?: number;
}

export interface MoonEphemerisState extends SolarSystemBodyState {
  id: 'moon';
  elongationDeg: number;
  phaseName: LunarPhaseName;
  waxing: boolean;
  /** Normalized 3D vector in Three.js world space pointing from the Moon toward the Sun */
  sunFromMoonWorldDir: [number, number, number];
}

export interface SolarSystemEphemeris {
  sun: SolarSystemBodyState;
  moon: MoonEphemerisState;
  /** Mercury through Neptune in orbital order */
  planets: SolarSystemBodyState[];
}

const PLANET_DEFS: Array<{ id: Exclude<SolarSystemBodyId, 'sun' | 'moon'>; name: string; body: Astronomy.Body }> = [
  { id: 'mercury', name: 'Mercury', body: Astronomy.Body.Mercury },
  { id: 'venus', name: 'Venus', body: Astronomy.Body.Venus },
  { id: 'mars', name: 'Mars', body: Astronomy.Body.Mars },
  { id: 'jupiter', name: 'Jupiter', body: Astronomy.Body.Jupiter },
  { id: 'saturn', name: 'Saturn', body: Astronomy.Body.Saturn },
  { id: 'uranus', name: 'Uranus', body: Astronomy.Body.Uranus },
  { id: 'neptune', name: 'Neptune', body: Astronomy.Body.Neptune },
];

/**
 * Classifies synodic lunar phase longitude [0, 360) degrees into the 8 standard lunar phase names.
 */
export function classifyLunarPhase(elongationDeg: number): LunarPhaseName {
  const norm = ((elongationDeg % 360) + 360) % 360;
  if (norm < 11.25 || norm >= 348.75) return 'New Moon';
  if (norm < 78.75) return 'Waxing Crescent';
  if (norm < 101.25) return 'First Quarter';
  if (norm < 168.75) return 'Waxing Gibbous';
  if (norm < 191.25) return 'Full Moon';
  if (norm < 258.75) return 'Waning Gibbous';
  if (norm < 281.25) return 'Third Quarter';
  return 'Waning Crescent';
}

function computeBodyState(
  id: SolarSystemBodyId,
  name: string,
  body: Astronomy.Body,
  date: Date,
  observer: Astronomy.Observer,
): SolarSystemBodyState {
  const eq = Astronomy.Equator(body, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, 'normal');
  const ill = Astronomy.Illumination(body, date);

  return {
    id,
    name,
    raRad: (eq.ra / 24) * TWO_PI,
    decRad: eq.dec * DEG_TO_RAD,
    altDeg: hor.altitude,
    azDeg: hor.azimuth,
    worldDir: altAzToWorldVector(hor.altitude, hor.azimuth),
    vmag: ill.mag,
    distAu: eq.dist > 0 ? eq.dist : ill.geo_dist,
    phaseFraction: ill.phase_fraction,
    phaseAngleDeg: ill.phase_angle,
    ringTiltDeg: ill.ring_tilt,
  };
}

/**
 * Computes topocentric positions, magnitudes, distances, and illumination phases
 * for the Sun, Moon (including 3D Sun-from-Moon lighting vector), and Mercury-Neptune.
 */
export function computeSolarSystemEphemeris(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  elevationM = 0,
): SolarSystemEphemeris {
  const observer = new Astronomy.Observer(latitudeDeg, longitudeDeg, elevationM);

  const sun = computeBodyState('sun', 'Sun', Astronomy.Body.Sun, date, observer);
  const moonBase = computeBodyState('moon', 'Moon', Astronomy.Body.Moon, date, observer);
  const elongationDeg = ((Astronomy.MoonPhase(date) % 360) + 360) % 360;

  // 3D world-space vector from Moon to Sun: S_world * dist_sun - M_world * dist_moon
  const dx = sun.distAu * sun.worldDir[0] - moonBase.distAu * moonBase.worldDir[0];
  const dy = sun.distAu * sun.worldDir[1] - moonBase.distAu * moonBase.worldDir[1];
  const dz = sun.distAu * sun.worldDir[2] - moonBase.distAu * moonBase.worldDir[2];
  const len = Math.hypot(dx, dy, dz) || 1;

  const moon: MoonEphemerisState = {
    ...moonBase,
    id: 'moon',
    elongationDeg,
    phaseName: classifyLunarPhase(elongationDeg),
    waxing: elongationDeg < 180,
    sunFromMoonWorldDir: [dx / len, dy / len, dz / len],
  };

  const planets = PLANET_DEFS.map((def) =>
    computeBodyState(def.id, def.name, def.body, date, observer),
  );

  return { sun, moon, planets };
}
