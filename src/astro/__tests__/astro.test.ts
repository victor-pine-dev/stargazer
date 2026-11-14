import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error jsdom does not ship TypeScript declarations in devDependencies
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseStarBinary, type ConstellationRecord, type DsoRecord, type NamedStarEntry } from '../../data/catalogLoader';
import {
  altAzToWorldVector,
  computeEquatorialToWorldMatrix4,
  computeLocalApparentSiderealTimeRad,
  computeSunPosition,
  DEG_TO_RAD,
  raDecToAltAz,
  raDecToJ2000UnitVector,
  worldVectorToAltAz,
} from '../coordinates';
import { classifyLunarPhase, computeSolarSystemEphemeris } from '../solarSystem';
import { bvToKelvin, bvToRGB, computeAirmass, magnitudeToFlux } from '../spectral';
import {
  buildTonightsBestTour,
  bvToSpectralClass,
  computeObjectTelemetry,
  computeRiseTransitSet,
  estimateStarDistanceLabel,
  formatDsoDistanceLabel,
  searchCelestialCatalog,
  slerpHorizontalLook,
} from '../celestialIndex';
import { DEFAULT_LOCATION } from '../../services/locationService';
import {
  computeSatelliteOrbitArc,
  DEFAULT_SATELLITE_TLES,
  ISS_NORAD_ID,
  mergeTleUpdates,
  parseThreeLineTleText,
  predictUpcomingPasses,
  propagateAllSatellites,
  propagateSatelliteState,
} from '../satellites';
import { deviceOrientationToSkyLook } from '../../services/gyroService';
import {
  computeAircraftLookAngles,
  computeAircraftSkyArc,
  extrapolateAircraftGeodetic,
  generateSimulatedCorridorTraffic,
  parseOpenSkyResponse,
  parseReadsbResponse,
  propagateAircraftState,
} from '../aircraft';
import {
  evaluateMeteorState,
  MeteorShowerController,
  slerpUnitVectors,
  spawnMeteorTrajectory,
} from '../meteors';
import { CalmAudioController } from '../../services/calmAudioService';

describe('Astronomical Coordinate & Sidereal Math', () => {
  it('converts RA/Dec to orthonormal J2000 unit vectors', () => {
    const [x0, y0, z0] = raDecToJ2000UnitVector(0, 0);
    expect(x0).toBeCloseTo(1, 6);
    expect(y0).toBeCloseTo(0, 6);
    expect(z0).toBeCloseTo(0, 6);

    const [x1, y1, z1] = raDecToJ2000UnitVector(Math.PI / 2, 0);
    expect(x1).toBeCloseTo(0, 6);
    expect(y1).toBeCloseTo(1, 6);
    expect(z1).toBeCloseTo(0, 6);

    const [x2, y2, z2] = raDecToJ2000UnitVector(1.23, Math.PI / 2);
    expect(x2).toBeCloseTo(0, 6);
    expect(y2).toBeCloseTo(0, 6);
    expect(z2).toBeCloseTo(1, 6);
  });

  it('produces a proper orthonormal SO(3) Equatorial-to-World Matrix4', () => {
    const date = new Date('2026-11-14T23:15:00Z');
    const mat = computeEquatorialToWorldMatrix4(date, 40.7128, -74.006);
    expect(mat.determinant()).toBeCloseTo(1, 6);

    const m3 = new THREE.Matrix3().setFromMatrix4(mat);
    const mt = m3.clone().transpose();
    const product = m3.clone().multiply(mt);
    const e = product.elements;
    expect(e[0]).toBeCloseTo(1, 6);
    expect(e[4]).toBeCloseTo(1, 6);
    expect(e[8]).toBeCloseTo(1, 6);
    expect(e[1]).toBeCloseTo(0, 6);
    expect(e[2]).toBeCloseTo(0, 6);
    expect(e[5]).toBeCloseTo(0, 6);
  });

  it('places a star at Zenith when RA == LAST and Dec == observer latitude', () => {
    const date = new Date('2026-06-21T04:00:00Z');
    const lat = 37.7749;
    const lon = -122.4194;
    const lastRad = computeLocalApparentSiderealTimeRad(date, lon);

    const { altDeg } = raDecToAltAz(lastRad, lat * DEG_TO_RAD, date, lat, lon);
    expect(altDeg).toBeCloseTo(90, 4);
  });

  it('places Polaris near North at altitude equal to northern observer latitude', () => {
    const polarisRaRad = 37.9545 * DEG_TO_RAD;
    const polarisDecRad = 89.2641 * DEG_TO_RAD;

    for (const iso of ['2026-01-15T03:00:00Z', '2026-07-15T15:30:00Z']) {
      const date = new Date(iso);
      for (const lat of [19.8207, 40.7128, 64.1466]) {
        const { altDeg, azDeg } = raDecToAltAz(polarisRaRad, polarisDecRad, date, lat, -74.006);
        expect(Math.abs(altDeg - lat)).toBeLessThan(0.8);
        const distFromNorth = Math.min(azDeg, 360 - azDeg);
        expect(distFromNorth).toBeLessThan(2.5);
      }
    }
  });

  it('round-trips altAzToWorldVector and worldVectorToAltAz', () => {
    for (const [alt, az] of [
      [0, 0],
      [25.5, 90],
      [45, 215.25],
      [-15, 315],
    ]) {
      const [x, y, z] = altAzToWorldVector(alt, az);
      const back = worldVectorToAltAz(x, y, z);
      expect(back.altDeg).toBeCloseTo(alt, 5);
      expect(back.azDeg).toBeCloseTo(az, 5);
    }
  });

  it('computes realistic topocentric solar position and twilight phase', () => {
    // Solar noon around New York in November (Sun above horizon, South-ish)
    const noonNyc = new Date('2026-11-14T16:45:00Z');
    const daySun = computeSunPosition(noonNyc, 40.7128, -74.006, 10);
    expect(daySun.altDeg).toBeGreaterThan(25);
    expect(daySun.twilightPhase).toBe('Daylight');

    // Midnight in New York (Sun well below horizon)
    const nightNyc = new Date('2026-11-14T05:00:00Z');
    const nightSun = computeSunPosition(nightNyc, 40.7128, -74.006, 10);
    expect(nightSun.altDeg).toBeLessThan(-18);
    expect(nightSun.twilightPhase).toBe('Night');
  });
});

