import * as Astronomy from 'astronomy-engine';
import * as THREE from 'three';
import type {
  ConstellationRecord,
  DsoMorphology,
  DsoRecord,
  LoadedCelestialData,
  NamedStarEntry,
  StarCatalogData,
} from '../data/catalogLoader';
import type { ObserverLocation } from '../services/locationService';
import {
  azimuthToCardinal,
  computeEquatorialToWorldMatrix4,
  computeLocalApparentSiderealTimeRad,
  computeSunPosition,
  DEG_TO_RAD,
  formatDMS,
  formatHMS,
  RAD_TO_DEG,
  raDecToJ2000UnitVector,
  TWO_PI,
  worldVectorToAltAz,
} from './coordinates';
import {
  computeSolarSystemEphemeris,
  type SolarSystemBodyId,
  type SolarSystemBodyState,
  type SolarSystemEphemeris,
} from './solarSystem';
import type {
  SatellitePassPrediction,
  SatelliteTelemetryState,
} from './satellites';
import type { AircraftTelemetryState } from './aircraft';
import { bvToKelvin, bvToRGB, computeAirmass } from './spectral';

export type CelestialObjectKind =
  | 'planet'
  | 'star'
  | 'dso'
  | 'constellation'
  | 'satellite'
  | 'aircraft';

export interface CelestialObjectRef {
  id: string;
  kind: CelestialObjectKind;
  starIndex?: number;
  hip?: number;
  bodyId?: SolarSystemBodyId;
  dsoId?: string;
  constellationId?: string;
  satNoradId?: number;
  aircraftHex?: string;
}

export interface RiseTransitSetTimes {
  rise: string;
  transit: string;
  transitAltDeg: number;
  set: string;
  state: 'normal' | 'circumpolar' | 'never_rises';
}

export interface InspectedObjectTelemetry {
  ref: CelestialObjectRef;
  id: string;
  kind: CelestialObjectKind;
  name: string;
  subtitle: string;
  categoryLabel: string;
  altDeg: number;
  azDeg: number;
  azCardinal: string;
  raRad: number;
  decRad: number;
  raFormatted: string;
  decFormatted: string;
  vmag: number | null;
  vmagFormatted: string;
  distanceLabel: string;
  spectralOrMorphology: string;
  spectralColorHex: string;
  airmass: number | null;
  rts: RiseTransitSetTimes;
  isAboveHorizon: boolean;
  description: string;
  recommendedFovDeg: number;
  worldDir: [number, number, number];
}

export interface SearchResultItem {
  ref: CelestialObjectRef;
  id: string;
  kind: CelestialObjectKind;
  name: string;
  subtitle: string;
  categoryBadge: string;
  vmag: number | null;
  altDeg: number;
  azCardinal: string;
  isAboveHorizon: boolean;
  score: number;
}

export interface TourStopItem {
  stepIndex: number;
  ref: CelestialObjectRef;
  id: string;
  kind: CelestialObjectKind;
  name: string;
  subtitle: string;
  categoryBadge: string;
  vmag: number | null;
  altDeg: number;
  azDeg: number;
  azCardinal: string;
  highlightNote: string;
  recommendedFovDeg: number;
  score: number;
}

const SIDEREAL_TO_SOLAR = 0.997269566329084;
const MS_PER_DAY = 86_400_000;

const KNOWN_STAR_SPECTRAL: Record<number, { spectral: string; distLy: string; note?: string }> = {
  32349: { spectral: 'A1V', distLy: '8.60 ly', note: 'Brightest star in Earth’s night sky (Alpha Canis Majoris).' },
  30438: { spectral: 'A9II', distLy: '310 ly', note: 'Luminous supergiant and second-brightest star in the sky.' },
  71683: { spectral: 'G2V', distLy: '4.37 ly', note: 'Closest stellar system to the Sun (Alpha Centauri).' },
  69673: { spectral: 'K1.5III', distLy: '36.7 ly', note: 'Orange giant and brightest star in the northern celestial hemisphere.' },
  91262: { spectral: 'A0Va', distLy: '25.04 ly', note: 'Blue-white anchor of the Summer Triangle (Alpha Lyrae).' },
  24608: { spectral: 'G3III', distLy: '42.9 ly', note: 'Golden quadruple star system high in Auriga.' },
  24436: { spectral: 'B8Ia', distLy: '860 ly', note: 'Blue supergiant marking Orion’s bright western foot.' },
  37279: { spectral: 'F5IV-V', distLy: '11.46 ly', note: 'Nearby yellow-white subgiant with a white dwarf companion.' },
  7588: { spectral: 'B6Vep', distLy: '139 ly', note: 'Rapidly spinning blue star at the southern tip of Eridanus.' },
  27989: { spectral: 'M1-M2Ia', distLy: '640 ly', note: 'Red supergiant on Orion’s shoulder nearing core collapse.' },
  68702: { spectral: 'B1III', distLy: '390 ly', note: 'Hot blue-white triple system (Beta Centauri).' },
  97649: { spectral: 'A7V', distLy: '16.73 ly', note: 'Rapidly rotating white star at the southern apex of the Summer Triangle.' },
  60718: { spectral: 'B0.5IV', distLy: '320 ly', note: 'Southern Cross anchor star (Alpha Crucis).' },
  21421: { spectral: 'K5III', distLy: '65.3 ly', note: 'Orange giant forming the fiery eye of Taurus.' },
  80763: { spectral: 'M1.5Iab', distLy: '550 ly', note: 'Red supergiant rivaling Mars in color at the heart of Scorpius.' },
  65474: { spectral: 'B1III-IV', distLy: '250 ly', note: 'Spectroscopic blue giant binary in Virgo.' },
  37826: { spectral: 'K0III', distLy: '33.78 ly', note: 'Closest giant star to the Sun and brighter twin in Gemini.' },
  113368: { spectral: 'A3V', distLy: '25.13 ly', note: 'Young star ringed by a prominent debris disk in Piscis Austrinus.' },
  102098: { spectral: 'A2Ia', distLy: '2,615 ly', note: 'Extremely luminous white supergiant at the tail of Cygnus.' },
  62434: { spectral: 'B0.5III', distLy: '280 ly', note: 'Blue giant marking the eastern arm of the Southern Cross.' },
  49669: { spectral: 'B8IVn', distLy: '79.3 ly', note: 'Blue-white multiple system at the heart of Leo.' },
  11767: { spectral: 'F7Ib', distLy: '433 ly', note: 'Cepheid supergiant aligned within 0.75° of the North Celestial Pole.' },
  36850: { spectral: 'A1V', distLy: '51.6 ly', note: 'Sextuple star system forming Castor in Gemini.' },
  25336: { spectral: 'B2III', distLy: '250 ly', note: 'Hot blue giant marking Orion’s western shoulder.' },
  26311: { spectral: 'B0Ia', distLy: '1,340 ly', note: 'Luminous blue supergiant at the center of Orion’s Belt.' },
  54061: { spectral: 'K0III', distLy: '123 ly', note: 'Pointer star Dubhe in the Big Dipper bowl.' },
  62956: { spectral: 'A1III-IV', distLy: '82.6 ly', note: 'Brightest star in Ursa Major (Alioth).' },
  65378: { spectral: 'A2V', distLy: '82.9 ly', note: 'Famous visual double with Alcor in Ursa Major (Mizar).' },
  67301: { spectral: 'B3V', distLy: '103.9 ly', note: 'Blue main-sequence star at the tip of the Big Dipper handle.' },
};

