import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  exp,
  float,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { raDecToJ2000UnitVector } from '../astro/coordinates';
import type { DsoMorphology, DsoRecord } from '../data/catalogLoader';
import type { ScreenLabelItem } from './constellationLayer';

const DSO_SPHERE_RADIUS = 452;

const MORPHOLOGY_TO_ID: Record<DsoMorphology, number> = {
  galaxy: 0,
  nebula: 1,
  planetary_nebula: 2,
  globular_cluster: 3,
  open_cluster: 4,
};

export interface DsoLayer {
  mesh: THREE.Mesh;
  dsoCount: number;
  update: (params: {
    eqToWorld: THREE.Matrix4;
    fovDeg: number;
    sunAltDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    showAtmosphere: boolean;
    visible: boolean;
  }) => void;
  collectVisibleLabels: (
    camera: THREE.PerspectiveCamera,
    eqToWorld: THREE.Matrix4,
    viewportWidth: number,
    viewportHeight: number,
    fovDeg: number,
    sunAltDeg: number,
    showAtmosphere: boolean,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

/**
 * Creates the single-draw-call instanced Deep Sky Objects (Messier + Caldwell) GPU layer
 * with 5 distinct morphological SDF chart symbols and zoom-based label reveal.
 */
export function createDsoLayer(dsos: DsoRecord[]): DsoLayer {
  const count = dsos.length;
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = count;
  basePlane.dispose();

  const positionsJ2000 = new Float32Array(count * 3);
  // [mag, sizeArcmin, morphClassId, index]
  const dsoMeta = new Float32Array(count * 4);

  const anchors = dsos.map((dso, i) => {
    const [vx, vy, vz] = raDecToJ2000UnitVector(dso.raRad, dso.decRad);
    const pIdx = i * 3;
    positionsJ2000[pIdx] = vx;
    positionsJ2000[pIdx + 1] = vy;
    positionsJ2000[pIdx + 2] = vz;

    const mIdx = i * 4;
    dsoMeta[mIdx] = dso.mag;
    dsoMeta[mIdx + 1] = dso.sizeArcmin;
    dsoMeta[mIdx + 2] = MORPHOLOGY_TO_ID[dso.type];
    dsoMeta[mIdx + 3] = i;

    return {
      record: dso,
      j2000Vec: new THREE.Vector3(vx, vy, vz),
    };
  });

  geometry.setAttribute('aDsoDir', new THREE.InstancedBufferAttribute(positionsJ2000, 3));
  geometry.setAttribute('aDsoMeta', new THREE.InstancedBufferAttribute(dsoMeta, 4));

  const uEqToWorld = uniform(new THREE.Matrix4());
  const uFovDeg = uniform(72);
  const uSunAltDeg = uniform(-30);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);
  const uShowAtmosphere = uniform(1.0);

  const aDsoDir = attribute('aDsoDir', 'vec3');
  const aDsoMeta = attribute('aDsoMeta', 'vec4');

  const vQuadUv = varying(positionGeometry.xy, 'vDsoQuadUv');
  const vDsoMeta = varying(aDsoMeta, 'vDsoMeta');

  const vDsoVisibility = varying(
    Fn(() => {
      const mag = aDsoMeta.x;
      const worldDir = normalize(uEqToWorld.mul(vec4(aDsoDir, 0.0)).xyz);
      const altSin = worldDir.y;

      const horizonFade = smoothstep(float(-0.015), float(0.025), altSin);
      const daylightFade = mix(
        float(1.0),
        float(1.0).sub(smoothstep(float(-10.0), float(-2.5), uSunAltDeg)),
        uShowAtmosphere,
      );

      // Reveal fainter DSOs smoothly as the user zooms in
      const zoomNorm = float(1.0).sub(smoothstep(float(12.0), float(88.0), uFovDeg));
      const magLimit = mix(float(6.4), float(12.5), zoomNorm);
      const magMask = float(1.0).sub(smoothstep(magLimit.sub(1.2), magLimit.add(0.6), mag));

      return clamp(magMask.mul(0.88).mul(horizonFade).mul(daylightFade), float(0.0), float(1.0));
    })(),
    'vDsoVisibility',
  );

  const vertexNode = Fn(() => {
    const sizeArcmin = aDsoMeta.y;
    const worldDir = normalize(uEqToWorld.mul(vec4(aDsoDir, 0.0)).xyz);
    const worldPos = worldDir.mul(DSO_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    // Scale symbol radius gently by angular size and zoom FOV
    const pxPerArcmin = max(uViewport.y.div(max(uFovDeg.mul(60.0), float(600.0))), float(0.08));
    const angularPx = sizeArcmin.mul(0.48).mul(pxPerArcmin);
    const zoomScale = mix(
      float(1.0),
      float(1.65),
      float(1.0).sub(smoothstep(float(12.0), float(85.0), uFovDeg)),
    );
    const baseRadiusPx = clamp(max(float(9.5).mul(zoomScale), angularPx), float(8.5), float(34.0));

    const isVisible = worldDir.y.greaterThan(-0.02).and(centerClip.w.greaterThan(0.0));
    const radiusPx = select(isVisible, baseRadiusPx, float(0.0));

    const ndcOffset = positionGeometry.xy
      .mul(radiusPx)
      .mul(uPixelRatio)
      .mul(2.0)
      .div(max(uViewport, vec2(1.0, 1.0)));

    const offscreen = vec4(2.0, 2.0, 2.0, 1.0);
    const projected = vec4(
      centerClip.xy.add(ndcOffset.mul(centerClip.w)),
      centerClip.z,
      centerClip.w,
    );

    return select(isVisible, projected, offscreen);
  })();

  const fragmentColorNode = Fn(() => {
    const morphId = vDsoMeta.z;
    const isGalaxy = morphId.lessThan(0.5);
    const isNebula = morphId.greaterThanEqual(0.5).and(morphId.lessThan(1.5));
    const isPlanetary = morphId.greaterThanEqual(1.5).and(morphId.lessThan(2.5));
    const isGlobular = morphId.greaterThanEqual(2.5).and(morphId.lessThan(3.5));

    const cGalaxy = vec3(0.85, 0.68, 1.0);
    const cNebula = vec3(0.96, 0.46, 0.72);
    const cPlanetary = vec3(0.25, 0.92, 0.78);
    const cGlobular = vec3(0.98, 0.82, 0.36);
    const cOpen = vec3(0.48, 0.80, 1.0);

    return select(
      isGalaxy,
      cGalaxy,
      select(isNebula, cNebula, select(isPlanetary, cPlanetary, select(isGlobular, cGlobular, cOpen))),
    );
  })();

  const fragmentOpacityNode = Fn(() => {
    const uv = vQuadUv;
    const r = length(uv);
    const morphId = vDsoMeta.z;

    const isGalaxy = morphId.lessThan(0.5);
    const isNebula = morphId.greaterThanEqual(0.5).and(morphId.lessThan(1.5));
    const isPlanetary = morphId.greaterThanEqual(1.5).and(morphId.lessThan(2.5));
    const isGlobular = morphId.greaterThanEqual(2.5).and(morphId.lessThan(3.5));

    // 0: Galaxy — tilted 2:1 elliptical contour + glowing nucleus
    const ex = uv.x.mul(0.866).add(uv.y.mul(0.5));
    const ey = uv.y.mul(0.866).sub(uv.x.mul(0.5));
    const ellDist = length(vec2(ex.div(0.72), ey.div(0.36)));
    const galaxyRing = float(1.0).sub(smoothstep(float(0.03), float(0.13), abs(ellDist.sub(1.0))));
    const galaxyCore = exp(ellDist.mul(ellDist).mul(-4.5)).mul(0.45);
    const galaxyMask = clamp(galaxyRing.add(galaxyCore), float(0.0), float(1.0));

    // 1: Nebula — rounded diamond contour + diffuse emission core
    const diamondDist = abs(uv.x).add(abs(uv.y));
    const nebulaContour = float(1.0).sub(smoothstep(float(0.03), float(0.13), abs(diamondDist.sub(0.72))));
    const nebulaGlow = exp(r.mul(r).mul(-5.0)).mul(0.38);
    const nebulaMask = clamp(nebulaContour.add(nebulaGlow), float(0.0), float(1.0));

    // 2: Planetary Nebula — circular shell ring + 4 outer cardinal tick marks
    const pnRing = float(1.0).sub(smoothstep(float(0.025), float(0.11), abs(r.sub(0.44))));
    const pnTickX = float(1.0)
      .sub(smoothstep(float(0.025), float(0.08), abs(uv.y)))
      .mul(smoothstep(float(0.42), float(0.48), abs(uv.x)))
      .mul(float(1.0).sub(smoothstep(float(0.76), float(0.84), abs(uv.x))));
    const pnTickY = float(1.0)
      .sub(smoothstep(float(0.025), float(0.08), abs(uv.x)))
      .mul(smoothstep(float(0.42), float(0.48), abs(uv.y)))
      .mul(float(1.0).sub(smoothstep(float(0.76), float(0.84), abs(uv.y))));
    const pnCore = exp(r.mul(r).mul(-30.0)).mul(0.6);
    const pnMask = clamp(pnRing.add(pnTickX).add(pnTickY).add(pnCore), float(0.0), float(1.0));

    // 3: Globular Cluster — circular ring + orthogonal internal crosshair + dense core
    const gcRing = float(1.0).sub(smoothstep(float(0.025), float(0.11), abs(r.sub(0.62))));
    const gcInside = float(1.0).sub(smoothstep(float(0.56), float(0.64), r));
    const gcCrossH = float(1.0).sub(smoothstep(float(0.02), float(0.075), abs(uv.y))).mul(gcInside);
    const gcCrossV = float(1.0).sub(smoothstep(float(0.02), float(0.075), abs(uv.x))).mul(gcInside);
    const gcCore = exp(r.mul(r).mul(-14.0)).mul(0.45);
    const gcMask = clamp(
      gcRing.add(gcCrossH.mul(0.75)).add(gcCrossV.mul(0.75)).add(gcCore),
      float(0.0),
      float(1.0),
    );

    // 4: Open Cluster — 8-dot dashed circular ring via cos(8*theta) Chebyshev symmetry + cluster glow
    const safeR = max(r, float(0.001));
    const nx = uv.x.div(safeR);
    const ny = uv.y.div(safeR);
    const cos2 = nx.mul(nx).sub(ny.mul(ny));
    const cos4 = float(2.0).mul(cos2).mul(cos2).sub(1.0);
    const cos8 = float(2.0).mul(cos4).mul(cos4).sub(1.0);
    const ocDash = smoothstep(float(0.05), float(0.45), cos8);
    const ocRing = float(1.0).sub(smoothstep(float(0.03), float(0.12), abs(r.sub(0.62)))).mul(ocDash);
    const ocGlow = exp(r.mul(r).mul(-6.0)).mul(0.25);
    const ocMask = clamp(ocRing.add(ocGlow), float(0.0), float(1.0));

    const shapeMask = select(
      isGalaxy,
      galaxyMask,
      select(isNebula, nebulaMask, select(isPlanetary, pnMask, select(isGlobular, gcMask, ocMask))),
    );

    const radialCut = float(1.0).sub(smoothstep(float(0.85), float(1.0), r));
    return clamp(shapeMask.mul(vDsoVisibility).mul(radialCut), float(0.0), float(1.0));
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  material.vertexNode = vertexNode;
  material.colorNode = fragmentColorNode;
  material.opacityNode = fragmentOpacityNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DeepSkyObjects';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  const tempWorld = new THREE.Vector3();
  const tempProjected = new THREE.Vector3();

  return {
    mesh,
    dsoCount: count,
    update({
      eqToWorld,
      fovDeg,
      sunAltDeg,
      viewportWidth,
      viewportHeight,
      pixelRatio,
      showAtmosphere,
      visible,
    }) {
      mesh.visible = visible;
      if (!visible) return;

      uEqToWorld.value.copy(eqToWorld);
      uFovDeg.value = fovDeg;
      uSunAltDeg.value = sunAltDeg;
      uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      uPixelRatio.value = pixelRatio;
      uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
    },

    collectVisibleLabels(
      camera,
      eqToWorld,
      viewportWidth,
      viewportHeight,
      fovDeg,
      sunAltDeg,
      showAtmosphere,
    ) {
      if (!mesh.visible) return [];
      if (showAtmosphere && sunAltDeg > -4.5) return [];

      const magCutoff = fovDeg < 16 ? 12.0 : fovDeg < 30 ? 9.8 : fovDeg < 60 ? 6.8 : 4.6;
      const labels: ScreenLabelItem[] = [];

      for (const anchor of anchors) {
        if (anchor.record.mag > magCutoff) break;
        tempWorld.copy(anchor.j2000Vec).applyMatrix4(eqToWorld);
        if (tempWorld.y < 0.025) continue;

        tempProjected.copy(tempWorld).multiplyScalar(DSO_SPHERE_RADIUS).project(camera);
        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < 10 || sx > viewportWidth - 10 || sy < 10 || sy > viewportHeight - 10) continue;

        const shortName =
          anchor.record.name !== anchor.record.ngc && anchor.record.name !== anchor.record.id
            ? `${anchor.record.id} · ${anchor.record.name}`
            : anchor.record.id;

        labels.push({
          id: `dso-${anchor.record.id}`,
          text: shortName,
          kind: 'dso',
          x: sx + 11,
          y: sy + 9,
          priority: 18 - anchor.record.mag,
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