describe('Spectral Blackbody, Flux & Airmass Math', () => {
  it('evaluates Ballesteros B-V to Kelvin formula accurately', () => {
    expect(bvToKelvin(0.0)).toBeCloseTo(10125.6, 0);
    expect(bvToKelvin(0.65)).toBeCloseTo(5778.4, 0);
    expect(bvToKelvin(1.5)).toBeCloseTo(3793.5, 0);
  });

  it('maps blue O/B stars to blue-dominant RGB and red K/M stars to red-dominant RGB', () => {
    const [rBlue, , bBlue] = bvToRGB(-0.25);
    expect(bBlue).toBeGreaterThan(rBlue);

    const [rRed, , bRed] = bvToRGB(1.55);
    expect(rRed).toBeGreaterThan(bRed);
  });

  it('scales visual magnitude flux by 100x per 5 magnitudes', () => {
    const f0 = magnitudeToFlux(0);
    const f5 = magnitudeToFlux(5);
    expect(f0 / f5).toBeCloseTo(100, 6);
  });

  it('computes Kasten-Young airmass monotonically increasing toward horizon', () => {
    const amZenith = computeAirmass(90);
    const am30 = computeAirmass(30);
    const am5 = computeAirmass(5);
    expect(amZenith).toBeCloseTo(1.0, 2);
    expect(am30).toBeCloseTo(2.0, 1);
    expect(am5).toBeGreaterThan(9.5);
    expect(am5).toBeLessThan(11.5);
  });
});

describe('Celestial Binary & Constellation Dataset Integrity', () => {
  it('parses stars.bin cleanly with >30,000 stars sorted brightest-first', () => {
    const binPath = resolve(process.cwd(), 'public/data/stars.bin');
    const raw = readFileSync(binPath);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const catalog = parseStarBinary(buf);

    expect(catalog.count).toBeGreaterThan(30000);
    // Brightest star should be Sirius (HIP 32349, Vmag ~ -1.44)
    expect(catalog.starMeta[0]).toBeCloseTo(-1.44, 1);
    expect(catalog.starMeta[3]).toBe(32349);
  });

  it('contains all 88 unique IAU constellations and named navigation stars', () => {
    const constPath = resolve(process.cwd(), 'public/data/constellations.json');
    const constellations = JSON.parse(readFileSync(constPath, 'utf8')) as ConstellationRecord[];
    expect(constellations.length).toBe(88);

    const ids = new Set(constellations.map((c) => c.id));
    expect(ids.size).toBe(88);
    expect(ids.has('Ori')).toBe(true);
    expect(ids.has('UMa')).toBe(true);
    expect(ids.has('Ser')).toBe(true);

    const namesPath = resolve(process.cwd(), 'public/data/star-names.json');
    const names = JSON.parse(readFileSync(namesPath, 'utf8')) as Record<string, NamedStarEntry>;
    expect(names['32349']?.name).toBe('Sirius');
    expect(names['11767']?.name).toBe('Polaris');
    expect(names['91262']?.name).toBe('Vega');
  });

  it('contains all 219 Messier (110) and Caldwell (109) Deep Sky Objects with valid metadata', () => {
    const dsoPath = resolve(process.cwd(), 'public/data/dso.json');
    const dsos = JSON.parse(readFileSync(dsoPath, 'utf8')) as DsoRecord[];
    expect(dsos.length).toBe(219);

    const messier = dsos.filter((d) => d.catalog === 'Messier');
    const caldwell = dsos.filter((d) => d.catalog === 'Caldwell');
    expect(messier.length).toBe(110);
    expect(caldwell.length).toBe(109);

    const byId = new Map(dsos.map((d) => [d.id, d]));
    expect(byId.get('M31')?.type).toBe('galaxy');
    expect(byId.get('M42')?.type).toBe('nebula');
    expect(byId.get('M45')?.type).toBe('open_cluster');
    expect(byId.get('M13')?.type).toBe('globular_cluster');
    expect(byId.get('M57')?.type).toBe('planetary_nebula');
    expect(byId.get('C80')?.name).toBe('Omega Centauri');
    expect(byId.get('C106')?.name).toBe('47 Tucanae');

    for (const dso of dsos) {
      expect(Number.isFinite(dso.raRad)).toBe(true);
      expect(Number.isFinite(dso.decRad)).toBe(true);
      expect(dso.raRad).toBeGreaterThanOrEqual(0);
      expect(dso.raRad).toBeLessThan(Math.PI * 2 + 1e-4);
      expect(dso.decRad).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(dso.decRad).toBeLessThanOrEqual(Math.PI / 2);
      expect(Number.isFinite(dso.mag)).toBe(true);
      expect(dso.sizeArcmin).toBeGreaterThan(0);
    }
  });
});

