import * as THREE from 'three';
import { LineBasicNodeMaterial } from 'three/webgpu';
import { float, normalize, positionWorld, smoothstep, uniform } from 'three/tsl';
import { raDecToJ2000UnitVector } from '../astro/coordinates';
import type { ConstellationRecord, NamedStarEntry } from '../data/catalogLoader';

const CONSTELLATION_SPHERE_RADIUS = 455;
const MAX_SEGMENT_ANGLE_RAD = (4 * Math.PI) / 180; // Subdivide long arcs every ~4 deg so boundaries curve cleanly on the sphere

export interface ScreenLabelItem {
  id: string;
  text: string;
  subtext?: string;
  kind: 'constellation' | 'star' | 'compass';
  x: number;
  y: number;
  priority: number;
}

export interface ConstellationLayer {
  group: THREE.Group;
  setEqToWorldMatrix: (mat: THREE.Matrix4) => void;
  setVisibility: (options: {
    showLines: boolean;
    showBounds: boolean;
    showLabels: boolean;
    sunAltDeg: number;
    showAtmosphere: boolean;
  }) => void;
  collectVisibleLabels: (
    camera: THREE.PerspectiveCamera,
    eqToWorld: THREE.Matrix4,
    viewportWidth: number,
    viewportHeight: number,
    fovDeg: number,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

/**
 * Appends great-circle subdivided 3D line segments between two J2000 RA/Dec points.
 */
function appendSphericalSegments(
  outPositions: number[],
  p0RaDec: [number, number],
  p1RaDec: [number, number],
  radius: number,
): void {
  const [x0, y0, z0] = raDecToJ2000UnitVector(p0RaDec[0], p0RaDec[1]);
  const [x1, y1, z1] = raDecToJ2000UnitVector(p1RaDec[0], p1RaDec[1]);

  const v0 = new THREE.Vector3(x0, y0, z0);
  const v1 = new THREE.Vector3(x1, y1, z1);
  const dotVal = Math.max(-1, Math.min(1, v0.dot(v1)));
  const angle = Math.acos(dotVal);

  const steps = Math.max(1, Math.ceil(angle / MAX_SEGMENT_ANGLE_RAD));
  let prev = v0.clone().multiplyScalar(radius);

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const interp = new THREE.Vector3().lerpVectors(v0, v1, t).normalize().multiplyScalar(radius);
    outPositions.push(prev.x, prev.y, prev.z, interp.x, interp.y, interp.z);
    prev = interp;
  }
}

/**
 * Builds GPU line layers for all 88 IAU constellation stick figures and boundary polygons,
 * rotated on the GPU via matrixAutoUpdate = false using the single J2000 Eq-to-World matrix.
 */
export function createConstellationLayer(
  constellations: ConstellationRecord[],
  namedStars: NamedStarEntry[],
): ConstellationLayer {
  const group = new THREE.Group();
  group.name = 'ConstellationGroup';
  group.matrixAutoUpdate = false;

  // 1. Stick-figure polylines
  const linePositions: number[] = [];
  for (const c of constellations) {
    for (const polyline of c.lines) {
      for (let i = 0; i < polyline.length - 1; i++) {
        appendSphericalSegments(linePositions, polyline[i], polyline[i + 1], CONSTELLATION_SPHERE_RADIUS);
      }
    }
  }

  const uLineOpacity = uniform(0.36);
  const uBoundOpacity = uniform(0.2);
  const horizonClipMask = smoothstep(float(-0.005), float(0.025), normalize(positionWorld).y);

  const linesGeometry = new THREE.BufferGeometry();
  linesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const linesMaterial = new LineBasicNodeMaterial({
    color: 0x56a3ff,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  linesMaterial.opacityNode = uLineOpacity.mul(horizonClipMask);
  const linesSegments = new THREE.LineSegments(linesGeometry, linesMaterial);
  linesSegments.frustumCulled = false;
  linesSegments.renderOrder = -2;
  group.add(linesSegments);

  // 2. IAU Constellation boundaries
  const boundPositions: number[] = [];
  for (const c of constellations) {
    for (const ring of c.bounds) {
      for (let i = 0; i < ring.length; i++) {
        const nextIdx = (i + 1) % ring.length;
        appendSphericalSegments(boundPositions, ring[i], ring[nextIdx], CONSTELLATION_SPHERE_RADIUS);
      }
    }
  }

  const boundsGeometry = new THREE.BufferGeometry();
  boundsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boundPositions, 3));
  const boundsMaterial = new LineBasicNodeMaterial({
    color: 0x7a6bff,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  boundsMaterial.opacityNode = uBoundOpacity.mul(horizonClipMask);
  const boundsSegments = new THREE.LineSegments(boundsGeometry, boundsMaterial);
  boundsSegments.frustumCulled = false;
  boundsSegments.renderOrder = -3;
  boundsSegments.visible = false; // Clean default; toggled on via HUD
  group.add(boundsSegments);

  // Precompute static J2000 label vectors for fast screen projection
  const constellationAnchors = constellations.map((c) => {
    const [x, y, z] = raDecToJ2000UnitVector(c.labelRaRad, c.labelDecRad);
    return {
      id: c.id,
      name: c.name,
      rank: c.rank,
      j2000Vec: new THREE.Vector3(x, y, z),
    };
  });

  const starAnchors = namedStars.map((s) => {
    const [x, y, z] = raDecToJ2000UnitVector(s.raRad, s.decRad);
    return {
      id: `hip-${s.hip}`,
      name: s.name,
      mag: s.mag,
      j2000Vec: new THREE.Vector3(x, y, z),
    };
  });

  let labelsEnabled = true;
  const tempWorld = new THREE.Vector3();
  const tempProjected = new THREE.Vector3();

  return {
    group,
    setEqToWorldMatrix(mat) {
      group.matrix.copy(mat);
      group.matrixWorldNeedsUpdate = true;
    },
    setVisibility({ showLines, showBounds, showLabels, sunAltDeg, showAtmosphere }) {
      linesSegments.visible = showLines;
      boundsSegments.visible = showBounds;
      labelsEnabled = showLabels;

      // Gently attenuate line opacity in bright daylight
      const daylightFade = showAtmosphere
        ? Math.max(0.22, Math.min(1.0, 1 - (sunAltDeg + 6) / 14))
        : 1.0;
      uLineOpacity.value = 0.36 * daylightFade;
      uBoundOpacity.value = 0.2 * daylightFade;
    },
    collectVisibleLabels(camera, eqToWorld, viewportWidth, viewportHeight, fovDeg) {
      if (!labelsEnabled) return [];

      const items: ScreenLabelItem[] = [];
      const halfW = viewportWidth * 0.5;
      const halfH = viewportHeight * 0.5;

      // Constellation labels: reveal rank 1-2 at wide FOV, all 88 as FOV narrows below 55 deg
      const maxRank = fovDeg > 60 ? 2 : 3;
      for (const anchor of constellationAnchors) {
        if (anchor.rank > maxRank) continue;
        tempWorld.copy(anchor.j2000Vec).applyMatrix4(eqToWorld);
        if (tempWorld.y < 0.03) continue; // Below horizon

        tempProjected.copy(tempWorld).multiplyScalar(CONSTELLATION_SPHERE_RADIUS).project(camera);
        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < -40 || sx > viewportWidth + 40 || sy < -20 || sy > viewportHeight + 20) continue;

        items.push({
          id: `const-${anchor.id}`,
          text: anchor.name.toUpperCase(),
          kind: 'constellation',
          x: sx,
          y: sy,
          priority: 10 - anchor.rank,
        });
      }

      // Bright star labels: reveal mag <= 2.1 (e.g. Polaris, Sirius, Vega) at wide FOV, down to 2.95 on zoom
      const magCutoff = fovDeg < 28 ? 2.95 : fovDeg < 55 ? 2.4 : 2.1;
      for (const star of starAnchors) {
        if (star.mag > magCutoff) break;
        tempWorld.copy(star.j2000Vec).applyMatrix4(eqToWorld);
        if (tempWorld.y < 0.02) continue;

        tempProjected.copy(tempWorld).multiplyScalar(CONSTELLATION_SPHERE_RADIUS).project(camera);
        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < 10 || sx > viewportWidth - 10 || sy < 10 || sy > viewportHeight - 10) continue;

        items.push({
          id: star.id,
          text: star.name,
          kind: 'star',
          x: sx + 10,
          y: sy - 8,
          priority: 20 - star.mag,
        });
      }

      // Keep top-priority labels well-spaced to avoid overlapping text
      items.sort((a, b) => b.priority - a.priority);
      const accepted: ScreenLabelItem[] = [];
      for (const item of items) {
        const tooClose = accepted.some(
          (other) => Math.abs(other.x - item.x) < 76 && Math.abs(other.y - item.y) < 22,
        );
        if (!tooClose && item.x > 0 && item.x < halfW * 2 && item.y > 0 && item.y < halfH * 2) {
          accepted.push(item);
        }
        if (accepted.length >= 64) break;
      }

      return accepted;
    },
    dispose() {
      linesGeometry.dispose();
      linesMaterial.dispose();
      boundsGeometry.dispose();
      boundsMaterial.dispose();
    },
  };
}
