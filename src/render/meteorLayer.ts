import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { slerpUnitVectors, type EvaluatedMeteorState } from '../astro/meteors';

const METEOR_SPHERE_RADIUS = 454;
const MAX_METEORS = 12;
const WAKE_SEGMENTS = 4;
const STREAK_SEGMENTS = 8;
const SEGMENTS_PER_METEOR = WAKE_SEGMENTS + STREAK_SEGMENTS;
const MAX_TRAIL_VERTICES = MAX_METEORS * SEGMENTS_PER_METEOR * 2;

export interface MeteorLayer {
  group: THREE.Group;
  update: (params: {
    meteors: EvaluatedMeteorState[];
    fovDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    visible: boolean;
  }) => void;
  dispose: () => void;
}

function createMeteorTrailMesh() {
  const positions = new Float32Array(MAX_TRAIL_VERTICES * 3);
  const colors = new Float32Array(MAX_TRAIL_VERTICES * 3);
  const alphas = new Float32Array(MAX_TRAIL_VERTICES);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aMeteorLineColor', colorAttr);
  geometry.setAttribute('aMeteorLineAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const vColor = varying(attribute('aMeteorLineColor', 'vec3'), 'vMeteorLineColor');
  const vAlpha = varying(attribute('aMeteorLineAlpha', 'float'), 'vMeteorLineAlpha');
  const horizonClipMask = smoothstep(float(-0.01), float(0.025), normalize(positionWorld).y);

  const material = new LineBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  material.colorNode = vColor;
  material.opacityNode = clamp(vAlpha.mul(horizonClipMask), float(0.0), float(1.0));

  const line = new THREE.LineSegments(geometry, material);
  line.name = 'MeteorTrails';
  line.frustumCulled = false;
  line.renderOrder = 3;
  line.visible = false;

  const tempColor = new THREE.Color();
  const whiteColor = new THREE.Color('#ffffff');
  const workColor = new THREE.Color();

  const writeVertex = (
    idx: number,
    dir: [number, number, number],
    r: number,
    g: number,
    b: number,
    alpha: number,
  ) => {
    positions[idx * 3] = dir[0] * METEOR_SPHERE_RADIUS;
    positions[idx * 3 + 1] = dir[1] * METEOR_SPHERE_RADIUS;
    positions[idx * 3 + 2] = dir[2] * METEOR_SPHERE_RADIUS;
    colors[idx * 3] = r;
    colors[idx * 3 + 1] = g;
    colors[idx * 3 + 2] = b;
    alphas[idx] = alpha;
  };

  return {
    line,
    updateTrails(meteors: EvaluatedMeteorState[]) {
      const count = Math.min(meteors.length, MAX_METEORS);
      if (count === 0) {
        line.visible = false;
        geometry.setDrawRange(0, 0);
        return;
      }

      let vertexCount = 0;

      for (let m = 0; m < count; m++) {
        const meteor = meteors[m];
        tempColor.set(meteor.colorHex);

        // Magnitude intensity boost for fireballs
        const magGain = meteor.peakVmag < 0 ? Math.min(1.4, 1.0 + Math.abs(meteor.peakVmag) * 0.1) : 0.85;
        const wakePeakAlpha = meteor.wakeAlpha * 0.45 * magGain;
        const headPeakAlpha = Math.max(meteor.headBrightness * magGain, wakePeakAlpha * 0.65);

        // 1. Lingering ionization wake (wakeOriginDir -> tailDir)
        for (let s = 0; s < WAKE_SEGMENTS; s++) {
          const t0 = s / WAKE_SEGMENTS;
          const t1 = (s + 1) / WAKE_SEGMENTS;
          const p0 = slerpUnitVectors(meteor.wakeOriginDir, meteor.tailDir, t0);
          const p1 = slerpUnitVectors(meteor.wakeOriginDir, meteor.tailDir, t1);

          writeVertex(
            vertexCount,
            p0,
            tempColor.r,
            tempColor.g,
            tempColor.b,
            t0 * wakePeakAlpha,
          );
          writeVertex(
            vertexCount + 1,
            p1,
            tempColor.r,
            tempColor.g,
            tempColor.b,
            t1 * wakePeakAlpha,
          );
          vertexCount += 2;
        }

        // 2. Incandescent streak (tailDir -> headDir)
        const whiteBlendMax = meteor.isHeadActive ? 0.92 : 0.25;
        for (let s = 0; s < STREAK_SEGMENTS; s++) {
          const t0 = s / STREAK_SEGMENTS;
          const t1 = (s + 1) / STREAK_SEGMENTS;
          const p0 = slerpUnitVectors(meteor.tailDir, meteor.headDir, t0);
          const p1 = slerpUnitVectors(meteor.tailDir, meteor.headDir, t1);

          workColor.copy(tempColor).lerp(whiteColor, Math.pow(t0, 1.6) * whiteBlendMax);
          const a0 = wakePeakAlpha + (headPeakAlpha - wakePeakAlpha) * Math.pow(t0, 1.35);
          writeVertex(vertexCount, p0, workColor.r, workColor.g, workColor.b, a0);

          workColor.copy(tempColor).lerp(whiteColor, Math.pow(t1, 1.6) * whiteBlendMax);
          const a1 = wakePeakAlpha + (headPeakAlpha - wakePeakAlpha) * Math.pow(t1, 1.35);
          writeVertex(vertexCount + 1, p1, workColor.r, workColor.g, workColor.b, a1);

          vertexCount += 2;
        }
      }

      posAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      geometry.setDrawRange(0, vertexCount);
      line.visible = vertexCount > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createMeteorHeadBillboards() {
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = 0;
  basePlane.dispose();

  const headDirData = new Float32Array(MAX_METEORS * 3);
  const tailDirData = new Float32Array(MAX_METEORS * 3);
  const colorData = new Float32Array(MAX_METEORS * 3);
  // [brightness, radiusPx, isFireball]
  const metaData = new Float32Array(MAX_METEORS * 3);

  const headAttr = new THREE.InstancedBufferAttribute(headDirData, 3);
  headAttr.setUsage(THREE.DynamicDrawUsage);
  const tailAttr = new THREE.InstancedBufferAttribute(tailDirData, 3);
  tailAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(colorData, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.InstancedBufferAttribute(metaData, 3);
  metaAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('aMeteorHeadDir', headAttr);
  geometry.setAttribute('aMeteorTailDir', tailAttr);
  geometry.setAttribute('aMeteorColor', colorAttr);
  geometry.setAttribute('aMeteorMeta', metaAttr);

  const uFovDeg = uniform(76);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);

  const aHeadDir = attribute('aMeteorHeadDir', 'vec3');
  const aTailDir = attribute('aMeteorTailDir', 'vec3');
  const aColor = attribute('aMeteorColor', 'vec3');
  const aMeta = attribute('aMeteorMeta', 'vec3');

  const vQuadUv = varying(positionGeometry.xy, 'vMeteorHeadUv');
  const vColor = varying(aColor, 'vMeteorHeadColor');
  const vMeta = varying(aMeta, 'vMeteorHeadMeta');
  const vVelDir = varying(
    Fn(() => {
      const headWorld = normalize(aHeadDir).mul(METEOR_SPHERE_RADIUS);
      const tailWorld = normalize(aTailDir).mul(METEOR_SPHERE_RADIUS);
      const headClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(headWorld, 1.0));
      const tailClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(tailWorld, 1.0));
      const headNdc = headClip.xy.div(max(headClip.w, float(0.001)));
      const tailNdc = tailClip.xy.div(max(tailClip.w, float(0.001)));
      return normalize(headNdc.sub(tailNdc).add(vec2(0.0001, 0.0001)));
    })(),
    'vMeteorVelDir',
  );

  const vertexNode = Fn(() => {
    const worldDir = normalize(aHeadDir);
    const worldPos = worldDir.mul(METEOR_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    const zoomBoost = mix(
      float(1.0),
      float(1.45),
      float(1.0).sub(smoothstep(float(12.0), float(95.0), uFovDeg)),
    );
    const radiusPx = clamp(aMeta.y.mul(zoomBoost), float(6.0), float(34.0));
    const isVisible = worldDir.y.greaterThan(-0.01).and(centerClip.w.greaterThan(0.0));
    const finalRadiusPx = select(isVisible, radiusPx, float(0.0));

    const ndcOffset = positionGeometry.xy
      .mul(finalRadiusPx)
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
    const r = length(vQuadUv);
    const core = exp(r.mul(r).mul(-18.0));
    return mix(vColor, vec3(1.0, 1.0, 1.0), clamp(core.mul(1.15), float(0.0), float(1.0)));
  })();

  const fragmentOpacityNode = Fn(() => {
    const uv = vQuadUv;
    const r = length(uv);
    const dir = normalize(vVelDir);
    const perpDir = vec2(dir.y.negate(), dir.x);

    const along = dot(uv, dir);
    const perp = dot(uv, perpDir);

    const core = exp(r.mul(r).mul(-22.0));
    const halo = exp(r.mul(r).mul(-4.5)).mul(mix(float(0.35), float(0.65), vMeta.z));
    const flare = exp(along.mul(along).mul(-3.2).sub(perp.mul(perp).mul(26.0))).mul(
      mix(float(0.3), float(0.85), vMeta.z),
    );
    const radialCut = float(1.0).sub(smoothstep(float(0.82), float(1.0), r));

    return clamp(core.add(halo).add(flare).mul(vMeta.x).mul(radialCut), float(0.0), float(1.0));
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
  mesh.name = 'MeteorHeads';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;

  const tempColor = new THREE.Color();

  return {
    mesh,
    updateHeads(
      meteors: EvaluatedMeteorState[],
      fovDeg: number,
      viewportWidth: number,
      viewportHeight: number,
      pixelRatio: number,
    ) {
      let count = 0;
      for (const meteor of meteors) {
        if (!meteor.isHeadActive || meteor.headBrightness <= 0.01) continue;
        if (count >= MAX_METEORS) break;

        const vIdx = count * 3;
        headDirData[vIdx] = meteor.headDir[0];
        headDirData[vIdx + 1] = meteor.headDir[1];
        headDirData[vIdx + 2] = meteor.headDir[2];

        tailDirData[vIdx] = meteor.tailDir[0];
        tailDirData[vIdx + 1] = meteor.tailDir[1];
        tailDirData[vIdx + 2] = meteor.tailDir[2];

        tempColor.set(meteor.colorHex);
        colorData[vIdx] = tempColor.r;
        colorData[vIdx + 1] = tempColor.g;
        colorData[vIdx + 2] = tempColor.b;

        const isFireball = meteor.peakVmag <= -1.5 ? 1.0 : 0.0;
        const radiusPx = meteor.peakVmag <= -1.5 ? 24.0 : meteor.peakVmag < 0 ? 15.0 : 10.5;
        metaData[vIdx] = meteor.headBrightness;
        metaData[vIdx + 1] = radiusPx;
        metaData[vIdx + 2] = isFireball;

        count += 1;
      }

      geometry.instanceCount = count;
      mesh.visible = count > 0;

      if (count > 0) {
        headAttr.needsUpdate = true;
        tailAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        metaAttr.needsUpdate = true;
      }

      uFovDeg.value = fovDeg;
      uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      uPixelRatio.value = pixelRatio;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Creates the WebGPU/WebGL2 meteor trail + incandescent fireball head layer.
 */
export function createMeteorLayer(): MeteorLayer {
  const group = new THREE.Group();
  group.name = 'MeteorGroup';
  group.visible = false;

  const trails = createMeteorTrailMesh();
  const heads = createMeteorHeadBillboards();

  group.add(trails.line);
  group.add(heads.mesh);

  return {
    group,
    update({ meteors, fovDeg, viewportWidth, viewportHeight, pixelRatio, visible }) {
      group.visible = visible;
      if (!visible) return;

      trails.updateTrails(meteors);
      heads.updateHeads(meteors, fovDeg, viewportWidth, viewportHeight, pixelRatio);
    },
    dispose() {
      trails.dispose();
      heads.dispose();
    },
  };
}