describe('Solar System Ephemeris & 3D Lunar Phase Math', () => {
  it('classifies synodic lunar longitudes into all 8 lunar phase names', () => {
    expect(classifyLunarPhase(0)).toBe('New Moon');
    expect(classifyLunarPhase(45)).toBe('Waxing Crescent');
    expect(classifyLunarPhase(90)).toBe('First Quarter');
    expect(classifyLunarPhase(135)).toBe('Waxing Gibbous');
    expect(classifyLunarPhase(180)).toBe('Full Moon');
    expect(classifyLunarPhase(225)).toBe('Waning Gibbous');
    expect(classifyLunarPhase(270)).toBe('Third Quarter');
    expect(classifyLunarPhase(315)).toBe('Waning Crescent');
  });

  it('computes topocentric positions, magnitudes, and distances for Sun, Moon, and Mercury-Neptune', () => {
    const date = new Date('2026-11-14T23:00:00Z');
    const eph = computeSolarSystemEphemeris(date, 40.7128, -74.006, 10);

    expect(eph.sun.id).toBe('sun');
    expect(eph.sun.vmag).toBeLessThan(-26);
    expect(eph.sun.distAu).toBeCloseTo(0.989, 2);

    expect(eph.moon.id).toBe('moon');
    expect(eph.moon.phaseName).toBe('Waxing Crescent');
    expect(eph.moon.waxing).toBe(true);
    expect(eph.moon.phaseFraction).toBeGreaterThan(0.2);
    expect(eph.moon.phaseFraction).toBeLessThan(0.35);

    expect(eph.planets.map((p) => p.id)).toEqual([
      'mercury',
      'venus',
      'mars',
      'jupiter',
      'saturn',
      'uranus',
      'neptune',
    ]);

    for (const p of eph.planets) {
      expect(Number.isFinite(p.altDeg)).toBe(true);
      expect(Number.isFinite(p.azDeg)).toBe(true);
      expect(Number.isFinite(p.vmag)).toBe(true);
      expect(p.distAu).toBeGreaterThan(0);
      const norm = Math.hypot(p.worldDir[0], p.worldDir[1], p.worldDir[2]);
      expect(norm).toBeCloseTo(1, 5);
    }

    const saturn = eph.planets.find((p) => p.id === 'saturn')!;
    expect(typeof saturn.ringTiltDeg).toBe('number');
  });

  it('aligns 3D sunFromMoonWorldDir opposite observer at New Moon and toward observer at Full Moon', () => {
    // New Moon (2026-11-09T07:02:42Z)
    const newMoonEph = computeSolarSystemEphemeris(new Date('2026-11-09T07:02:42Z'), 19.8207, -155.468, 4205);
    expect(newMoonEph.moon.phaseName).toBe('New Moon');
    expect(newMoonEph.moon.phaseFraction).toBeLessThan(0.02);
    const toObserverNew = new THREE.Vector3(...newMoonEph.moon.worldDir).negate();
    const sunFromMoonNew = new THREE.Vector3(...newMoonEph.moon.sunFromMoonWorldDir);
    expect(sunFromMoonNew.dot(toObserverNew)).toBeLessThan(-0.95);

    // Full Moon (2026-11-24T14:54:04Z)
    const fullMoonEph = computeSolarSystemEphemeris(new Date('2026-11-24T14:54:04Z'), 19.8207, -155.468, 4205);
    expect(fullMoonEph.moon.phaseName).toBe('Full Moon');
    expect(fullMoonEph.moon.phaseFraction).toBeGreaterThan(0.98);
    const toObserverFull = new THREE.Vector3(...fullMoonEph.moon.worldDir).negate();
    const sunFromMoonFull = new THREE.Vector3(...fullMoonEph.moon.sunFromMoonWorldDir);
    expect(sunFromMoonFull.dot(toObserverFull)).toBeGreaterThan(0.95);
  });
});

function loadTestCatalog() {
  const binBuf = readFileSync(resolve(process.cwd(), 'public/data/stars.bin'));
  const binArr = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
  const stars = parseStarBinary(binArr);
  const starNamesRaw = JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/data/star-names.json'), 'utf8'),
  ) as Record<string, NamedStarEntry>;
  const starNames = new Map<number, NamedStarEntry>();
  for (const entry of Object.values(starNamesRaw)) {
    starNames.set(entry.hip, entry);
  }
  const namedStarList = Object.values(starNamesRaw)
    .filter((entry) => Boolean(entry.name) && entry.mag <= 3.0)
    .sort((a, b) => a.mag - b.mag);
  const constellations = JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/data/constellations.json'), 'utf8'),
  ) as ConstellationRecord[];
  const dsos = JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/data/dso.json'), 'utf8'),
  ) as DsoRecord[];

  return {
    stars,
    starNames,
    namedStarList,
    constellations,
    dsos,
  };
}

