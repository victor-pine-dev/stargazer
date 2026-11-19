import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import { DEG_TO_RAD, raDecToJ2000UnitVector, TWO_PI } from '../astro/coordinates';

const MILKY_WAY_RADIUS = 490;
const SKY_GRID_RADIUS = 454;
const ECLIPTIC_OBLIQUITY_RAD = 23.439291 * DEG_TO_RAD;

export interface SkyGuidesLayer {
  group: THREE.Group;
  update: (params: {
    eqToWorld: THREE.Matrix4;
    sunAltDeg: number;
    showAtmosphere: boolean;
    bortleSkyglow: number;
    showMilkyWay: boolean;
    showGrid: boolean;
  }) => void;
  dispose: () => void;
}

function appendGridArc(
  positions: number[],
  colors: number[],
  alphas: number[],
  points: [number, number, number][],
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const bPt = points[i + 1]!;
    positions.push(
      a[0] * SKY_GRID_RADIUS,
      a[1] * SKY_GRID_RADIUS,
      a[2] * SKY_GRID_RADIUS,
      bPt[0] * SKY_GRID_RADIUS,
      bPt[1] * SKY_GRID_RADIUS,
      bPt[2] * SKY_GRID_RADIUS,
    );
    colors.push(r, g, b, r, g, b);
    alphas.push(alpha, alpha);
  }
}

function buildSkyGridGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const alphas: number[] = [];

  // 1. Equatorial RA Hour Meridians every 15 degrees (24 lines)
  for (let raDeg = 0; raDeg < 360; raDeg += 15) {
    const raRad = raDeg * DEG_TO_RAD;
    const pts: [number, number, number][] = [];
    for (let decDeg = -80; decDeg <= 80; decDeg += 5) {
      pts.push(raDecToJ2000UnitVector(raRad, decDeg * DEG_TO_RAD));
    }
    const isMajor = raDeg % 90 === 0;
    appendGridArc(positions, colors, alphas, pts, 0.36, 0.62, 0.94, isMajor ? 0.3 : 0.18);
  }

  // 2. Declination parallels every 15 degrees (0° Celestial Equator highlighted)
  for (let decDeg = -75; decDeg <= 75; decDeg += 15) {
    const decRad = decDeg * DEG_TO_RAD;
    const pts: [number, number, number][] = [];
    for (let lonDeg = 0; lonDeg <= 360; lonDeg += 5) {
      pts.push(raDecToJ2000UnitVector(lonDeg * DEG_TO_RAD, decRad));
    }
    const isEquator = decDeg === 0;
    appendGridArc(
      positions,
      colors,
      alphas,
      pts,
      isEquator ? 0.25 : 0.36,
      isEquator ? 0.78 : 0.62,
      isEquator ? 0.98 : 0.94,
      isEquator ? 0.42 : 0.18,
    );
  }

  // 3. Ecliptic great circle (solar annual path tilted 23.44° around J2000 vernal equinox +X)
  const cosEps = Math.cos(ECLIPTIC_OBLIQUITY_RAD);
  const sinEps = Math.sin(ECLIPTIC_OBLIQUITY_RAD);
  const eclipticPts: [number, number, number][] = [];
  const eclipticSteps = 72;
  for (let i = 0; i <= eclipticSteps; i++) {
    const lambda = (i / eclipticSteps) * TWO_PI;
    const x = Math.cos(lambda);
    const sinL = Math.sin(lambda);
    eclipticPts.push([x, sinL * cosEps, sinL * sinEps]);
  }
  appendGridArc(positions, colors, alphas, eclipticPts, 0.96, 0.64, 0.14, 0.44);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aGuideColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aGuideAlpha', new THREE.Float32BufferAttribute(alphas, 1));
  return geometry;
}

/**
 * Renders a procedural IAU J2000 Milky Way band (with Great Rift modulation)
 * plus a toggleable Equatorial RA/Dec and Ecliptic coordinate grid.
 */