const KNOWN_DSO_DISTANCES: Record<string, string> = {
  M1: '6,500 ly',
  M3: '33,900 ly',
  M4: '5,500 ly',
  M5: '24,500 ly',
  M6: '1,600 ly',
  M7: '980 ly',
  M8: '4,100 ly',
  M11: '6,200 ly',
  M13: '22,200 ly',
  M15: '35,700 ly',
  M16: '5,700 ly',
  M17: '5,500 ly',
  M20: '4,100 ly',
  M22: '10,600 ly',
  M27: '1,360 ly',
  M31: '2.54 Mly',
  M32: '2.49 Mly',
  M33: '2.73 Mly',
  M42: '1,344 ly',
  M43: '1,344 ly',
  M44: '577 ly',
  M45: '444 ly',
  M51: '23.5 Mly',
  M57: '2,570 ly',
  M63: '29.3 Mly',
  M64: '17.3 Mly',
  M81: '11.8 Mly',
  M82: '12.0 Mly',
  M83: '15.2 Mly',
  M87: '53.5 Mly',
  M92: '26,700 ly',
  M101: '20.9 Mly',
  M104: '29.3 Mly',
  M110: '2.69 Mly',
  C14: '7,500 ly',
  C20: '2,590 ly',
  C41: '153 ly',
  C49: '5,200 ly',
  C63: '655 ly',
  C65: '11.4 Mly',
  C77: '12.0 Mly',
  C80: '17,090 ly',
  C92: '8,500 ly',
  C106: '14,500 ly',
};

const PLANET_META: Record<
  SolarSystemBodyId,
  { category: string; kindDesc: string; colorHex: string; note: string }
> = {
  sun: {
    category: 'Star',
    kindDesc: 'G2V · 5,778 K',
    colorHex: '#fff0c7',
    note: 'G2V main-sequence yellow dwarf anchoring the Solar System.',
  },
  moon: {
    category: 'Lunar',
    kindDesc: 'Natural Satellite',
    colorHex: '#f2f2eb',
    note: 'Earth’s natural satellite with live Lommel-Seeliger terminator illumination.',
  },
  mercury: {
    category: 'Planet',
    kindDesc: 'Terrestrial Planet',
    colorHex: '#d6ccbd',
    note: 'Innermost rocky planet hugging the solar twilight horizon.',
  },
  venus: {
    category: 'Planet',
    kindDesc: 'Terrestrial Planet',
    colorHex: '#fff7e0',
    note: 'Cloud-shrouded world and brightest planetary beacon in Earth’s sky.',
  },
  mars: {
    category: 'Planet',
    kindDesc: 'Terrestrial Planet',
    colorHex: '#ff8f5c',
    note: 'Iron-oxide desert world exhibiting a warm amber disk.',
  },
  jupiter: {
    category: 'Planet',
    kindDesc: 'Gas Giant',
    colorHex: '#fae6bf',
    note: 'Largest Solar System planet with prominent Galilean cloud belts.',
  },
  saturn: {
    category: 'Planet',
    kindDesc: 'Ringed Gas Giant',
    colorHex: '#f5dea1',
    note: 'Gas giant encircled by icy rings inclined relative to the ecliptic.',
  },
  uranus: {
    category: 'Planet',
    kindDesc: 'Ice Giant',
    colorHex: '#a3ebf5',
    note: 'Cyan methane-rich ice giant rotating nearly sideways.',
  },
  neptune: {
    category: 'Planet',
    kindDesc: 'Ice Giant',
    colorHex: '#75adff',
    note: 'Outermost azure ice giant orbiting 30 AU from the Sun.',
  },
};

const MORPHOLOGY_LABEL: Record<DsoMorphology, string> = {
  galaxy: 'Galaxy',
  nebula: 'Diffuse Nebula',
  planetary_nebula: 'Planetary Nebula',
  globular_cluster: 'Globular Cluster',
  open_cluster: 'Open Cluster',
};

const MORPHOLOGY_COLOR: Record<DsoMorphology, string> = {
  galaxy: '#d9adff',
  nebula: '#f575b8',
  planetary_nebula: '#40ebc7',
  globular_cluster: '#fad15c',
  open_cluster: '#7accff',
};

const ASTRONOMY_BODY_MAP: Record<SolarSystemBodyId, Astronomy.Body> = {
  sun: Astronomy.Body.Sun,
  moon: Astronomy.Body.Moon,
  mercury: Astronomy.Body.Mercury,
  venus: Astronomy.Body.Venus,
  mars: Astronomy.Body.Mars,
  jupiter: Astronomy.Body.Jupiter,
  saturn: Astronomy.Body.Saturn,
  uranus: Astronomy.Body.Uranus,
  neptune: Astronomy.Body.Neptune,
};

const starHipIndexCache = new WeakMap<StarCatalogData, Map<number, number>>();
const constellationMapCache = new WeakMap<LoadedCelestialData, Map<string, ConstellationRecord>>();

export function getStarIndexByHip(stars: StarCatalogData, hip: number): number | undefined {
  let map = starHipIndexCache.get(stars);
  if (!map) {
    map = new Map<number, number>();
    for (let i = 0; i < stars.count; i++) {
      const h = stars.starMeta[i * 4 + 3];
      if (h > 0 && !map.has(h)) {
        map.set(h, i);
      }
    }
    starHipIndexCache.set(stars, map);
  }
  return map.get(hip);
}