describe('Phase 3 Celestial Index, Slerp, Search & Tonight\'s Best Tour', () => {

  it('computes spectral classifications and stellar/DSO distance labels', () => {
    expect(bvToSpectralClass(0.0, 32349)).toMatch(/^A1V · /);
    expect(bvToSpectralClass(1.85, 27989)).toMatch(/^M1-M2Ia · /);
    expect(bvToSpectralClass(0.65)).toMatch(/^G\dV · /);

    expect(estimateStarDistanceLabel(-1.46, 0.0, 32349)).toBe('8.60 ly');
    expect(estimateStarDistanceLabel(1.98, 0.63, 11767)).toBe('433 ly');
    expect(estimateStarDistanceLabel(4.8, 0.65)).toMatch(/^~\d+ ly$/);

    const catalog = loadTestCatalog();
    const m31 = catalog.dsos.find((d) => d.id === 'M31')!;
    const m42 = catalog.dsos.find((d) => d.id === 'M42')!;
    expect(formatDsoDistanceLabel(m31)).toBe('2.54 Mly');
    expect(formatDsoDistanceLabel(m42)).toBe('1,344 ly');
    expect(
      formatDsoDistanceLabel({
        ...m31,
        id: 'C999',
        catalog: 'Caldwell',
        name: 'Test Galaxy',
        ngc: 'NGC9999',
        type: 'galaxy',
        mag: 8.5,
      }),
    ).toBe('~25 Mly');
  });

  it('computes circumpolar, never-rises, and normal Rise/Transit/Set times', () => {
    const date = new Date('2026-11-14T22:00:00Z');
    const nycLat = 40.7128;
    const nycLon = -74.006;

    // Polaris (~Dec +89.26°) is circumpolar from NYC
    const polarisRts = computeRiseTransitSet(2.5303 * 15 * DEG_TO_RAD, 89.264 * DEG_TO_RAD, date, nycLat, nycLon);
    expect(polarisRts.state).toBe('circumpolar');
    expect(polarisRts.rise).toBe('Circumpolar');
    expect(polarisRts.set).toBe('Circumpolar');
    expect(polarisRts.transit).toMatch(/^\d{2}:\d{2}$/);
    expect(polarisRts.transitAltDeg).toBeCloseTo(90 - Math.abs(nycLat - 89.264), 3);

    // Acrux (Alpha Crucis, Dec -63.1°) never rises in NYC
    const acruxRts = computeRiseTransitSet(12.443 * 15 * DEG_TO_RAD, -63.099 * DEG_TO_RAD, date, nycLat, nycLon);
    expect(acruxRts.state).toBe('never_rises');
    expect(acruxRts.rise).toBe('Never rises');
    expect(acruxRts.set).toBe('Never rises');

    // Sirius (RA 6.7525h, Dec -16.716°) rises and sets cleanly from NYC
    const siriusRts = computeRiseTransitSet(6.7525 * 15 * DEG_TO_RAD, -16.7161 * DEG_TO_RAD, date, nycLat, nycLon);
    expect(siriusRts.state).toBe('normal');
    expect(siriusRts.rise).toMatch(/^\d{2}:\d{2}$/);
    expect(siriusRts.transit).toMatch(/^\d{2}:\d{2}$/);
    expect(siriusRts.set).toMatch(/^\d{2}:\d{2}$/);
    expect(siriusRts.transitAltDeg).toBeCloseTo(90 - Math.abs(nycLat - (-16.7161)), 3);
  });

  it('interpolates camera look direction along shortest great-circle arc across 0/360 azimuth wrap', () => {
    const start = slerpHorizontalLook(350, 20, 10, 40, 0);
    expect(start.azDeg).toBeCloseTo(350, 4);
    expect(start.altDeg).toBeCloseTo(20, 4);

    const end = slerpHorizontalLook(350, 20, 10, 40, 1);
    expect(end.azDeg).toBeCloseTo(10, 4);
    expect(end.altDeg).toBeCloseTo(40, 4);

    // Midpoint between Az 350° and Az 10° must pass near Az 0° (never around Az 180°)
    const mid = slerpHorizontalLook(350, 20, 10, 40, 0.5);
    const signedMidAz = mid.azDeg > 180 ? mid.azDeg - 360 : mid.azDeg;
    expect(Math.abs(signedMidAz)).toBeLessThan(2);
    expect(mid.altDeg).toBeGreaterThan(29);
    expect(mid.altDeg).toBeLessThan(31.5);
  });

  it('searches across planets, named/HIP stars, DSOs, and constellations and builds telemetry', () => {
    const catalog = loadTestCatalog();
    const date = new Date('2026-11-15T04:00:00Z');
    const nycLocation = {
      ...DEFAULT_LOCATION,
      name: 'New York City',
      latitude: 40.7128,
      longitude: -74.006,
      elevation: 10,
    };
    const eqToWorld = computeEquatorialToWorldMatrix4(date, nycLocation.latitude, nycLocation.longitude);
    const eph = computeSolarSystemEphemeris(date, nycLocation.latitude, nycLocation.longitude, nycLocation.elevation);

    const saturnResults = searchCelestialCatalog('Saturn', 'all', catalog, eph, eqToWorld);
    expect(saturnResults.length).toBeGreaterThan(0);
    expect(saturnResults[0].id).toBe('body-saturn');

    const siriusResults = searchCelestialCatalog('Sirius', 'star', catalog, eph, eqToWorld);
    expect(siriusResults.some((item) => item.id === 'star-32349')).toBe(true);

    const hipResults = searchCelestialCatalog('HIP 32349', 'star', catalog, eph, eqToWorld);
    expect(hipResults[0]?.id).toBe('star-32349');

    const m31Results = searchCelestialCatalog('M31', 'dso', catalog, eph, eqToWorld);
    expect(m31Results[0]?.id).toBe('dso-M31');

    const orionResults = searchCelestialCatalog('Orion', 'constellation', catalog, eph, eqToWorld);
    expect(orionResults.some((item) => item.name.toLowerCase().includes('orion'))).toBe(true);

    const saturnTel = computeObjectTelemetry(
      { id: 'body-saturn', kind: 'planet', bodyId: 'saturn' },
      catalog,
      eph,
      eqToWorld,
      date,
      nycLocation,
    );
    expect(saturnTel).not.toBeNull();
    expect(saturnTel?.name).toBe('Saturn');
    expect(saturnTel?.distanceLabel).toMatch(/AU$/);
    expect(saturnTel?.subtitle).toContain('Ring tilt');

    const siriusItem = siriusResults.find((r) => r.id === 'star-32349')!;
    const siriusTel = computeObjectTelemetry(siriusItem.ref, catalog, eph, eqToWorld, date, nycLocation);
    expect(siriusTel).not.toBeNull();
    expect(siriusTel?.distanceLabel).toBe('8.60 ly');
    expect(siriusTel?.spectralOrMorphology).toMatch(/^A1V/);

    const m31Tel = computeObjectTelemetry(
      { id: 'dso-M31', kind: 'dso', dsoId: 'M31' },
      catalog,
      eph,
      eqToWorld,
      date,
      nycLocation,
    );
    expect(m31Tel).not.toBeNull();
    expect(m31Tel?.distanceLabel).toBe('2.54 Mly');
    expect(m31Tel?.rts.state).toBe('normal');
    expect(m31Tel?.rts.transitAltDeg).toBeGreaterThan(88);
  });

  it('ranks Tonight\'s Best tour stops above the horizon cleanly', () => {
    const catalog = loadTestCatalog();
    const nycLocation = {
      ...DEFAULT_LOCATION,
      name: 'New York City',
      latitude: 40.7128,
      longitude: -74.006,
      elevation: 10,
    };

    // Daylight UTC noon in NYC -> should auto-evaluate evening window
    const daylightTour = buildTonightsBestTour(catalog, nycLocation, new Date('2026-11-14T17:00:00Z'));
    expect(daylightTour.isDaylightPreview).toBe(true);
    expect(daylightTour.stops.length).toBeGreaterThanOrEqual(6);
    expect(daylightTour.stops.length).toBeLessThanOrEqual(10);

    daylightTour.stops.forEach((stop, index) => {
      expect(stop.stepIndex).toBe(index);
      expect(stop.altDeg).toBeGreaterThanOrEqual(8);
    });
  });
});