export function createSkyGuidesLayer(): SkyGuidesLayer {
  const group = new THREE.Group();
  group.name = 'SkyGuidesGroup';
  group.matrixAutoUpdate = false;

  // 1. Procedural Galactic Milky Way Sphere
  const mwGeometry = new THREE.SphereGeometry(MILKY_WAY_RADIUS, 64, 48);
  const uMwVisibility = uniform(1.0);
  const vLocalDir = varying(normalize(positionLocal), 'vMwLocalDir');

  const ngp = vec3(-0.867666, -0.198076, 0.455984); // North Galactic Pole in J2000
  const gc = vec3(-0.054876, -0.873437, -0.483835); // Galactic Center (Sgr A*) in J2000
  const ge = vec3(0.494109, -0.44483, 0.746982); // l=90°, b=0° in J2000

  const mwHorizonMask = smoothstep(float(0.0), float(0.07), normalize(positionWorld).y);

  const mwNode = Fn(() => {
    const dir = normalize(vLocalDir);
    const sinB = dot(dir, ngp);
    const cosL = dot(dir, gc);
    const sinL = dot(dir, ge);
    const cos2L = cosL.mul(cosL).sub(sinL.mul(sinL));
    const cos3L = cosL.mul(cos2L).sub(sinL.mul(sinL.mul(cosL).mul(2.0)));

    const planeDensity = exp(sinB.mul(sinB).mul(-38.0));
    const wideHalo = exp(sinB.mul(sinB).mul(-12.0)).mul(0.28);
    const coreWeight = float(0.52).add(smoothstep(float(-0.25), float(0.92), cosL).mul(1.15));

    const cloudMottle = float(0.76).add(
      sin(sinL.mul(7.0).add(cos2L.mul(2.3)).add(sinB.mul(18.0)))
        .mul(cos(cos3L.mul(3.1).sub(sinB.mul(24.0))))
        .mul(0.24),
    );

    const riftOffset = sinB.sub(sinL.mul(0.012));
    const riftDust = float(1.0).sub(
      exp(riftOffset.mul(riftOffset).mul(-650.0))
        .mul(smoothstep(float(-0.35), float(0.75), cosL))
        .mul(0.56),
    );

    const intensity = clamp(
      planeDensity.add(wideHalo).mul(coreWeight).mul(cloudMottle).mul(riftDust).mul(0.115),
      float(0.0),
      float(0.24),
    )
      .mul(mwHorizonMask)
      .mul(uMwVisibility);

    const warmCore = vec3(0.46, 0.4, 0.32);
    const coolArm = vec3(0.16, 0.25, 0.44);
    return mix(coolArm, warmCore, smoothstep(float(0.1), float(0.85), cosL)).mul(intensity);
  })();

  const mwMaterial = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  mwMaterial.colorNode = mwNode;
  mwMaterial.opacityNode = float(1.0);

  const mwMesh = new THREE.Mesh(mwGeometry, mwMaterial);
  mwMesh.name = 'MilkyWayBand';
  mwMesh.frustumCulled = false;
  mwMesh.renderOrder = -6;
  group.add(mwMesh);

  // 2. Equatorial & Ecliptic Coordinate Grid
  const gridGeometry = buildSkyGridGeometry();
  const uGridOpacity = uniform(0.85);
  const vGridColor = varying(attribute('aGuideColor', 'vec3'), 'vSkyGuideColor');
  const vGridAlpha = varying(attribute('aGuideAlpha', 'float'), 'vSkyGuideAlpha');
  const gridHorizonMask = smoothstep(float(-0.005), float(0.025), normalize(positionWorld).y);

  const gridMaterial = new LineBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  gridMaterial.colorNode = vGridColor;
  gridMaterial.opacityNode = vGridAlpha.mul(uGridOpacity).mul(gridHorizonMask);

  const gridSegments = new THREE.LineSegments(gridGeometry, gridMaterial);
  gridSegments.name = 'SkyCoordinateGrid';
  gridSegments.frustumCulled = false;
  gridSegments.renderOrder = -4;
  gridSegments.visible = false;
  group.add(gridSegments);

  return {
    group,
    update({ eqToWorld, sunAltDeg, showAtmosphere, bortleSkyglow, showMilkyWay, showGrid }) {
      group.matrix.copy(eqToWorld);

      const daylightAtten = showAtmosphere
        ? 1.0 - Math.max(0, Math.min(1, (sunAltDeg + 15) / 11))
        : 1.0;
      const skyglowAtten = showAtmosphere
        ? Math.max(0.08, Math.min(1.0, 1.0 - bortleSkyglow * 0.56))
        : 1.0;

      mwMesh.visible = showMilkyWay && daylightAtten > 0.02;
      uMwVisibility.value = showMilkyWay ? daylightAtten * skyglowAtten : 0.0;

      gridSegments.visible = showGrid;
      uGridOpacity.value = showAtmosphere && sunAltDeg > 0 ? 0.52 : 0.88;
    },
    dispose() {
      mwGeometry.dispose();
      mwMaterial.dispose();
      gridGeometry.dispose();
      gridMaterial.dispose();
    },
  };
}
