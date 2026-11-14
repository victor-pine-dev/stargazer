import * as THREE from 'three';
import { LineBasicNodeMaterial } from 'three/webgpu';
import { altAzToWorldVector } from '../astro/coordinates';
import type { ScreenLabelItem } from './constellationLayer';

const HORIZON_RADIUS = 440;

const COMPASS_POINTS: Array<{ label: string; azDeg: number; major: boolean }> = [
  { label: 'N', azDeg: 0, major: true },
  { label: 'NE', azDeg: 45, major: false },
  { label: 'E', azDeg: 90, major: true },
  { label: 'SE', azDeg: 135, major: false },
  { label: 'S', azDeg: 180, major: true },
  { label: 'SW', azDeg: 225, major: false },
  { label: 'W', azDeg: 270, major: true },
  { label: 'NW', azDeg: 315, major: false },
];

export interface CompassHorizonLayer {
  group: THREE.Group;
  setVisible: (visible: boolean) => void;
  collectCompassLabels: (
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

/**
 * Creates the 360-degree horizon ring with degree azimuth ticks and cardinal markers.
 */
export function createCompassHorizon(): CompassHorizonLayer {
  const group = new THREE.Group();
  group.name = 'CompassHorizon';

  const positions: number[] = [];

  // Horizon great-circle at Altitude = 0 deg
  const segments = 180;
  for (let i = 0; i < segments; i++) {
    const az0 = (i / segments) * 360;
    const az1 = ((i + 1) / segments) * 360;
    const [x0, y0, z0] = altAzToWorldVector(0, az0);
    const [x1, y1, z1] = altAzToWorldVector(0, az1);
    positions.push(
      x0 * HORIZON_RADIUS, y0 * HORIZON_RADIUS, z0 * HORIZON_RADIUS,
      x1 * HORIZON_RADIUS, y1 * HORIZON_RADIUS, z1 * HORIZON_RADIUS,
    );
  }

  // Azimuth tick marks every 5 degrees (taller ticks at 15 and 45 degrees)
  for (let az = 0; az < 360; az += 5) {
    const isCardinal = az % 90 === 0;
    const isIntercardinal = az % 45 === 0;
    const isMajor = az % 15 === 0;
    const tickAlt = isCardinal ? 2.6 : isIntercardinal ? 1.8 : isMajor ? 1.1 : 0.55;

    const [xb, yb, zb] = altAzToWorldVector(0, az);
    const [xt, yt, zt] = altAzToWorldVector(tickAlt, az);
    positions.push(
      xb * HORIZON_RADIUS, yb * HORIZON_RADIUS, zb * HORIZON_RADIUS,
      xt * HORIZON_RADIUS, yt * HORIZON_RADIUS, zt * HORIZON_RADIUS,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new LineBasicNodeMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthTest: false,
  });

  const horizonLines = new THREE.LineSegments(geometry, material);
  horizonLines.frustumCulled = false;
  horizonLines.renderOrder = 2;
  group.add(horizonLines);

  const anchors = COMPASS_POINTS.map((pt) => {
    const [x, y, z] = altAzToWorldVector(2.8, pt.azDeg);
    return {
      ...pt,
      worldPos: new THREE.Vector3(x * HORIZON_RADIUS, y * HORIZON_RADIUS, z * HORIZON_RADIUS),
    };
  });

  const projected = new THREE.Vector3();

  return {
    group,
    setVisible(visible) {
      group.visible = visible;
    },
    collectCompassLabels(camera, viewportWidth, viewportHeight) {
      if (!group.visible) return [];
      const labels: ScreenLabelItem[] = [];

      for (const anchor of anchors) {
        projected.copy(anchor.worldPos).project(camera);
        if (projected.z > 1 || projected.z < -1) continue;

        const sx = (projected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-projected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < -24 || sx > viewportWidth + 24 || sy < -24 || sy > viewportHeight + 24) continue;

        labels.push({
          id: `compass-${anchor.label}`,
          text: anchor.label,
          kind: 'compass',
          x: sx,
          y: sy,
          priority: anchor.major ? 100 : 90,
        });
      }
      return labels;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