describe('Phase 4 Live Satellites, Pass Prediction & AR Gyro Fusion', () => {
  const nycLocation = {
    ...DEFAULT_LOCATION,
    name: 'New York City',
    latitude: 40.7128,
    longitude: -74.006,
    elevation: 10,
  };

  it('parses 3-line CelesTrak TLE text and merges NORAD updates cleanly', () => {
    const sampleTle = [
      'ISS (ZARYA)',
      '1 25544U 98067A   26318.50000000  .00015000  00000-0  26000-3 0  9991',
      '2 25544  51.6312 200.0000 0007500 100.0000 250.0000 15.50200000400005',
      'TIANGONG',
      '1 48274U 21035A   26318.40000000  .00018000  00000-0  19000-3 0  9992',
      '2 48274  41.4712 180.0000 0004500 120.0000 240.0000 15.61000000250003',
    ].join('\n');

    const parsed = parseThreeLineTleText(sampleTle);
    expect(parsed.size).toBe(2);
    expect(parsed.get(ISS_NORAD_ID)?.name).toBe('ISS (ZARYA)');
    expect(parsed.get(48274)?.name).toBe('TIANGONG');

    const merged = mergeTleUpdates(DEFAULT_SATELLITE_TLES, sampleTle);
    expect(merged.updatedCount).toBe(2);
    expect(merged.records.length).toBe(DEFAULT_SATELLITE_TLES.length);
    const updatedIss = merged.records.find((r) => r.noradId === ISS_NORAD_ID);
    expect(updatedIss?.line1).toContain('26318.50000000');
  });

  it('propagates ISS, Tiangong & HST with realistic LEO physics and unit sky vectors', () => {
    const testDate = new Date('2026-11-14T21:25:00Z');
    const targetIds = [ISS_NORAD_ID, 48274, 20580];

    for (const noradId of targetIds) {
      const record = DEFAULT_SATELLITE_TLES.find((r) => r.noradId === noradId);
      expect(record).toBeDefined();
      const state = propagateSatelliteState(record!, testDate, nycLocation);
      expect(state).not.toBeNull();
      expect(Number.isFinite(state!.altDeg)).toBe(true);
      expect(Number.isFinite(state!.azDeg)).toBe(true);
      expect(state!.altitudeKm).toBeGreaterThanOrEqual(350);
      expect(state!.altitudeKm).toBeLessThanOrEqual(600);
      expect(state!.speedKmS).toBeGreaterThanOrEqual(7.4);
      expect(state!.speedKmS).toBeLessThanOrEqual(7.9);
      expect(state!.subLatDeg).toBeGreaterThanOrEqual(-90);
      expect(state!.subLatDeg).toBeLessThanOrEqual(90);
      expect(state!.subLonDeg).toBeGreaterThanOrEqual(-180);
      expect(state!.subLonDeg).toBeLessThanOrEqual(180);

      const norm = Math.hypot(state!.worldDir[0], state!.worldDir[1], state!.worldDir[2]);
      expect(norm).toBeCloseTo(1, 5);
    }

    const all = propagateAllSatellites(DEFAULT_SATELLITE_TLES, testDate, nycLocation);
    expect(all.length).toBe(DEFAULT_SATELLITE_TLES.length);
  });

  it('computes ISS orbital trajectory arcs and upcoming local pass predictions', () => {
    const issRecord = DEFAULT_SATELLITE_TLES.find((r) => r.noradId === ISS_NORAD_ID)!;
    const centerDate = new Date('2026-11-14T21:25:00Z');
    const arc = computeSatelliteOrbitArc(issRecord, centerDate, nycLocation, 30, 60);

    expect(arc.length).toBeGreaterThan(20);
    for (const pt of arc) {
      const len = Math.hypot(pt.worldDir[0], pt.worldDir[1], pt.worldDir[2]);
      expect(len).toBeCloseTo(1, 5);
    }

    const passes = predictUpcomingPasses(issRecord, centerDate, nycLocation, {
      hoursAhead: 48,
      stepSec: 20,
      minPeakAltDeg: 10,
      maxPasses: 5,
    });
    expect(passes.length).toBeGreaterThan(0);

    for (const pass of passes) {
      expect(pass.maxAltDeg).toBeGreaterThanOrEqual(10);
      expect(pass.startTimeMs).toBeLessThan(pass.maxTimeMs);
      expect(pass.maxTimeMs).toBeLessThan(pass.endTimeMs);
      expect(pass.durationSec).toBeGreaterThan(30);
    }
  });

  it('supports satellite search queries and inspector telemetry lookup', () => {
    const catalog = loadTestCatalog();
    const date = new Date('2026-11-14T21:25:00Z');
    const ephemeris = computeSolarSystemEphemeris(date, nycLocation.latitude, nycLocation.longitude);
    const eqToWorld = computeEquatorialToWorldMatrix4(date, nycLocation.latitude, nycLocation.longitude);
    const satellites = propagateAllSatellites(DEFAULT_SATELLITE_TLES, date, nycLocation);
    const issRecord = DEFAULT_SATELLITE_TLES.find((r) => r.noradId === ISS_NORAD_ID)!;
    const issPasses = predictUpcomingPasses(issRecord, date, nycLocation, {
      hoursAhead: 48,
      maxPasses: 4,
    });

    const byName = searchCelestialCatalog('ISS', 'satellite', catalog, ephemeris, eqToWorld, 10, satellites);
    expect(byName[0]?.ref.satNoradId).toBe(ISS_NORAD_ID);

    const byNorad = searchCelestialCatalog('25544', 'all', catalog, ephemeris, eqToWorld, 10, satellites);
    expect(byNorad.some((item) => item.kind === 'satellite' && item.ref.satNoradId === ISS_NORAD_ID)).toBe(true);

    const byHubble = searchCelestialCatalog('Hubble', 'satellite', catalog, ephemeris, eqToWorld, 10, satellites);
    expect(byHubble.some((item) => item.ref.satNoradId === 20580)).toBe(true);

    const telemetry = computeObjectTelemetry(
      { id: 'sat-25544', kind: 'satellite', satNoradId: ISS_NORAD_ID },
      catalog,
      ephemeris,
      eqToWorld,
      date,
      nycLocation,
      satellites,
      issPasses,
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.kind).toBe('satellite');
    expect(telemetry?.name).toContain('ISS');
    expect(telemetry?.spectralOrMorphology).toContain('km/s');
    expect(telemetry?.description).toContain('Ground track:');
  });

  it('fuses DeviceOrientation Euler angles into accurate Alt/Az sky look directions', () => {
    const north = deviceOrientationToSkyLook(0, 90, 0, 0);
    expect(north.azDeg).toBeCloseTo(0, 2);
    expect(north.altDeg).toBeCloseTo(0, 2);

    const east = deviceOrientationToSkyLook(270, 90, 0, 0);
    expect(east.azDeg).toBeCloseTo(90, 2);
    expect(east.altDeg).toBeCloseTo(0, 2);

    const south = deviceOrientationToSkyLook(180, 90, 0, 0);
    expect(south.azDeg).toBeCloseTo(180, 2);
    expect(south.altDeg).toBeCloseTo(0, 2);

    const west = deviceOrientationToSkyLook(90, 90, 0, 0);
    expect(west.azDeg).toBeCloseTo(270, 2);
    expect(west.altDeg).toBeCloseTo(0, 2);

    const tiltedUp45 = deviceOrientationToSkyLook(180, 135, 0, 0);
    expect(tiltedUp45.azDeg).toBeCloseTo(180, 2);
    expect(tiltedUp45.altDeg).toBeCloseTo(45, 2);

    const zenith = deviceOrientationToSkyLook(0, 180, 0, 0);
    expect(zenith.altDeg).toBeCloseTo(89.5, 2);

    const nadir = deviceOrientationToSkyLook(0, 0, 0, 0);
    expect(nadir.altDeg).toBeCloseTo(-80, 2);

    const iosCompass = deviceOrientationToSkyLook(0, 90, 0, 0, 90);
    expect(iosCompass.azDeg).toBeCloseTo(90, 2);
    expect(iosCompass.altDeg).toBeCloseTo(0, 2);

    const trimmed = deviceOrientationToSkyLook(0, 90, 0, 0, 90, -15);
    expect(trimmed.azDeg).toBeCloseTo(75, 2);

    // Landscape-left (+90° screen rotation) upright pointing East
    const landscapeEast = deviceOrientationToSkyLook(0, 0, -90, 90);
    expect(landscapeEast.azDeg).toBeCloseTo(90, 2);
    expect(landscapeEast.altDeg).toBeCloseTo(0, 2);
  });
});

