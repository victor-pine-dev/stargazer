import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseStarBinary, type ConstellationRecord, type NamedStarEntry } from '../../data/catalogLoader';
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
import { bvToKelvin, bvToRGB, computeAirmass, magnitudeToFlux } from '../spectral';

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
});