function getConstellationMap(catalog: LoadedCelestialData): Map<string, ConstellationRecord> {
  let map = constellationMapCache.get(catalog);
  if (!map) {
    map = new Map(catalog.constellations.map((c) => [c.id, c]));
    constellationMapCache.set(catalog, map);
  }
  return map;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toSrgbByte = (linear: number) => {
    const clamped = Math.max(0, Math.min(1, linear));
    const srgb = Math.pow(clamped, 1 / 2.2);
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${toSrgbByte(r)}${toSrgbByte(g)}${toSrgbByte(b)}`;
}

function formatNumberedCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatClockHHMM(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Maps a B-V color index (and optional Hipparcos ID) to spectral class and effective Kelvin temperature.
 */
export function bvToSpectralClass(bv: number, hip?: number): string {
  const tempK = Math.round(bvToKelvin(bv));
  const tempStr = `${formatNumberedCount(tempK)} K`;

  if (hip && KNOWN_STAR_SPECTRAL[hip]) {
    return `${KNOWN_STAR_SPECTRAL[hip].spectral} · ${tempStr}`;
  }

  const clampedBv = Number.isFinite(bv) ? bv : 0.65;
  let cls: string;
  if (clampedBv < -0.28) {
    cls = 'O8V';
  } else if (clampedBv < -0.02) {
    const sub = Math.min(9, Math.max(0, Math.round(((clampedBv + 0.28) / 0.26) * 9)));
    cls = `B${sub}V`;
  } else if (clampedBv < 0.30) {
    const sub = Math.min(9, Math.max(0, Math.round(((clampedBv + 0.02) / 0.32) * 9)));
    cls = `A${sub}V`;
  } else if (clampedBv < 0.58) {
    const sub = Math.min(9, Math.max(0, Math.round(((clampedBv - 0.30) / 0.28) * 9)));
    cls = `F${sub}V`;
  } else if (clampedBv < 0.81) {
    const sub = Math.min(9, Math.max(0, Math.round(((clampedBv - 0.58) / 0.23) * 9)));
    cls = `G${sub}V`;
  } else if (clampedBv < 1.38) {
    const sub = Math.min(9, Math.max(0, Math.round(((clampedBv - 0.81) / 0.57) * 9)));
    cls = `K${sub}III`;
  } else {
    const sub = Math.min(8, Math.max(0, Math.round(((clampedBv - 1.38) / 0.7) * 8)));
    cls = `M${sub}III`;
  }

  return `${cls} · ${tempStr}`;
}

/**
 * Returns curated Hipparcos/Gaia light-year distances for prominent stars, or a
 * main-sequence spectrophotometric estimate from visual magnitude and B-V color.
 */
export function estimateStarDistanceLabel(vmag: number, bv: number, hip?: number): string {
  if (hip && KNOWN_STAR_SPECTRAL[hip]) {
    return KNOWN_STAR_SPECTRAL[hip].distLy;
  }

  // Approximate main-sequence / giant absolute visual magnitude Mv(B-V)
  const clampedBv = Math.max(-0.35, Math.min(2.0, Number.isFinite(bv) ? bv : 0.65));
  let absMv: number;
  if (clampedBv < 0.0) {
    absMv = -1.5 + (clampedBv + 0.35) * 6.0;
  } else if (clampedBv < 0.85) {
    absMv = 0.6 + clampedBv * 5.8;
  } else {
    // Late K/M stars visible above mag 8 are predominantly giants (luminosity class III)
    absMv = 0.5 - (clampedBv - 0.85) * 0.6;
  }

  const distPc = Math.pow(10, (vmag - absMv + 5) / 5);
  const distLy = Math.max(4, distPc * 3.26156);

  if (distLy >= 1000) {
    return `~${formatNumberedCount(Math.round(distLy / 50) * 50)} ly`;
  }
  if (distLy >= 100) {
    return `~${formatNumberedCount(Math.round(distLy / 10) * 10)} ly`;
  }
  return `~${Math.round(distLy)} ly`;
}

/**
 * Formats distance in light-years or mega-light-years for Deep Sky Objects.
 */
export function formatDsoDistanceLabel(dso: DsoRecord): string {
  if (KNOWN_DSO_DISTANCES[dso.id]) {
    return KNOWN_DSO_DISTANCES[dso.id];
  }
  switch (dso.type) {
    case 'galaxy':
      return dso.mag < 9.5 ? '~25 Mly' : '~55 Mly';
    case 'globular_cluster':
      return '~28,000 ly';
    case 'planetary_nebula':
      return '~3,200 ly';
    case 'open_cluster':
      return '~3,500 ly';
    case 'nebula':
    default:
      return '~4,500 ly';
  }
}

/**
 * Computes today's local Rise, Transit, and Set clock times plus culmination altitude
 * for a celestial coordinate (J2000 RA/Dec in radians) at the observer's latitude/longitude.
 */
export function computeRiseTransitSet(
  raRad: number,
  decRad: number,
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  horizonAltDeg = -0.5667,
): RiseTransitSetTimes {
  const phi = latitudeDeg * DEG_TO_RAD;
  const decDeg = decRad * RAD_TO_DEG;
  const transitAltDeg = 90 - Math.abs(latitudeDeg - decDeg);

  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const lastMidnightRad = computeLocalApparentSiderealTimeRad(localMidnight, longitudeDeg);

  const dTransitRad = (((raRad - lastMidnightRad) % TWO_PI) + TWO_PI) % TWO_PI;
  const transitMs = localMidnight.getTime() + (dTransitRad / TWO_PI) * MS_PER_DAY * SIDEREAL_TO_SOLAR;
  const transitStr = formatClockHHMM(new Date(transitMs));

  const denom = Math.cos(phi) * Math.cos(decRad);
  const sinH0 = Math.sin(horizonAltDeg * DEG_TO_RAD);
  const sinPhiSinDec = Math.sin(phi) * Math.sin(decRad);

  let cosH0: number;
  if (Math.abs(denom) < 1e-8) {
    cosH0 = sinPhiSinDec >= sinH0 ? -2 : 2;
  } else {
    cosH0 = (sinH0 - sinPhiSinDec) / denom;
  }

  if (cosH0 < -1) {
    return {
      rise: 'Circumpolar',
      transit: transitStr,
      transitAltDeg,
      set: 'Circumpolar',
      state: 'circumpolar',
    };
  }

  if (cosH0 > 1) {
    return {
      rise: 'Never rises',
      transit: transitStr,
      transitAltDeg,
      set: 'Never rises',
      state: 'never_rises',
    };
  }

  const h0 = Math.acos(cosH0);
  const dRiseRad = (((raRad - h0 - lastMidnightRad) % TWO_PI) + TWO_PI) % TWO_PI;
  const dSetRad = (((raRad + h0 - lastMidnightRad) % TWO_PI) + TWO_PI) % TWO_PI;

  const riseDate = new Date(localMidnight.getTime() + (dRiseRad / TWO_PI) * MS_PER_DAY * SIDEREAL_TO_SOLAR);
  const setDate = new Date(localMidnight.getTime() + (dSetRad / TWO_PI) * MS_PER_DAY * SIDEREAL_TO_SOLAR);

  return {
    rise: formatClockHHMM(riseDate),
    transit: transitStr,
    transitAltDeg,
    set: formatClockHHMM(setDate),
    state: 'normal',
  };
}

function computeSolarBodyRiseTransitSet(
  bodyId: SolarSystemBodyId,
  date: Date,
  location: ObserverLocation,
): RiseTransitSetTimes {
  const body = ASTRONOMY_BODY_MAP[bodyId];
  const observer = new Astronomy.Observer(location.latitude, location.longitude, location.elevation);
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

  const riseEvent = Astronomy.SearchRiseSet(body, observer, +1, localMidnight, 1, 0);
  const setEvent = Astronomy.SearchRiseSet(body, observer, -1, localMidnight, 1, 0);
  const transitEvent = Astronomy.SearchHourAngle(body, observer, 0, localMidnight, +1);

  const transitAltDeg = transitEvent.hor.altitude;
  const transit = formatClockHHMM(transitEvent.time.date);

  if (!riseEvent && !setEvent) {
    if (transitAltDeg > -0.5) {
      return {
        rise: 'Circumpolar',
        transit,
        transitAltDeg,
        set: 'Circumpolar',
        state: 'circumpolar',
      };
    }
    return {
      rise: 'Never rises',
      transit,
      transitAltDeg,
      set: 'Never rises',
      state: 'never_rises',
    };
  }

  return {
    rise: riseEvent ? formatClockHHMM(riseEvent.date) : '—',
    transit,
    transitAltDeg,
    set: setEvent ? formatClockHHMM(setEvent.date) : '—',
    state: 'normal',
  };
}

const slerpEulerFrom = new THREE.Euler(0, 0, 0, 'YXZ');
const slerpEulerTo = new THREE.Euler(0, 0, 0, 'YXZ');
const slerpQFrom = new THREE.Quaternion();
const slerpQTo = new THREE.Quaternion();
const slerpQOut = new THREE.Quaternion();
const slerpForward = new THREE.Vector3();

/**
 * Smoothly interpolates horizontal look orientation (Azimuth, Altitude) along a true
 * great-circle path via Three.js quaternion slerp while keeping the horizon level.
 */
export function slerpHorizontalLook(
  fromAzDeg: number,
  fromAltDeg: number,
  toAzDeg: number,
  toAltDeg: number,
  t: number,
): { azDeg: number; altDeg: number } {
  const clampedT = Math.max(0, Math.min(1, t));
  slerpEulerFrom.set(fromAltDeg * DEG_TO_RAD, -fromAzDeg * DEG_TO_RAD, 0, 'YXZ');
  slerpEulerTo.set(toAltDeg * DEG_TO_RAD, -toAzDeg * DEG_TO_RAD, 0, 'YXZ');

  slerpQFrom.setFromEuler(slerpEulerFrom);
  slerpQTo.setFromEuler(slerpEulerTo);
  slerpQOut.slerpQuaternions(slerpQFrom, slerpQTo, clampedT);

  slerpForward.set(0, 0, -1).applyQuaternion(slerpQOut);
  const { altDeg, azDeg } = worldVectorToAltAz(slerpForward.x, slerpForward.y, slerpForward.z);
  return {
    azDeg,
    altDeg: Math.max(-80, Math.min(89.5, altDeg)),
  };
}

const tempWorldVec = new THREE.Vector3();

function computeWorldDirFromRaDec(
  raRad: number,
  decRad: number,
  eqToWorld: THREE.Matrix4,
): [number, number, number] {
  const [vx, vy, vz] = raDecToJ2000UnitVector(raRad, decRad);
  tempWorldVec.set(vx, vy, vz).applyMatrix4(eqToWorld).normalize();
  return [tempWorldVec.x, tempWorldVec.y, tempWorldVec.z];
}

function getSolarSystemBody(
  bodyId: SolarSystemBodyId,
  ephemeris: SolarSystemEphemeris,
): SolarSystemBodyState | undefined {
  if (bodyId === 'sun') return ephemeris.sun;
  if (bodyId === 'moon') return ephemeris.moon;
  return ephemeris.planets.find((p) => p.id === bodyId);
}

function formatStarDisplayTitle(
  named: NamedStarEntry | undefined,
  hip: number,
  starIndex: number,
): string {
  if (named?.name) return named.name;
  if (named?.bayer && named.const) return `${named.bayer} ${named.const}`;
  if (named?.flam && named.const) return `${named.flam} ${named.const}`;
  if (hip > 0) return `HIP ${hip}`;
  return `Star #${starIndex + 1}`;
}

/**
 * Computes full live inspection telemetry for any star, planet/Moon/Sun, DSO, constellation, or satellite.
 */
export function computeObjectTelemetry(
  ref: CelestialObjectRef,
  catalog: LoadedCelestialData,
  ephemeris: SolarSystemEphemeris,
  eqToWorld: THREE.Matrix4,
  date: Date,
  location: ObserverLocation,
  satellites: SatelliteTelemetryState[] = [],
  issPasses: SatellitePassPrediction[] = [],
  aircraft: AircraftTelemetryState[] = [],
): InspectedObjectTelemetry | null {
  if (ref.kind === 'planet' && ref.bodyId) {
    const body = getSolarSystemBody(ref.bodyId, ephemeris);
    if (!body) return null;
    const meta = PLANET_META[ref.bodyId];
    const rts = computeSolarBodyRiseTransitSet(ref.bodyId, date, location);

    let subtitle: string;
    if (ref.bodyId === 'moon') {
      subtitle = `${ephemeris.moon.phaseName} · ${Math.round(ephemeris.moon.phaseFraction * 100)}% lit`;
    } else if (ref.bodyId === 'sun') {
      subtitle = `Solar System Anchor · Phase ${Math.round(body.phaseFraction * 100)}%`;
    } else if (ref.bodyId === 'saturn' && typeof body.ringTiltDeg === 'number') {
      subtitle = `${meta.kindDesc} · Ring tilt ${body.ringTiltDeg.toFixed(1)}°`;
    } else {
      subtitle = `${meta.kindDesc} · ${Math.round(body.phaseFraction * 100)}% lit`;
    }

    const distanceLabel =
      ref.bodyId === 'moon'
        ? `${formatNumberedCount(body.distAu * 149_597_870.7)} km`
        : `${body.distAu >= 10 ? body.distAu.toFixed(2) : body.distAu.toFixed(3)} AU`;

    return {
      ref,
      id: ref.id,
      kind: 'planet',
      name: body.name,
      subtitle,
      categoryLabel: meta.category,
      altDeg: body.altDeg,
      azDeg: body.azDeg,
      azCardinal: azimuthToCardinal(body.azDeg),
      raRad: body.raRad,
      decRad: body.decRad,
      raFormatted: formatHMS(body.raRad, true),
      decFormatted: formatDMS(body.decRad * RAD_TO_DEG),
      vmag: body.vmag,
      vmagFormatted: `${body.vmag >= 0 ? '+' : ''}${body.vmag.toFixed(2)}`,
      distanceLabel,
      spectralOrMorphology: ref.bodyId === 'moon' ? ephemeris.moon.phaseName : meta.kindDesc,
      spectralColorHex: meta.colorHex,
      airmass: body.altDeg > 0 ? computeAirmass(body.altDeg) : null,
      rts,
      isAboveHorizon: body.altDeg > -0.5,
      description: meta.note,
      recommendedFovDeg: ref.bodyId === 'moon' || ref.bodyId === 'sun' ? 14 : 20,
      worldDir: body.worldDir,
    };
  }

  if (ref.kind === 'star') {
    const starIndex =
      typeof ref.starIndex === 'number'
        ? ref.starIndex
        : typeof ref.hip === 'number'
          ? getStarIndexByHip(catalog.stars, ref.hip)
          : undefined;
    if (starIndex === undefined || starIndex < 0 || starIndex >= catalog.stars.count) {
      return null;
    }

    const mIdx = starIndex * 4;
    const vmag = catalog.stars.starMeta[mIdx];
    const bv = catalog.stars.starMeta[mIdx + 1];
    const hip = Math.round(catalog.stars.starMeta[mIdx + 3]);
    const rIdx = starIndex * 2;
    const raRad = catalog.stars.raDec[rIdx];
    const decRad = catalog.stars.raDec[rIdx + 1];

    const pIdx = starIndex * 3;
    tempWorldVec
      .set(
        catalog.stars.positionsJ2000[pIdx],
        catalog.stars.positionsJ2000[pIdx + 1],
        catalog.stars.positionsJ2000[pIdx + 2],
      )
      .applyMatrix4(eqToWorld)
      .normalize();

    const { altDeg, azDeg } = worldVectorToAltAz(tempWorldVec.x, tempWorldVec.y, tempWorldVec.z);
    const named = hip > 0 ? catalog.starNames.get(hip) : undefined;
    const constRecord = named?.const ? getConstellationMap(catalog).get(named.const) : undefined;

    const designationParts: string[] = [];
    if (named?.bayer) designationParts.push(named.bayer);
    if (named?.flam) designationParts.push(`${named.flam}`);
    const bayerFlam = designationParts.join(' / ');

    const subtitleParts: string[] = [];
    if (bayerFlam && named?.const) {
      subtitleParts.push(`${bayerFlam} ${constRecord?.genitive || named.const}`);
    } else if (constRecord) {
      subtitleParts.push(`In ${constRecord.name}`);
    }
    if (hip > 0) subtitleParts.push(`HIP ${hip}`);

    const [rgbR, rgbG, rgbB] = bvToRGB(bv);
    const rts = computeRiseTransitSet(raRad, decRad, date, location.latitude, location.longitude);
    const knownMeta = hip > 0 ? KNOWN_STAR_SPECTRAL[hip] : undefined;

    return {
      ref: { id: ref.id, kind: 'star', starIndex, hip: hip > 0 ? hip : undefined },
      id: ref.id,
      kind: 'star',
      name: formatStarDisplayTitle(named, hip, starIndex),
      subtitle: subtitleParts.join(' · ') || 'Hipparcos Catalog Star',
      categoryLabel: 'Star',
      altDeg,
      azDeg,
      azCardinal: azimuthToCardinal(azDeg),
      raRad,
      decRad,
      raFormatted: formatHMS(raRad, true),
      decFormatted: formatDMS(decRad * RAD_TO_DEG),
      vmag,
      vmagFormatted: `${vmag >= 0 ? '+' : ''}${vmag.toFixed(2)}`,
      distanceLabel: estimateStarDistanceLabel(vmag, bv, hip),
      spectralOrMorphology: bvToSpectralClass(bv, hip),
      spectralColorHex: rgbToHex(rgbR, rgbG, rgbB),
      airmass: altDeg > 0 ? computeAirmass(altDeg) : null,
      rts,
      isAboveHorizon: altDeg > -0.5,
      description:
        knownMeta?.note ||
        `Hipparcos catalog star with B−V color index ${bv >= 0 ? '+' : ''}${bv.toFixed(2)}.`,
      recommendedFovDeg: 28,
      worldDir: [tempWorldVec.x, tempWorldVec.y, tempWorldVec.z],
    };
  }

  if (ref.kind === 'dso' && ref.dsoId) {
    const dso = catalog.dsos.find((d) => d.id === ref.dsoId);
    if (!dso) return null;

    const worldDir = computeWorldDirFromRaDec(dso.raRad, dso.decRad, eqToWorld);
    const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
    const morphLabel = MORPHOLOGY_LABEL[dso.type];
    const rts = computeRiseTransitSet(dso.raRad, dso.decRad, date, location.latitude, location.longitude);
    const hasDistinctCommonName =
      Boolean(dso.name) && dso.name !== dso.id && dso.name !== dso.ngc;

    const name = hasDistinctCommonName ? `${dso.id} · ${dso.name}` : dso.id;
    const sizeLabel =
      dso.minorArcmin && Math.abs(dso.minorArcmin - dso.sizeArcmin) > 0.2
        ? `${dso.sizeArcmin}' × ${dso.minorArcmin}'`
        : `${dso.sizeArcmin}'`;

    return {
      ref,
      id: ref.id,
      kind: 'dso',
      name,
      subtitle: `${dso.catalog} Catalog · ${dso.ngc}`,
      categoryLabel: morphLabel,
      altDeg,
      azDeg,
      azCardinal: azimuthToCardinal(azDeg),
      raRad: dso.raRad,
      decRad: dso.decRad,
      raFormatted: formatHMS(dso.raRad, true),
      decFormatted: formatDMS(dso.decRad * RAD_TO_DEG),
      vmag: dso.mag,
      vmagFormatted: `${dso.mag >= 0 ? '+' : ''}${dso.mag.toFixed(1)}`,
      distanceLabel: formatDsoDistanceLabel(dso),
      spectralOrMorphology: `${morphLabel} · ${sizeLabel}`,
      spectralColorHex: MORPHOLOGY_COLOR[dso.type],
      airmass: altDeg > 0 ? computeAirmass(altDeg) : null,
      rts,
      isAboveHorizon: altDeg > -0.5,
      description: `${morphLabel} (${dso.ngc}) spanning ${sizeLabel} in apparent angular diameter.`,
      recommendedFovDeg: Math.max(12, Math.min(34, (dso.sizeArcmin / 60) * 14 + 14)),
      worldDir,
    };
  }

  if (ref.kind === 'constellation' && ref.constellationId) {
    const c = getConstellationMap(catalog).get(ref.constellationId);
    if (!c) return null;

    const worldDir = computeWorldDirFromRaDec(c.labelRaRad, c.labelDecRad, eqToWorld);
    const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
    const rts = computeRiseTransitSet(c.labelRaRad, c.labelDecRad, date, location.latitude, location.longitude);

    return {
      ref,
      id: ref.id,
      kind: 'constellation',
      name: c.name,
      subtitle: `IAU ${c.id} · Genitive: ${c.genitive || c.name}`,
      categoryLabel: 'Constellation',
      altDeg,
      azDeg,
      azCardinal: azimuthToCardinal(azDeg),
      raRad: c.labelRaRad,
      decRad: c.labelDecRad,
      raFormatted: formatHMS(c.labelRaRad, true),
      decFormatted: formatDMS(c.labelDecRad * RAD_TO_DEG),
      vmag: null,
      vmagFormatted: '—',
      distanceLabel: 'Celestial Region',
      spectralOrMorphology: 'IAU 88 Constellation',
      spectralColorHex: '#56a3ff',
      airmass: altDeg > 0 ? computeAirmass(altDeg) : null,
      rts,
      isAboveHorizon: altDeg > -0.5,
      description: `Official IAU constellation ${c.name} (${c.id}) with ${c.lines.length} stick-figure asterisms.`,
      recommendedFovDeg: 58,
      worldDir,
    };
  }

  if (ref.kind === 'satellite' && typeof ref.satNoradId === 'number') {
    const sat = satellites.find((s) => s.noradId === ref.satNoradId);
    if (!sat) return null;

    const matchingPass =
      sat.noradId === 25544
        ? issPasses.find((p) => p.endTimeMs >= date.getTime()) ?? issPasses[0]
        : undefined;

    const rts: RiseTransitSetTimes = matchingPass
      ? {
          rise: formatClockHHMM(new Date(matchingPass.startTimeMs)),
          transit: formatClockHHMM(new Date(matchingPass.maxTimeMs)),
          transitAltDeg: matchingPass.maxAltDeg,
          set: formatClockHHMM(new Date(matchingPass.endTimeMs)),
          state: 'normal',
        }
      : {
          rise: sat.isAboveHorizon ? 'In Pass' : 'Next Pass',
          transit: 'LEO ~92m',
          transitAltDeg: Math.max(0, sat.altDeg),
          set: sat.isAboveHorizon ? 'In Pass' : '—',
          state: 'normal',
        };

    const latLabel = `${Math.abs(sat.subLatDeg).toFixed(1)}°${sat.subLatDeg >= 0 ? 'N' : 'S'}`;
    const lonLabel = `${Math.abs(sat.subLonDeg).toFixed(1)}°${sat.subLonDeg >= 0 ? 'E' : 'W'}`;

    return {
      ref,
      id: sat.id,
      kind: 'satellite',
      name: sat.name,
      subtitle: `${sat.category} · NORAD ${sat.noradId} · ${sat.isSunlit ? 'Sunlit' : 'In Earth Shadow'}`,
      categoryLabel: sat.category,
      altDeg: sat.altDeg,
      azDeg: sat.azDeg,
      azCardinal: sat.azCardinal,
      raRad: sat.raRad,
      decRad: sat.decRad,
      raFormatted: formatHMS(sat.raRad, true),
      decFormatted: formatDMS(sat.decRad * RAD_TO_DEG),
      vmag: sat.vmag,
      vmagFormatted: `${sat.vmag >= 0 ? '+' : ''}${sat.vmag.toFixed(1)}`,
      distanceLabel: `${formatNumberedCount(sat.rangeKm)} km`,
      spectralOrMorphology: `Alt ${formatNumberedCount(sat.altitudeKm)} km · ${sat.speedKmS.toFixed(2)} km/s`,
      spectralColorHex: sat.colorHex,
      airmass: sat.altDeg > 0 ? computeAirmass(sat.altDeg) : null,
      rts,
      isAboveHorizon: sat.isAboveHorizon,
      description: `${sat.description} Ground track: ${latLabel}, ${lonLabel}.`,
      recommendedFovDeg: sat.noradId === 25544 ? 32 : 36,
      worldDir: sat.worldDir,
    };
  }

  if (ref.kind === 'aircraft' && ref.aircraftHex) {
    const ac = aircraft.find((a) => a.hex === ref.aircraftHex);
    if (!ac) return null;

    const modelTitle = ac.modelDesc || ac.typeCode;
    const name = modelTitle ? `${ac.callsign} (${modelTitle})` : ac.callsign;
    const subtitle = `${ac.operator || 'ADS-B Transponder'} · Reg ${ac.registration || '—'} · ICAO ${ac.hex.toUpperCase()}`;
    const vRateFormatted = `${ac.verticalRateFpm >= 0 ? '+' : ''}${Math.round(ac.verticalRateFpm)} fpm`;

    return {
      ref,
      id: ac.id,
      kind: 'aircraft',
      name,
      subtitle,
      categoryLabel: `Aircraft · ${ac.typeCode || 'ADS-B'}`,
      altDeg: ac.altDeg,
      azDeg: ac.azDeg,
      azCardinal: ac.azCardinal,
      raRad: ac.raRad,
      decRad: ac.decRad,
      raFormatted: formatHMS(ac.raRad, true),
      decFormatted: formatDMS(ac.decRad * RAD_TO_DEG),
      vmag: ac.vmag,
      vmagFormatted: `${ac.flightLevel} (${Math.round(ac.altitudeFt).toLocaleString('en-US')} ft)`,
      distanceLabel: `${ac.slantRangeKm.toFixed(1)} km slant (${ac.groundDistanceKm.toFixed(1)} km ground)`,
      spectralOrMorphology: `${modelTitle || 'Airborne Craft'} · ${Math.round(ac.groundSpeedKt)} kt (${Math.round(ac.speedKmh)} km/h)`,
      spectralColorHex: ac.colorHex,
      airmass: ac.altDeg > 0 ? computeAirmass(ac.altDeg) : null,
      rts: {
        rise: ac.flightLevel,
        transit: `HDG ${Math.round(ac.trackDeg)}° ${ac.trackCardinal}`,
        transitAltDeg: Math.max(0, ac.altDeg),
        set: vRateFormatted,
        state: 'normal',
      },
      isAboveHorizon: ac.isAboveHorizon,
      description: ac.description,
      recommendedFovDeg: 32,
      worldDir: ac.worldDir,
    };
  }

  return null;
}

function matchQueryScore(query: string, fields: string[], bonus = 0): number {
  if (!query) return 100 + bonus;

  let best = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]?.toLowerCase() ?? '';
    if (!f) continue;
    const weight = i === 0 ? 1.0 : 0.75;
    if (f === query) {
      best = Math.max(best, 220 * weight);
    } else if (f.startsWith(query)) {
      best = Math.max(best, 165 * weight);
    } else if (f.includes(query)) {
      best = Math.max(best, 115 * weight);
    }
  }
  return best > 0 ? best + bonus : 0;
}