describe('Phase 5 Azure Static Web Apps Config, CI/CD & Secret Hygiene', () => {
  const repoRoot = resolve(process.cwd());

  it('configures immutable cache headers and binary MIME types in public/staticwebapp.config.json', () => {
    const configPath = resolve(repoRoot, 'public/staticwebapp.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      routes: Array<{ route: string; headers?: Record<string, string> }>;
      navigationFallback?: { rewrite: string; exclude?: string[] };
      mimeTypes?: Record<string, string>;
      globalHeaders?: Record<string, string>;
    };

    const starsRoute = config.routes.find((r) => r.route === '/data/stars.bin');
    expect(starsRoute?.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(starsRoute?.headers?.['Content-Type']).toBe('application/octet-stream');

    const dataRoute = config.routes.find((r) => r.route === '/data/*');
    expect(dataRoute?.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable');

    const assetsRoute = config.routes.find((r) => r.route === '/assets/*');
    expect(assetsRoute?.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable');

    expect(config.mimeTypes?.['.bin']).toBe('application/octet-stream');
    expect(config.navigationFallback?.rewrite).toBe('/index.html');
    expect(config.navigationFallback?.exclude).toContain('/data/*');
    expect(config.navigationFallback?.exclude).toContain('*.bin');
  });

  it('configures GitHub Actions CI/CD workflow using repository secrets only', () => {
    const workflowPath = resolve(repoRoot, '.github/workflows/deploy.yml');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('Azure/static-web-apps-deploy@v1');
    expect(workflow).toContain('${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}');
    expect(workflow).toContain("app_location: 'dist'");
    expect(workflow).toContain('skip_app_build: true');
  });

  it('ignores local environment and cloud configuration files in .gitignore', () => {
    const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());

    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.*');
    expect(gitignore).toContain('.env.local');
    expect(gitignore).toContain('.azure/');
  });

  it('keeps private Azure infrastructure identifiers out of tracked config, workflow, and README', () => {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const resourceGroupPattern = /\brg-[a-z0-9-]+/i;
    const sensitiveFiles = [
      'README.md',
      'public/staticwebapp.config.json',
      '.github/workflows/deploy.yml',
      'package.json',
    ];

    for (const relPath of sensitiveFiles) {
      const content = readFileSync(resolve(repoRoot, relPath), 'utf8');
      expect(content, `${relPath} must not contain UUIDs`).not.toMatch(uuidPattern);
      expect(content, `${relPath} must not contain resource group names`).not.toMatch(resourceGroupPattern);
      expect(content, `${relPath} must not contain raw Azure subscription/account strings`).not.toMatch(
        /onmicrosoft\.com|AZURE_SUBSCRIPTION_ID=|AZURE_RESOURCE_GROUP=|AZURE_STATIC_WEB_APPS_API_TOKEN=/i,
      );
    }
  });
});

describe('Phase 6 Live ADS-B Aircraft Sky Tracker & Dead-Reckoning', () => {
  const seaLevelNyc = {
    ...DEFAULT_LOCATION,
    latitude: 40.7128,
    longitude: -74.006,
    elevation: 0,
  };

  it('parses readsb (adsb.fi / adsb.lol) and OpenSky payloads while filtering grounded craft', () => {
    const nowMs = Date.UTC(2026, 10, 14, 22, 0, 0);

    const readsbPayload = {
      aircraft: [
        {
          hex: 'abf2ea',
          flight: 'SWA2083 ',
          r: 'N8692F',
          t: 'B738',
          desc: 'BOEING 737-800',
          ownOp: 'SOUTHWEST AIRLINES',
          alt_baro: 26425,
          alt_geom: 25650,
          gs: 435.5,
          track: 232.18,
          baro_rate: 1536,
          squawk: '7141',
          category: 'A3',
          lat: 40.539185,
          lon: -75.060181,
          seen_pos: 1.5,
        },
        {
          hex: 'a94b08',
          flight: 'GND001',
          alt_baro: 'ground',
          lat: 40.6886,
          lon: -74.1754,
        },
      ],
    };

    const parsedReadsb = parseReadsbResponse(readsbPayload, nowMs);
    expect(parsedReadsb.length).toBe(1);
    expect(parsedReadsb[0].callsign).toBe('SWA2083');
    expect(parsedReadsb[0].typeCode).toBe('B738');
    expect(parsedReadsb[0].fetchedAtMs).toBe(nowMs - 1500);

    const openSkyPayload = {
      time: Math.floor(nowMs / 1000),
      states: [
        [
          'ac7cba',
          'SWA438  ',
          'United States',
          Math.floor(nowMs / 1000) - 2,
          Math.floor(nowMs / 1000),
          -74.0632,
          40.5608,
          10000,
          false,
          240,
          49.5,
          -5.0,
          null,
          10000,
          '5236',
          false,
          0,
        ],
        [
          'a94b09',
          'TAX100  ',
          'United States',
          Math.floor(nowMs / 1000),
          Math.floor(nowMs / 1000),
          -74.17,
          40.68,
          10,
          true,
          5,
          180,
          0,
          null,
          10,
          '1200',
          false,
          0,
        ],
      ],
    };

    const parsedOpenSky = parseOpenSkyResponse(openSkyPayload, nowMs);
    expect(parsedOpenSky.length).toBe(1);
    expect(parsedOpenSky[0].callsign).toBe('SWA438');
    expect(parsedOpenSky[0].altGeomFt).toBeCloseTo(32808, -1);
    expect(parsedOpenSky[0].groundSpeedKt).toBeCloseTo(466.5, 0);
  });

  it('computes accurate topocentric look angles overhead and 40 km North', () => {
    const overhead = computeAircraftLookAngles(
      seaLevelNyc.latitude,
      seaLevelNyc.longitude,
      35000,
      seaLevelNyc,
    );
    expect(overhead.altDeg).toBeCloseTo(90, 1);
    expect(overhead.slantRangeKm).toBeCloseTo(10.668, 2);
    expect(overhead.groundDistanceKm).toBeLessThan(0.05);

    // ~40 km due North along observer meridian (~0.3593 deg latitude)
    const northLat = seaLevelNyc.latitude + 40 / 111.32;
    const north = computeAircraftLookAngles(
      northLat,
      seaLevelNyc.longitude,
      35000,
      seaLevelNyc,
    );
    expect(Math.min(north.azDeg, 360 - north.azDeg)).toBeLessThan(0.5);
    expect(north.altDeg).toBeGreaterThan(13);
    expect(north.altDeg).toBeLessThan(17);
    expect(north.groundDistanceKm).toBeCloseTo(40, 0);
  });

  it('dead-reckons aircraft position with clamping and velocity-aligned nextWorldDir', () => {
    const nowMs = Date.UTC(2026, 10, 14, 22, 0, 0);
    const rec = {
      hex: 'a1b2c3',
      callsign: 'UAL418',
      registration: 'N37518',
      typeCode: 'B738',
      modelDesc: 'BOEING 737-800',
      operator: 'UNITED AIRLINES',
      latDeg: 40.5,
      lonDeg: -74.0,
      altBaroFt: 30000,
      altGeomFt: 30000,
      groundSpeedKt: 480,
      trackDeg: 0, // due North
      verticalRateFpm: 1200,
      squawk: '1200',
      category: 'A3',
      fetchedAtMs: nowMs,
    };

    const moved30 = extrapolateAircraftGeodetic(rec, 30);
    expect(moved30.latDeg).toBeGreaterThan(rec.latDeg);
    expect(moved30.lonDeg).toBeCloseTo(rec.lonDeg, 4);
    expect(moved30.altitudeFt).toBeCloseTo(30600, 1);

    // Ensure runaway dt > 75s is clamped cleanly
    const movedClamped = extrapolateAircraftGeodetic(rec, 300);
    const moved75 = extrapolateAircraftGeodetic(rec, 75);
    expect(movedClamped.latDeg).toBeCloseTo(moved75.latDeg, 6);
    expect(movedClamped.altitudeFt).toBeCloseTo(moved75.altitudeFt, 2);

    const state = propagateAircraftState(rec, seaLevelNyc, nowMs + 10_000);
    expect(state.nextWorldDir).not.toEqual(state.worldDir);
    const dirDot =
      state.worldDir[0] * state.nextWorldDir[0] +
      state.worldDir[1] * state.nextWorldDir[1] +
      state.worldDir[2] * state.nextWorldDir[2];
    expect(dirDot).toBeLessThan(0.99999);
    expect(dirDot).toBeGreaterThan(0.99);
    expect(state.trailPoints.length).toBe(4);

    const skyArc = computeAircraftSkyArc(rec, seaLevelNyc, nowMs + 10_000);
    expect(skyArc.length).toBeGreaterThan(20);
    expect(skyArc[0].timeOffsetSec).toBe(-60);
    expect(skyArc[skyArc.length - 1].timeOffsetSec).toBe(90);
  });

  it('generates regional corridor fallback and integrates aircraft with search and telemetry', () => {
    const nowMs = Date.UTC(2026, 10, 14, 22, 0, 0);
    const eqToWorld = computeEquatorialToWorldMatrix4(
      new Date(nowMs),
      seaLevelNyc.latitude,
      seaLevelNyc.longitude,
    );
    const ephemeris = computeSolarSystemEphemeris(
      new Date(nowMs),
      seaLevelNyc.latitude,
      seaLevelNyc.longitude,
      seaLevelNyc.elevation,
    );

    const simRecords = generateSimulatedCorridorTraffic(seaLevelNyc, nowMs);
    expect(simRecords.length).toBeGreaterThanOrEqual(8);

    const acStates = simRecords.map((r) => propagateAircraftState(r, seaLevelNyc, nowMs, eqToWorld));
    const above = acStates.filter((a) => a.isAboveHorizon);
    expect(above.length).toBeGreaterThan(0);

    const dummyCatalog = {
      stars: {
        count: 0,
        positionsJ2000: new Float32Array(0),
        starMeta: new Float32Array(0),
        raDec: new Float32Array(0),
      },
      constellations: [],
      starNames: new Map<number, NamedStarEntry>(),
      namedStarList: [],
      dsos: [],
    };

    const hits = searchCelestialCatalog(
      'UAL418',
      'aircraft',
      dummyCatalog,
      ephemeris,
      eqToWorld,
      10,
      [],
      acStates,
    );
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('aircraft');
    expect(hits[0].name).toContain('UAL418');

    const telemetry = computeObjectTelemetry(
      hits[0].ref,
      dummyCatalog,
      ephemeris,
      eqToWorld,
      new Date(nowMs),
      seaLevelNyc,
      [],
      [],
      acStates,
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.kind).toBe('aircraft');
    expect(telemetry?.vmagFormatted).toContain('FL');
    expect(telemetry?.distanceLabel).toContain('km slant');
    expect(telemetry?.rts.transit).toContain('HDG');
  });
});

describe('Phase 7 Calm Mode: Meteor Physics & Soundscape State', () => {
  it('spawns above-horizon unit-vector meteor trajectories and bright fireballs', () => {
    let seed = 0.23;
    const deterministicRandom = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    for (let i = 0; i < 8; i++) {
      const meteor = spawnMeteorTrajectory({
        nowMs: 10_000,
        cameraAzDeg: 180,
        cameraAltDeg: 20,
        rateMode: 'shower',
        forceFireball: i === 0,
        random: deterministicRandom,
        idSuffix: i,
      });

      const startLen = Math.hypot(...meteor.startDir);
      const endLen = Math.hypot(...meteor.endDir);
      expect(startLen).toBeCloseTo(1, 5);
      expect(endLen).toBeCloseTo(1, 5);

      const startHor = worldVectorToAltAz(...meteor.startDir);
      const endHor = worldVectorToAltAz(...meteor.endDir);
      expect(startHor.altDeg).toBeGreaterThan(20);
      expect(endHor.altDeg).toBeGreaterThan(0);
      expect(endHor.altDeg).toBeLessThan(startHor.altDeg);
      expect(meteor.angularLengthDeg).toBeGreaterThan(10);

      if (i === 0) {
        expect(meteor.peakVmag).toBeLessThanOrEqual(-1.5);
      }
    }

    const mid = slerpUnitVectors([0, 0, 1], [1, 0, 0], 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 5);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('evaluates meteor flight brightness, post-burnout wake decay, and expiration', () => {
    const meteor = spawnMeteorTrajectory({
      nowMs: 1_000,
      cameraAzDeg: 180,
      cameraAltDeg: 20,
      forceFireball: true,
      random: () => 0.4,
      idSuffix: 1,
    });

    expect(evaluateMeteorState(meteor, 950)).toBeNull();

    const early = evaluateMeteorState(meteor, 1_000 + meteor.durationMs * 0.1)!;
    const peak = evaluateMeteorState(meteor, 1_000 + meteor.durationMs * 0.68)!;
    const wake = evaluateMeteorState(meteor, 1_000 + meteor.durationMs + meteor.wakeHoldMs * 0.4)!;
    const expired = evaluateMeteorState(meteor, 1_000 + meteor.durationMs + meteor.wakeHoldMs + 10);

    expect(early.isHeadActive).toBe(true);
    expect(early.headProgress).toBeCloseTo(0.1, 3);
    expect(peak.headBrightness).toBeGreaterThan(early.headBrightness);
    expect(wake.isHeadActive).toBe(false);
    expect(wake.headProgress).toBe(1);
    expect(wake.headBrightness).toBe(0);
    expect(wake.wakeAlpha).toBeGreaterThan(0);
    expect(wake.wakeAlpha).toBeLessThan(1);
    expect(expired).toBeNull();
  });

  it('manages wish meteors, automatic shower updates, and expiration pruning in MeteorShowerController', () => {
    const controller = new MeteorShowerController();
    expect(controller.getRateMode()).toBe('shower');
    expect(controller.getMeteorsSpotted()).toBe(0);

    controller.setRateMode('fireballs', 1_000);
    expect(controller.getRateMode()).toBe('fireballs');

    const wish = controller.triggerWishMeteor(2_000, 180, 20);
    expect(controller.getMeteorsSpotted()).toBe(1);
    expect(controller.getActiveCount()).toBe(1);
    expect(controller.getLastMeteorLabel()).toContain('Fireball');

    const startHor = worldVectorToAltAz(...wish.startDir);
    const deltaAz = Math.abs(((startHor.azDeg - 180 + 540) % 360) - 180);
    expect(deltaAz).toBeLessThanOrEqual(52.1);

    const active = controller.update(2_200, true, 180, 20, false);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(wish.id);

    // Advance past expiration while keeping disabled so no new automatic meteors spawn
    const afterExpiry = controller.update(
      2_000 + wish.durationMs + wish.wakeHoldMs + 100,
      false,
      180,
      20,
      false,
    );
    expect(afterExpiry.length).toBe(0);
    expect(controller.getActiveCount()).toBe(0);
  });

  it('transitions CalmAudioController state deterministically without AudioContext', async () => {
    const audio = new CalmAudioController();
    expect(audio.getState()).toEqual({
      isPlaying: false,
      isMuted: false,
      volumePercent: 65,
      preset: 'campfire-music',
    });

    const started = await audio.start();
    expect(started.isPlaying).toBe(true);

    expect(audio.setVolume(120).volumePercent).toBe(100);
    expect(audio.setVolume(-10).volumePercent).toBe(0);
    expect(audio.setVolume(42).volumePercent).toBe(42);

    expect(audio.toggleMuted().isMuted).toBe(true);
    expect(audio.setMuted(false).isMuted).toBe(false);

    expect(audio.setPreset('campfire-only').preset).toBe('campfire-only');
    expect(audio.setPreset('music-only').preset).toBe('music-only');

    expect(audio.stop().isPlaying).toBe(false);
    audio.dispose();
  });
});

describe('HUD Simplification & Mobile-First DOM Structure', () => {
  it('keeps secondary drawers hidden by default and puts secondary ephemeris in a closed details disclosure', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const dom = new JSDOM(html) as { window: { document: Document } };
    const doc = dom.window.document;

    for (const id of [
      'time-panel',
      'layers-panel',
      'tour-panel',
      'iss-panel',
      'flights-panel',
      'inspect-card',
      'ar-hud-banner',
      'calm-hud-banner',
    ]) {
      const el = doc.getElementById(id);
      expect(el, `#${id} must exist`).not.toBeNull();
      expect(el?.hasAttribute('hidden'), `#${id} must start hidden`).toBe(true);
    }

    const inspectCard = doc.getElementById('inspect-card')!;
    const details = inspectCard.querySelector('details.inspect-details') as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);

    for (const secondaryId of [
      'inspect-radec',
      'inspect-spectral',
      'inspect-rise',
      'inspect-transit',
      'inspect-set',
      'inspect-airmass',
    ]) {
      expect(details?.querySelector(`#${secondaryId}`), `#${secondaryId} should live inside details`).not.toBeNull();
    }

    // Verify all dock and top-bar controls wired by HudController exist
    for (const controlId of [
      'location-trigger',
      'time-quick-btn',
      'search-trigger-btn',
      'hud-hide-btn',
      'tour-toggle-btn',
      'time-toggle-btn',
      'layers-toggle-btn',
      'iss-toggle-btn',
      'flights-toggle-btn',
      'ar-gyro-btn',
      'calm-mode-btn',
      'layers-az-readout',
      'layers-alt-readout',
      'layers-fov-readout',
      'layers-zoom-in-btn',
      'layers-zoom-out-btn',
      'utc-readout',
    ]) {
      expect(doc.getElementById(controlId), `#${controlId} must exist`).not.toBeNull();
    }
  });
});
