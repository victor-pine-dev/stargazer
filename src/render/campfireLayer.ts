import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  exp,
  float,
  Fn,
  fract,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { altAzToWorldVector } from '../astro/coordinates';

const PINE_HORIZON_RADIUS = 425;
const FIRE_PIT_CENTER = new THREE.Vector3(0, -1.18, 3.15);
const FLAME_COUNT = 18;
const EMBER_COUNT = 42;
const STONE_COUNT = 14;
const LOG_COUNT = 5;

export interface CampfireLayer {
  group: THREE.Group;
  update: (params: {
    elapsedSec: number;
    visible: boolean;
    reducedMotion: boolean;
  }) => void;
  dispose: () => void;
}

/**
 * Deterministic pseudo-random generator for natural rocks, pine spires, flames, and embers.
 */
function seeded01(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Computes procedural alpine pine treeline altitude in degrees at a given azimuth [0, 360),
 * dipping around South (Az = 180° ± 38°) to leave a clear sky window above the campfire.
 */
function computePineHorizonAltDeg(azDeg: number): number {
  const deltaSouth = Math.abs(((azDeg - 180 + 540) % 360) - 180);
  const clearingWeight = Math.exp(-(deltaSouth * deltaSouth) / (2 * 26 * 26));

  const azRad = (azDeg * Math.PI) / 180;
  // Multi-frequency jagged conifer crown profile
  const crownWave =
    0.45 * Math.abs(Math.sin(azRad * 19.0 + 0.4)) +
    0.35 * Math.abs(Math.sin(azRad * 43.0 + 1.7)) +
    0.2 * Math.abs(Math.sin(azRad * 89.0 + 2.9));
  const ridgeUndulation = 0.75 * Math.sin(azRad * 3.0 + 0.6) + 0.45 * Math.cos(azRad * 5.0 - 0.8);

  const forestBase = 2.6 + ridgeUndulation + crownWave * 3.1;
  // Dip gracefully in the southern campfire clearing (~1.2° to 2.2°)
  return Math.max(1.1, forestBase * (1 - clearingWeight * 0.62) + clearingWeight * 0.4);
}

function createFloatUniform(initial: number) {
  return uniform(initial);
}

type FloatUniform = ReturnType<typeof createFloatUniform>;

function createPineHorizonMesh(uFlicker: FloatUniform) {
  const segments = 360;
  const vertexCount = (segments + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const profiles = new Float32Array(vertexCount * 2); // [vertFrac (0 bottom -> 1 tip), southGlowWeight]
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const azDeg = (i / segments) * 360;
    const tipAltDeg = computePineHorizonAltDeg(azDeg);
    const [bx, by, bz] = altAzToWorldVector(-12, azDeg);
    const [tx, ty, tz] = altAzToWorldVector(tipAltDeg, azDeg);

    const deltaSouth = Math.abs(((azDeg - 180 + 540) % 360) - 180);
    const southGlow = Math.exp(-(deltaSouth * deltaSouth) / (2 * 44 * 44));

    const bIdx = i * 2;
    const tIdx = bIdx + 1;

    positions[bIdx * 3] = bx * PINE_HORIZON_RADIUS;
    positions[bIdx * 3 + 1] = by * PINE_HORIZON_RADIUS;
    positions[bIdx * 3 + 2] = bz * PINE_HORIZON_RADIUS;
    profiles[bIdx * 2] = 0.0;
    profiles[bIdx * 2 + 1] = southGlow;

    positions[tIdx * 3] = tx * PINE_HORIZON_RADIUS;
    positions[tIdx * 3 + 1] = ty * PINE_HORIZON_RADIUS;
    positions[tIdx * 3 + 2] = tz * PINE_HORIZON_RADIUS;
    profiles[tIdx * 2] = 1.0;
    profiles[tIdx * 2 + 1] = southGlow;

    if (i < segments) {
      const nB = (i + 1) * 2;
      const nT = nB + 1;
      indices.push(bIdx, nB, tIdx);
      indices.push(tIdx, nB, nT);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPineProfile', new THREE.BufferAttribute(profiles, 2));
  geometry.setIndex(indices);

  const vProfile = varying(attribute('aPineProfile', 'vec2'), 'vPineProfile');

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  material.colorNode = Fn(() => {
    const baseDark = mix(vec3(0.007, 0.011, 0.022), vec3(0.012, 0.018, 0.032), vProfile.x);
    const warmBounce = vec3(0.28, 0.1, 0.025)
      .mul(vProfile.y)
      .mul(uFlicker)
      .mul(smoothstep(float(0.15), float(0.95), vProfile.x));
    return baseDark.add(warmBounce);
  })();

  material.opacityNode = smoothstep(float(0.0), float(0.22), vProfile.x);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'PineHorizonSilhouette';
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createHearthGroundDisc(uFlicker: FloatUniform) {
  const radius = 14;
  const geometry = new THREE.CircleGeometry(radius, 48);
  const vLocal = varying(positionLocal.xy, 'vHearthGroundLocal');

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  material.colorNode = Fn(() => {
    const r = length(vLocal).div(radius);
    return mix(
      vec3(1.0, 0.45, 0.1),
      vec3(0.55, 0.16, 0.03),
      clamp(r.mul(2.1), float(0.0), float(1.0)),
    );
  })();

  material.opacityNode = Fn(() => {
    const r = length(vLocal).div(radius);
    const innerGlow = exp(r.mul(r).mul(-15.0)).mul(0.55);
    const outerWarmth = exp(r.mul(r).mul(-3.6)).mul(0.18);
    const edgeCut = float(1.0).sub(smoothstep(float(0.65), float(1.0), r));
    return clamp(innerGlow.add(outerWarmth).mul(uFlicker).mul(edgeCut), float(0.0), float(0.85));
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'HearthGroundGlow';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(FIRE_PIT_CENTER.x, -1.22, FIRE_PIT_CENTER.z);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createCoalBedMesh(
  uTime: FloatUniform,
  uMotionScale: FloatUniform,
  uFlicker: FloatUniform,
) {
  const radius = 0.68;
  const geometry = new THREE.CircleGeometry(radius, 24);
  const vLocal = varying(positionLocal.xy, 'vCoalLocal');

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: true,
    depthTest: true,
    fog: false,
  });

  material.colorNode = Fn(() => {
    const r = length(vLocal).div(radius);
    const t = uTime.mul(uMotionScale);
    const pocket = sin(vLocal.x.mul(13.0).add(t.mul(1.4)))
      .mul(cos(vLocal.y.mul(12.0).sub(t.mul(1.1))))
      .mul(0.5)
      .add(0.5);
    const heat = clamp(
      float(1.0).sub(r.mul(0.82)).mul(float(0.55).add(pocket.mul(0.45))).mul(uFlicker),
      float(0.0),
      float(1.0),
    );
    const darkAsh = vec3(0.07, 0.025, 0.015);
    const cherryEmber = vec3(0.95, 0.22, 0.03);
    const goldCoal = vec3(1.0, 0.68, 0.16);
    return mix(mix(darkAsh, cherryEmber, smoothstep(float(0.12), float(0.62), heat)), goldCoal, smoothstep(float(0.58), float(0.95), heat));
  })();

  material.opacityNode = Fn(() => {
    const r = length(vLocal).div(radius);
    return float(1.0).sub(smoothstep(float(0.75), float(1.0), r));
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'FirePitCoalBed';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(FIRE_PIT_CENTER.x, -1.14, FIRE_PIT_CENTER.z);
  mesh.renderOrder = 8;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createCrossedLogsGroup(uFlicker: FloatUniform) {
  const logsGroup = new THREE.Group();
  logsGroup.name = 'FirePitLogs';

  const geometry = new THREE.CylinderGeometry(0.085, 0.105, 1.25, 10);
  const vLocalY = varying(positionLocal.y, 'vLogLocalY');

  const material = new MeshBasicNodeMaterial({
    depthWrite: true,
    depthTest: true,
    fog: false,
  });

  material.colorNode = Fn(() => {
    // Center of teepee logs glows ember-orange while outer ends remain dark charred wood
    const distFromCenter = abs(vLocalY).div(0.625);
    const emberHeat = float(1.0).sub(smoothstep(float(0.15), float(0.78), distFromCenter));
    const barkDark = vec3(0.055, 0.038, 0.032);
    const charredGlow = vec3(0.88, 0.28, 0.04).mul(uFlicker);
    return mix(barkDark, charredGlow, emberHeat.mul(0.82));
  })();

  for (let i = 0; i < LOG_COUNT; i++) {
    const angle = (i / LOG_COUNT) * Math.PI * 2 + 0.35;
    const logMesh = new THREE.Mesh(geometry, material);
    const radialDist = 0.26 + seeded01(i * 17 + 3) * 0.08;
    logMesh.position.set(
      FIRE_PIT_CENTER.x + Math.cos(angle) * radialDist,
      -1.01 + (i % 2) * 0.035,
      FIRE_PIT_CENTER.z + Math.sin(angle) * radialDist,
    );
    logMesh.rotation.order = 'YXZ';
    logMesh.rotation.y = -angle + Math.PI / 2;
    logMesh.rotation.x = 1.08 + seeded01(i * 23 + 9) * 0.14;
    logMesh.rotation.z = (seeded01(i * 31 + 5) - 0.5) * 0.16;
    logMesh.renderOrder = 9;
    logsGroup.add(logMesh);
  }

  return {
    group: logsGroup,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createStoneRingGroup(uFlicker: FloatUniform) {
  const stoneGroup = new THREE.Group();
  stoneGroup.name = 'StoneFirePitRing';

  const geometry = new THREE.IcosahedronGeometry(0.22, 1);

  const material = new MeshBasicNodeMaterial({
    depthWrite: true,
    depthTest: true,
    fog: false,
  });

  material.colorNode = Fn(() => {
    const distToFire = length(positionWorld.xz.sub(vec2(FIRE_PIT_CENTER.x, FIRE_PIT_CENTER.z)));
    const innerRim = float(1.0).sub(smoothstep(float(0.56), float(0.95), distToFire));
    const topRim = smoothstep(float(-1.28), float(-0.98), positionWorld.y);
    const stoneBase = vec3(0.045, 0.048, 0.062);
    const warmLight = vec3(0.95, 0.36, 0.07)
      .mul(innerRim.mul(0.86).add(topRim.mul(0.14)))
      .mul(uFlicker);
    return stoneBase.add(warmLight);
  })();

  const ringRadius = 0.82;
  for (let i = 0; i < STONE_COUNT; i++) {
    const theta = (i / STONE_COUNT) * Math.PI * 2 + (seeded01(i * 11 + 1) - 0.5) * 0.08;
    const r = ringRadius + (seeded01(i * 13 + 7) - 0.5) * 0.06;
    const stone = new THREE.Mesh(geometry, material);
    stone.position.set(
      FIRE_PIT_CENTER.x + Math.cos(theta) * r,
      -1.16 + (seeded01(i * 19 + 2) - 0.5) * 0.03,
      FIRE_PIT_CENTER.z + Math.sin(theta) * r,
    );
    stone.scale.set(
      0.85 + seeded01(i * 29 + 4) * 0.38,
      0.58 + seeded01(i * 37 + 6) * 0.25,
      0.82 + seeded01(i * 41 + 8) * 0.36,
    );
    stone.rotation.set(
      seeded01(i * 43 + 3) * Math.PI,
      theta + seeded01(i * 47 + 5),
      seeded01(i * 53 + 9) * 0.4,
    );
    stone.renderOrder = 10;
    stoneGroup.add(stone);
  }

  return {
    group: stoneGroup,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createInstancedFlamesMesh(
  uTime: FloatUniform,
  uMotionScale: FloatUniform,
) {
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = FLAME_COUNT;
  basePlane.dispose();

  const flamePositions = new Float32Array(FLAME_COUNT * 3);
  // [phase, speed, halfWidth, height]
  const flameMeta = new Float32Array(FLAME_COUNT * 4);

  for (let i = 0; i < FLAME_COUNT; i++) {
    const angle = (i / FLAME_COUNT) * Math.PI * 2 + seeded01(i * 7 + 1) * 0.4;
    const radius = i < 6 ? seeded01(i * 11 + 2) * 0.14 : 0.14 + seeded01(i * 13 + 3) * 0.24;
    const isCore = i < 6;

    flamePositions[i * 3] = FIRE_PIT_CENTER.x + Math.cos(angle) * radius;
    flamePositions[i * 3 + 1] = isCore ? -0.74 : -0.82 + seeded01(i * 17 + 5) * 0.06;
    flamePositions[i * 3 + 2] = FIRE_PIT_CENTER.z + Math.sin(angle) * radius;

    flameMeta[i * 4] = seeded01(i * 19 + 4) * Math.PI * 2; // phase
    flameMeta[i * 4 + 1] = 3.4 + seeded01(i * 23 + 6) * 2.6; // gentle flicker rad/s (< 1 Hz)
    flameMeta[i * 4 + 2] = isCore ? 0.24 + seeded01(i * 29 + 8) * 0.08 : 0.18 + seeded01(i * 31 + 10) * 0.1; // half-width
    flameMeta[i * 4 + 3] = isCore ? 0.88 + seeded01(i * 37 + 12) * 0.2 : 0.62 + seeded01(i * 41 + 14) * 0.24; // height
  }

  geometry.setAttribute('aFlamePos', new THREE.InstancedBufferAttribute(flamePositions, 3));
  geometry.setAttribute('aFlameMeta', new THREE.InstancedBufferAttribute(flameMeta, 4));

  const aFlamePos = attribute('aFlamePos', 'vec3');
  const aFlameMeta = attribute('aFlameMeta', 'vec4');

  const vQuadUv = varying(positionGeometry.xy, 'vFlameQuadUv');
  const vFlameMeta = varying(aFlameMeta, 'vFlameMeta');

  const vertexNode = Fn(() => {
    const quad = positionGeometry.xy;
    const hFrac = quad.y.mul(0.5).add(0.5);

    const toCamXZ = normalize(vec2(aFlamePos.x.negate(), aFlamePos.z.negate()));
    const rightVec = vec3(toCamXZ.y.negate(), float(0.0), toCamXZ.x);
    const upVec = vec3(float(0.0), float(1.0), float(0.0));

    const sway = sin(uTime.mul(aFlameMeta.y).add(hFrac.mul(4.2)).add(aFlameMeta.x))
      .mul(0.11)
      .mul(hFrac)
      .mul(uMotionScale);

    const worldPos = aFlamePos
      .add(rightVec.mul(quad.x.mul(aFlameMeta.z).add(sway)))
      .add(upVec.mul(quad.y.mul(0.5).mul(aFlameMeta.w)));

    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));
  })();

  const fragmentColorNode = Fn(() => {
    const u = vQuadUv.x;
    const v = vQuadUv.y.mul(0.5).add(0.5);
    const dist = abs(u);

    const whiteGold = vec3(1.0, 0.95, 0.75);
    const amberOrange = vec3(1.0, 0.48, 0.08);
    const deepTipRed = vec3(0.9, 0.16, 0.02);

    const coreWeight = clamp(
      float(1.0).sub(dist.mul(1.35)).mul(float(1.0).sub(v.mul(1.1))),
      float(0.0),
      float(1.0),
    );
    const midColor = mix(amberOrange, whiteGold, coreWeight);
    return mix(midColor, deepTipRed, smoothstep(float(0.45), float(0.95), v));
  })();

  const fragmentOpacityNode = Fn(() => {
    const u = vQuadUv.x;
    const v = vQuadUv.y.mul(0.5).add(0.5);
    const phase = vFlameMeta.x;
    const speed = vFlameMeta.y;

    const wobble = sin(v.mul(6.8).sub(uTime.mul(speed.mul(1.15))).add(phase))
      .mul(0.1)
      .mul(v)
      .mul(uMotionScale);
    const halfWidth = mix(float(0.72), float(0.05), pow(v, float(0.85)));
    const dist = abs(u.add(wobble)).div(max(halfWidth, float(0.03)));

    const shapeMask = float(1.0).sub(smoothstep(float(0.15), float(1.0), dist));
    const verticalEnvelope = smoothstep(float(0.0), float(0.15), v).mul(
      float(1.0).sub(smoothstep(float(0.55), float(1.0), v)),
    );
    const pulse = float(0.88).add(
      sin(uTime.mul(speed.mul(0.85)).add(phase)).mul(0.12).mul(uMotionScale),
    );

    return clamp(shapeMask.mul(verticalEnvelope).mul(pulse).mul(0.42), float(0.0), float(0.75));
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  material.vertexNode = vertexNode;
  material.colorNode = fragmentColorNode;
  material.opacityNode = fragmentOpacityNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'CampfireFlames';
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createInstancedEmbersMesh(
  uTime: FloatUniform,
  uMotionScale: FloatUniform,
) {
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = EMBER_COUNT;
  basePlane.dispose();

  // [xOffset, zOffset, phase, speed]
  const emberSeeds = new Float32Array(EMBER_COUNT * 4);
  // [sizeMeters, swirlAmp]
  const emberSizes = new Float32Array(EMBER_COUNT * 2);

  for (let i = 0; i < EMBER_COUNT; i++) {
    const theta = seeded01(i * 11 + 3) * Math.PI * 2;
    const rad = seeded01(i * 17 + 7) * 0.36;
    emberSeeds[i * 4] = Math.cos(theta) * rad;
    emberSeeds[i * 4 + 1] = Math.sin(theta) * rad;
    emberSeeds[i * 4 + 2] = seeded01(i * 23 + 9); // [0, 1) phase
    emberSeeds[i * 4 + 3] = 0.11 + seeded01(i * 29 + 11) * 0.15; // cycles/sec

    emberSizes[i * 2] = 0.015 + seeded01(i * 31 + 13) * 0.018;
    emberSizes[i * 2 + 1] = 0.09 + seeded01(i * 37 + 15) * 0.16;
  }

  geometry.setAttribute('aEmberSeed', new THREE.InstancedBufferAttribute(emberSeeds, 4));
  geometry.setAttribute('aEmberSize', new THREE.InstancedBufferAttribute(emberSizes, 2));

  const aEmberSeed = attribute('aEmberSeed', 'vec4');
  const aEmberSize = attribute('aEmberSize', 'vec2');

  const vQuadUv = varying(positionGeometry.xy, 'vEmberQuadUv');
  const vEmberLife = varying(
    fract(uTime.mul(aEmberSeed.w).mul(uMotionScale).add(aEmberSeed.z)),
    'vEmberLife',
  );

  const vertexNode = Fn(() => {
    const quad = positionGeometry.xy;
    const life = fract(uTime.mul(aEmberSeed.w).mul(uMotionScale).add(aEmberSeed.z));
    const yPos = mix(float(-1.02), float(1.32), life);

    const swirlX = sin(life.mul(6.28318).add(aEmberSeed.z.mul(12.0)))
      .mul(aEmberSize.y)
      .mul(life);
    const swirlZ = cos(life.mul(5.2).add(aEmberSeed.z.mul(9.0)))
      .mul(aEmberSize.y)
      .mul(life);

    const anchor = vec3(
      float(FIRE_PIT_CENTER.x).add(aEmberSeed.x).add(swirlX),
      yPos,
      float(FIRE_PIT_CENTER.z).add(aEmberSeed.y).add(swirlZ),
    );

    const toCamXZ = normalize(vec2(anchor.x.negate(), anchor.z.negate()));
    const rightVec = vec3(toCamXZ.y.negate(), float(0.0), toCamXZ.x);
    const upVec = vec3(float(0.0), float(1.0), float(0.0));

    const worldPos = anchor
      .add(rightVec.mul(quad.x.mul(aEmberSize.x)))
      .add(upVec.mul(quad.y.mul(aEmberSize.x)));

    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));
  })();

  const fragmentColorNode = Fn(() => {
    const r = length(vQuadUv);
    const core = exp(r.mul(r).mul(-16.0));
    return mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.94, 0.68), core);
  })();

  const fragmentOpacityNode = Fn(() => {
    const r = length(vQuadUv);
    const core = exp(r.mul(r).mul(-11.0));
    const radialCut = float(1.0).sub(smoothstep(float(0.75), float(1.0), r));
    const fade = smoothstep(float(0.0), float(0.12), vEmberLife).mul(
      float(1.0).sub(smoothstep(float(0.55), float(1.0), vEmberLife)),
    );
    return clamp(core.mul(radialCut).mul(fade).mul(0.9), float(0.0), float(1.0));
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  material.vertexNode = vertexNode;
  material.colorNode = fragmentColorNode;
  material.opacityNode = fragmentOpacityNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'CampfireEmbers';
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Creates the 3D stone fire pit, dancing TSL flames, rising embers, hearth glow,
 * and 360° pine treeline silhouette for Calm / Relax Mode.
 */
export function createCampfireLayer(): CampfireLayer {
  const group = new THREE.Group();
  group.name = 'CampfireCalmLayer';
  group.visible = false;

  const uTime = uniform(0);
  const uMotionScale = uniform(1.0);
  const uFlicker = uniform(1.0);

  const pineHorizon = createPineHorizonMesh(uFlicker);
  const hearthGround = createHearthGroundDisc(uFlicker);
  const coalBed = createCoalBedMesh(uTime, uMotionScale, uFlicker);
  const crossedLogs = createCrossedLogsGroup(uFlicker);
  const stoneRing = createStoneRingGroup(uFlicker);
  const flames = createInstancedFlamesMesh(uTime, uMotionScale);
  const embers = createInstancedEmbersMesh(uTime, uMotionScale);

  group.add(
    pineHorizon.mesh,
    hearthGround.mesh,
    coalBed.mesh,
    crossedLogs.group,
    stoneRing.group,
    flames.mesh,
    embers.mesh,
  );

  return {
    group,
    update({ elapsedSec, visible, reducedMotion }) {
      group.visible = visible;
      if (!visible) return;

      const motionScale = reducedMotion ? 0.0 : 1.0;
      uTime.value = elapsedSec;
      uMotionScale.value = motionScale;

      // Gentle ~0.9 Hz hearth glow undulation (well below WCAG 2.3.1 3-flashes threshold)
      const gentlePulse =
        1.0 +
        (0.08 * Math.sin(elapsedSec * 4.2) + 0.05 * Math.sin(elapsedSec * 6.9 + 1.3)) *
          motionScale;
      uFlicker.value = gentlePulse;
    },
    dispose() {
      pineHorizon.dispose();
      hearthGround.dispose();
      coalBed.dispose();
      crossedLogs.dispose();
      stoneRing.dispose();
      flames.dispose();
      embers.dispose();
    },
  };
}