/**
 * Instant search across planets, Sun/Moon, Hipparcos stars, Messier/Caldwell DSOs, constellations, and satellites.
 */
export function searchCelestialCatalog(
  query: string,
  filterKind: CelestialObjectKind | 'all',
  catalog: LoadedCelestialData,
  ephemeris: SolarSystemEphemeris,
  eqToWorld: THREE.Matrix4,
  maxResults = 32,
  satellites: SatelliteTelemetryState[] = [],
  aircraft: AircraftTelemetryState[] = [],
): SearchResultItem[] {
  const q = query.trim().toLowerCase();
  const results: SearchResultItem[] = [];
  const constMap = getConstellationMap(catalog);

  // -1. Live Airborne Aircraft (ADS-B)
  if (filterKind === 'all' || filterKind === 'aircraft') {
    for (const ac of aircraft) {
      const proximityBonus = Math.max(0, 10 - ac.slantRangeKm * 0.2);
      const emptyFilterOffset = !q && filterKind === 'all' ? -10 : 0;
      const match = matchQueryScore(
        q,
        [
          ac.callsign,
          ac.registration,
          ac.typeCode,
          ac.modelDesc,
          ac.operator,
          ac.hex,
          ac.flightLevel,
        ],
        (ac.isAboveHorizon ? 14 : -15) + proximityBonus + emptyFilterOffset,
      );
      if (match > 0) {
        results.push({
          ref: { id: ac.id, kind: 'aircraft', aircraftHex: ac.hex },
          id: ac.id,
          kind: 'aircraft',
          name: ac.displayName,
          subtitle: `${ac.flightLevel} · ${Math.round(ac.groundSpeedKt)} kt · ${ac.slantRangeKm.toFixed(1)} km${ac.operator ? ` · ${ac.operator}` : ''}`,
          categoryBadge: ac.typeCode ? `Aircraft · ${ac.typeCode}` : 'Aircraft',
          vmag: ac.vmag,
          altDeg: ac.altDeg,
          azCardinal: ac.azCardinal,
          isAboveHorizon: ac.isAboveHorizon,
          score: match,
        });
      }
    }
  }

  // 0. Live Satellites & Space Stations
  if (filterKind === 'all' || filterKind === 'satellite') {
    for (const sat of satellites) {
      const match = matchQueryScore(
        q,
        [sat.name, sat.shortName, String(sat.noradId), `NORAD ${sat.noradId}`, sat.category],
        (sat.isAboveHorizon ? 20 : 0) + (sat.noradId === 25544 ? 16 : 6),
      );
      if (match > 0) {
        results.push({
          ref: { id: sat.id, kind: 'satellite', satNoradId: sat.noradId },
          id: sat.id,
          kind: 'satellite',
          name: sat.name,
          subtitle: `NORAD ${sat.noradId} · ${Math.round(sat.altitudeKm)} km · ${sat.isSunlit ? 'Sunlit' : 'Shadowed'}`,
          categoryBadge: sat.category,
          vmag: sat.vmag,
          altDeg: sat.altDeg,
          azCardinal: sat.azCardinal,
          isAboveHorizon: sat.isAboveHorizon,
          score: match,
        });
      }
    }
  }

  // 1. Solar System bodies (Moon, Sun, Mercury..Neptune)
  if (filterKind === 'all' || filterKind === 'planet') {
    const bodies = [ephemeris.moon, ephemeris.sun, ...ephemeris.planets];
    for (const body of bodies) {
      const meta = PLANET_META[body.id];
      const match = matchQueryScore(
        q,
        [body.name, body.id, meta.category, meta.kindDesc],
        (body.altDeg > 0 ? 22 : 0) + (body.id === 'moon' || body.id === 'jupiter' || body.id === 'saturn' ? 14 : 8),
      );
      if (match > 0) {
        results.push({
          ref: { id: `body-${body.id}`, kind: 'planet', bodyId: body.id },
          id: `body-${body.id}`,
          kind: 'planet',
          name: body.name,
          subtitle: body.id === 'moon' ? ephemeris.moon.phaseName : meta.kindDesc,
          categoryBadge: meta.category,
          vmag: body.vmag,
          altDeg: body.altDeg,
          azCardinal: azimuthToCardinal(body.azDeg),
          isAboveHorizon: body.altDeg > -0.5,
          score: match,
        });
      }
    }
  }

  // 2. Named & bright Hipparcos stars
  if (filterKind === 'all' || filterKind === 'star') {
    const hipMatch = q.match(/^hip\s*(\d+)$/i) ?? (/^\d{2,6}$/.test(q) ? [q, q] : null);
    if (hipMatch) {
      const targetHip = Number(hipMatch[1]);
      const starIndex = getStarIndexByHip(catalog.stars, targetHip);
      if (starIndex !== undefined) {
        const mIdx = starIndex * 4;
        const vmag = catalog.stars.starMeta[mIdx];
        const rIdx = starIndex * 2;
        const raRad = catalog.stars.raDec[rIdx];
        const decRad = catalog.stars.raDec[rIdx + 1];
        const worldDir = computeWorldDirFromRaDec(raRad, decRad, eqToWorld);
        const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
        const named = catalog.starNames.get(targetHip);
        results.push({
          ref: { id: `star-${targetHip}`, kind: 'star', starIndex, hip: targetHip },
          id: `star-${targetHip}`,
          kind: 'star',
          name: formatStarDisplayTitle(named, targetHip, starIndex),
          subtitle: `HIP ${targetHip}${named?.const ? ` · ${named.const}` : ''}`,
          categoryBadge: 'Star',
          vmag,
          altDeg,
          azCardinal: azimuthToCardinal(azDeg),
          isAboveHorizon: altDeg > -0.5,
          score: 240,
        });
      }
    }

    for (const entry of catalog.starNames.values()) {
      if (!entry.name && !entry.bayer && entry.mag > 3.2) continue;
      const constName = entry.const ? constMap.get(entry.const)?.name ?? entry.const : '';
      const bayerFull = entry.bayer ? `${entry.bayer} ${entry.const}` : '';
      const flamFull = entry.flam ? `${entry.flam} ${entry.const}` : '';
      const title = entry.name || bayerFull || flamFull || `HIP ${entry.hip}`;
      const match = matchQueryScore(
        q,
        [title, entry.name, bayerFull, flamFull, `HIP ${entry.hip}`, constName],
        Math.max(0, 14 - entry.mag * 3),
      );
      if (match > 0) {
        const id = `star-${entry.hip}`;
        if (results.some((r) => r.id === id)) continue;
        const starIndex = getStarIndexByHip(catalog.stars, entry.hip);
        if (starIndex === undefined) continue;
        const worldDir = computeWorldDirFromRaDec(entry.raRad, entry.decRad, eqToWorld);
        const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
        results.push({
          ref: { id, kind: 'star', starIndex, hip: entry.hip },
          id,
          kind: 'star',
          name: title,
          subtitle: [bayerFull || flamFull, constName || entry.const, `HIP ${entry.hip}`]
            .filter(Boolean)
            .join(' · '),
          categoryBadge: 'Star',
          vmag: entry.mag,
          altDeg,
          azCardinal: azimuthToCardinal(azDeg),
          isAboveHorizon: altDeg > -0.5,
          score: match + (altDeg > 0 ? 12 : 0),
        });
      }
    }
  }

  // 3. Messier + Caldwell Deep Sky Objects
  if (filterKind === 'all' || filterKind === 'dso') {
    for (const dso of catalog.dsos) {
      const hasCommon = Boolean(dso.name) && dso.name !== dso.id && dso.name !== dso.ngc;
      const displayName = hasCommon ? `${dso.id} · ${dso.name}` : dso.id;
      const morph = MORPHOLOGY_LABEL[dso.type];
      const match = matchQueryScore(
        q,
        [dso.id, dso.name, dso.ngc, morph, dso.catalog],
        Math.max(0, 12 - dso.mag),
      );
      if (match > 0) {
        const worldDir = computeWorldDirFromRaDec(dso.raRad, dso.decRad, eqToWorld);
        const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
        results.push({
          ref: { id: `dso-${dso.id}`, kind: 'dso', dsoId: dso.id },
          id: `dso-${dso.id}`,
          kind: 'dso',
          name: displayName,
          subtitle: `${morph} · ${dso.ngc}`,
          categoryBadge: dso.catalog,
          vmag: dso.mag,
          altDeg,
          azCardinal: azimuthToCardinal(azDeg),
          isAboveHorizon: altDeg > -0.5,
          score: match + (altDeg > 0 ? 10 : 0),
        });
      }
    }
  }

  // 4. 88 IAU Constellations
  if (filterKind === 'all' || filterKind === 'constellation') {
    for (const c of catalog.constellations) {
      const match = matchQueryScore(
        q,
        [c.name, c.id, c.genitive],
        (4 - c.rank) * 4,
      );
      if (match > 0) {
        const worldDir = computeWorldDirFromRaDec(c.labelRaRad, c.labelDecRad, eqToWorld);
        const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
        results.push({
          ref: { id: `const-${c.id}`, kind: 'constellation', constellationId: c.id },
          id: `const-${c.id}`,
          kind: 'constellation',
          name: c.name,
          subtitle: `IAU Constellation (${c.id})`,
          categoryBadge: 'Constellation',
          vmag: null,
          altDeg,
          azCardinal: azimuthToCardinal(azDeg),
          isAboveHorizon: altDeg > -0.5,
          score: match + (altDeg > 0 ? 8 : 0),
        });
      }
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.vmag ?? 99) - (b.vmag ?? 99);
  });

  return results.slice(0, maxResults);
}

function computeTonightEvaluationDate(now: Date, longitudeDeg: number): Date {
  const approxOffsetHours = Math.round(longitudeDeg / 15);
  const targetUtcHour = ((22.25 - approxOffsetHours) % 24 + 24) % 24;
  const preset = new Date(now.getTime());
  const hours = Math.floor(targetUtcHour);
  const minutes = Math.floor((targetUtcHour - hours) * 60);
  preset.setUTCHours(hours, minutes, 0, 0);
  return preset;
}

/**
 * Generates a curated "Tonight's Best" guided sky tour ranking visible planets,
 * the Moon, showpiece Deep Sky Objects, and bright navigation stars above the observer's horizon.
 */
export function buildTonightsBestTour(
  catalog: LoadedCelestialData,
  location: ObserverLocation,
  observedDate: Date,
): { stops: TourStopItem[]; evalDate: Date; isDaylightPreview: boolean } {
  const currentSun = computeSunPosition(
    observedDate,
    location.latitude,
    location.longitude,
    location.elevation,
  );
  const isDaylightPreview = currentSun.altDeg > -6;
  const evalDate = isDaylightPreview
    ? computeTonightEvaluationDate(observedDate, location.longitude)
    : observedDate;

  const eqToWorld = computeEquatorialToWorldMatrix4(evalDate, location.latitude, location.longitude);
  const ephemeris = computeSolarSystemEphemeris(
    evalDate,
    location.latitude,
    location.longitude,
    location.elevation,
  );

  const planetCandidates: TourStopItem[] = [];
  if (ephemeris.moon.altDeg >= 8 && ephemeris.moon.phaseFraction >= 0.03) {
    planetCandidates.push({
      stepIndex: 0,
      ref: { id: 'body-moon', kind: 'planet', bodyId: 'moon' },
      id: 'body-moon',
      kind: 'planet',
      name: 'Moon',
      subtitle: `${ephemeris.moon.phaseName} · ${Math.round(ephemeris.moon.phaseFraction * 100)}% illuminated`,
      categoryBadge: 'Lunar',
      vmag: ephemeris.moon.vmag,
      altDeg: ephemeris.moon.altDeg,
      azDeg: ephemeris.moon.azDeg,
      azCardinal: azimuthToCardinal(ephemeris.moon.azDeg),
      highlightNote: `${ephemeris.moon.phaseName} at ${ephemeris.moon.altDeg.toFixed(0)}° altitude — inspect crater relief along the terminator.`,
      recommendedFovDeg: 14,
      score: 140 + ephemeris.moon.altDeg * 0.4,
    });
  }

  for (const p of ephemeris.planets) {
    if (p.altDeg < 10 || p.vmag > 6.0) continue;
    const meta = PLANET_META[p.id];
    planetCandidates.push({
      stepIndex: 0,
      ref: { id: `body-${p.id}`, kind: 'planet', bodyId: p.id },
      id: `body-${p.id}`,
      kind: 'planet',
      name: p.name,
      subtitle: meta.kindDesc,
      categoryBadge: 'Planet',
      vmag: p.vmag,
      altDeg: p.altDeg,
      azDeg: p.azDeg,
      azCardinal: azimuthToCardinal(p.azDeg),
      highlightNote: `${meta.note} Currently ${p.altDeg.toFixed(0)}° high in the ${azimuthToCardinal(p.azDeg)}.`,
      recommendedFovDeg: 20,
      score: 115 - p.vmag * 6 + p.altDeg * 0.45,
    });
  }
  planetCandidates.sort((a, b) => b.score - a.score);

  const dsoCandidates: TourStopItem[] = [];
  for (const dso of catalog.dsos) {
    if (dso.mag > 9.0) continue;
    const worldDir = computeWorldDirFromRaDec(dso.raRad, dso.decRad, eqToWorld);
    const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
    if (altDeg < 18) continue;

    const morph = MORPHOLOGY_LABEL[dso.type];
    const hasCommon = Boolean(dso.name) && dso.name !== dso.id && dso.name !== dso.ngc;
    const displayName = hasCommon ? `${dso.id} · ${dso.name}` : dso.id;
    const sizeBonus = Math.min(28, dso.sizeArcmin * 0.35);
    const score = 95 - dso.mag * 4.5 + altDeg * 0.45 + sizeBonus + (dso.catalog === 'Messier' ? 8 : 0);

    dsoCandidates.push({
      stepIndex: 0,
      ref: { id: `dso-${dso.id}`, kind: 'dso', dsoId: dso.id },
      id: `dso-${dso.id}`,
      kind: 'dso',
      name: displayName,
      subtitle: `${morph} · ${dso.ngc}`,
      categoryBadge: dso.catalog,
      vmag: dso.mag,
      altDeg,
      azDeg,
      azCardinal: azimuthToCardinal(azDeg),
      highlightNote: `Bright ${morph.toLowerCase()} (${dso.sizeArcmin}' across) well-placed at ${altDeg.toFixed(0)}° ${azimuthToCardinal(azDeg)}.`,
      recommendedFovDeg: Math.max(14, Math.min(34, (dso.sizeArcmin / 60) * 14 + 14)),
      score,
    });
  }
  dsoCandidates.sort((a, b) => b.score - a.score);

  const starCandidates: TourStopItem[] = [];
  for (const star of catalog.namedStarList) {
    if (star.mag > 2.2) break;
    const starIndex = getStarIndexByHip(catalog.stars, star.hip);
    if (starIndex === undefined) continue;
    const worldDir = computeWorldDirFromRaDec(star.raRad, star.decRad, eqToWorld);
    const { altDeg, azDeg } = worldVectorToAltAz(worldDir[0], worldDir[1], worldDir[2]);
    if (altDeg < 20) continue;

    const spec = bvToSpectralClass(star.bv, star.hip);
    const known = KNOWN_STAR_SPECTRAL[star.hip];

    starCandidates.push({
      stepIndex: 0,
      ref: { id: `star-${star.hip}`, kind: 'star', starIndex, hip: star.hip },
      id: `star-${star.hip}`,
      kind: 'star',
      name: star.name,
      subtitle: `${spec} · ${star.const}`,
      categoryBadge: 'Bright Star',
      vmag: star.mag,
      altDeg,
      azDeg,
      azCardinal: azimuthToCardinal(azDeg),
      highlightNote: known?.note || `Magnitude ${star.mag.toFixed(2)} (${spec}) shining at ${altDeg.toFixed(0)}° ${azimuthToCardinal(azDeg)}.`,
      recommendedFovDeg: 36,
      score: 88 - star.mag * 7 + altDeg * 0.35,
    });
  }
  starCandidates.sort((a, b) => b.score - a.score);

  // Pick up to 10 diverse tour stops: up to 4 Solar System, up to 4 DSOs, and top bright stars to fill
  const selected: TourStopItem[] = [];
  selected.push(...planetCandidates.slice(0, 4));
  selected.push(...dsoCandidates.slice(0, 4));

  const remainingSlots = Math.max(0, 10 - selected.length);
  selected.push(...starCandidates.slice(0, remainingSlots));

  if (selected.length < 10) {
    for (const dso of dsoCandidates.slice(4)) {
      if (selected.length >= 10) break;
      selected.push(dso);
    }
  }

  // Sweep smoothly in azimuth starting from East (90° -> 180° -> 270° -> 360°/0° -> 90°)
  selected.sort((a, b) => {
    const aSweep = (a.azDeg - 60 + 360) % 360;
    const bSweep = (b.azDeg - 60 + 360) % 360;
    return aSweep - bSweep;
  });

  const stops = selected.map((item, idx) => ({
    ...item,
    stepIndex: idx,
  }));

  return { stops, evalDate, isDaylightPreview };
}
