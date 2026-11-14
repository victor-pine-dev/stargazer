import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG_TO_RAD, raDecToJ2000UnitVector } from '../astro/coordinates';
import type { SolarSystemBodyId, SolarSystemEphemeris } from '../astro/solarSystem';
import type { ScreenLabelItem } from './constellationLayer';

const MOON_SPHERE_RADIUS = 448;
const PLANET_SPHERE_RADIUS = 450;

// J2000 IAU Lunar North Pole (RA = 269.99 deg, Dec = +66.54 deg)
const [LUNAR_POLE_X, LUNAR_POLE_Y, LUNAR_POLE_Z] = raDecToJ2000UnitVector(
  269.99 * DEG_TO_RAD,
  66.54 * DEG_TO_RAD,
);

const PLANET_COLORS: Record<SolarSystemBodyId, [number, number, number]> = {
  sun: [1.0, 0.94, 0.78],
  moon: [0.95, 0.95, 0.92],
  mercury: [0.84, 0.80, 0.74],
  venus: [1.0, 0.97, 0.88],
  mars: [1.0, 0.56, 0.36],
  jupiter: [0.98, 0.90, 0.75],
  saturn: [0.96, 0.87, 0.63],
  uranus: [0.64, 0.92, 0.96],
  neptune: [0.46, 0.68, 1.0],
};

export interface SolarSystemLayer {
  group: THREE.Group;
  update: (params: {
    ephemeris: SolarSystemEphemeris;
    eqToWorld: THREE.Matrix4;
    camera: THREE.PerspectiveCamera;
    fovDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    showAtmosphere: boolean;
    visible: boolean;
  }) => void;
  collectVisibleLabels: (
    camera: THREE.PerspectiveCamera,
    ephemeris: SolarSystemEphemeris,
    viewportWidth: number,
    viewportHeight: number,
    fovDeg: number,
    showAtmosphere: boolean,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

/**
 * Procedural 2D/3D value noise in TSL for selenographic maria and highlands.
 */
const hash3 = Fn(([p]: [unknown]) => {
  const pv = vec3(p as number);
  const d = dot(pv, vec3(127.1, 311.7, 74.7));
  return fract(sin(d).mul(43758.5453123));
});

const noise3 = Fn(([p]: [unknown]) => {
  const pv = vec3(p as number);
  const i = floor(pv);
  const f = fract(pv);
  const u = f.mul(f).mul(vec3(3.0, 3.0, 3.0).sub(f.mul(2.0)));

  const n000 = hash3(i.add(vec3(0.0, 0.0, 0.0)));
  const n100 = hash3(i.add(vec3(1.0, 0.0, 0.0)));
  const n010 = hash3(i.add(vec3(0.0, 1.0, 0.0)));
  const n110 = hash3(i.add(vec3(1.0, 1.0, 0.0)));
  const n001 = hash3(i.add(vec3(0.0, 0.0, 1.0)));
  const n101 = hash3(i.add(vec3(1.0, 0.0, 1.0)));
  const n011 = hash3(i.add(vec3(0.0, 1.0, 1.0)));
  const n111 = hash3(i.add(vec3(1.0, 1.0, 1.0)));

  const nx00 = mix(n000, n100, u.x);
  const nx10 = mix(n010, n110, u.x);
  const nx01 = mix(n001, n101, u.x);
  const nx11 = mix(n011, n111, u.x);

  const nxy0 = mix(nx00, nx10, u.y);
  const nxy1 = mix(nx01, nx11, u.y);

  return mix(nxy0, nxy1, u.z);
});

function createMoonPhaseMesh() {
  const geometry = new THREE.PlaneGeometry(2, 2);

  const uMoonWorldDir = uniform(new THREE.Vector3(0, 0.5, -0.866));
  const uMoonSunLocal = uniform(new THREE.Vector3(1, 0, 0));
  const uMoonPole2D = uniform(new THREE.Vector2(0, 1));
  const uMoonRadiusPx = uniform(16);
  const uMoonPhaseFraction = uniform(0.5);
  const uSunAltDeg = uniform(-30);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);
  const uShowAtmosphere = uniform(1.0);

  // Scale quad UVs to [-1.4, 1.4] so corona glow (1.0 < r <= 1.35) never clips the square corners
  const vQuadUv = varying(positionGeometry.xy.mul(1.4), 'vMoonQuadUv');

  const vertexNode = Fn(() => {
    const worldPos = normalize(uMoonWorldDir).mul(MOON_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    const isVisible = uMoonWorldDir.y.greaterThan(-0.04).and(centerClip.w.greaterThan(0.0));
    const quadRadiusPx = select(isVisible, uMoonRadiusPx.mul(1.4), float(0.0));

    const ndcOffset = positionGeometry.xy
      .mul(quadRadiusPx)
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

  const moonAppearanceNode = Fn(() => {
    const uv = vQuadUv;
    const r2 = dot(uv, uv);
    const r = sqrt(r2);

    // 3D spherical normal on the observer-facing hemisphere
    const nz = sqrt(max(float(0.0), float(1.0).sub(r2)));
    const normal = vec3(uv.x, uv.y, nz);

    // Rotate disk coords into selenographic frame using projected Lunar North Pole
    const selX = uv.x.mul(uMoonPole2D.y).sub(uv.y.mul(uMoonPole2D.x));
    const selY = uv.x.mul(uMoonPole2D.x).add(uv.y.mul(uMoonPole2D.y));
    const selPos = vec3(selX, selY, nz);

    // Multi-octave procedural selenographic maria + highland relief
    const broad = noise3(selPos.mul(2.6).add(vec3(1.4, -0.7, 0.9)));
    const medium = noise3(selPos.mul(5.8).add(vec3(-2.1, 1.7, 0.3)));
    const fine = noise3(selPos.mul(14.5).add(vec3(0.5, 2.2, -1.3)));

    // Bias maria basins toward realistic northern/western nearside distribution (Imbrium, Procellarum, Serenitatis, Tranquillitatis)
    const basinBias = clamp(
      float(0.55)
        .add(selY.mul(0.28))
        .sub(selX.mul(0.18))
        .add(broad.mul(0.52))
        .add(medium.mul(0.26)),
      float(0.0),
      float(1.0),
    );
    const mariaMask = smoothstep(float(0.72), float(1.04), basinBias);
    const highlandAlbedo = mix(float(0.76), float(0.98), fine);
    const mariaAlbedo = mix(float(0.38), float(0.54), fine);
    const albedo = mix(highlandAlbedo, mariaAlbedo, mariaMask);

    const regolithTint = mix(vec3(0.95, 0.94, 0.90), vec3(0.76, 0.78, 0.82), mariaMask);
    const surfaceBase = regolithTint.mul(albedo);

    // Sun incidence cosine mu0 = N . normalize(uMoonSunLocal)
    const sunDir = normalize(uMoonSunLocal);
    const mu0 = dot(normal, sunDir);
    const muObs = max(nz, float(0.03));

    // Physical Lommel-Seeliger lunar regolith reflectance + gentle penumbral terminator
    const sunlitMu0 = max(mu0, float(0.0));
    const lommelSeeliger = sunlitMu0.div(sunlitMu0.add(muObs.mul(0.75)).add(0.05));
    const terminatorSoft = smoothstep(float(-0.045), float(0.065), mu0);
    const sunlitRadiance = mix(lommelSeeliger, pow(sunlitMu0, float(0.65)), float(0.18)).mul(
      terminatorSoft,
    );

    // Earthshine on the unlit lunar night hemisphere (strongest near New/Crescent Moon, hidden in daylight)
    const daylightFactor = smoothstep(float(-6.0), float(4.0), uSunAltDeg).mul(uShowAtmosphere);
    const earthshineStrength = float(0.055)
      .add(float(0.075).mul(float(1.0).sub(uMoonPhaseFraction)))
      .mul(float(1.0).sub(daylightFactor.mul(0.92)));
    const nightWeight = float(1.0).sub(terminatorSoft);
    const earthshineColor = vec3(0.58, 0.70, 0.92).mul(albedo).mul(earthshineStrength).mul(nightWeight);

    // Subtle atmospheric warm extinction near the horizon
    const altSin = uMoonWorldDir.y;
    const horizonWarmth = float(1.0).sub(smoothstep(float(0.0), float(0.18), altSin));
    const extinctionColor = mix(vec3(1.0, 0.99, 0.96), vec3(1.0, 0.74, 0.48), horizonWarmth.mul(0.75));
    const horizonFade = smoothstep(float(-0.015), float(0.02), altSin);

    const diskColor = surfaceBase.mul(sunlitRadiance.mul(1.25)).mul(extinctionColor).add(earthshineColor);

    // Anti-aliased lunar limb + soft corona glow for 1.0 < r <= 1.35
    const diskEdge = float(1.0).sub(smoothstep(float(0.95), float(1.01), r));
    const coronaFade = float(1.0).sub(smoothstep(float(0.98), float(1.35), r));
    const coronaGlow = exp(max(r.sub(0.95), float(0.0)).mul(-5.8))
      .mul(coronaFade)
      .mul(float(0.18).add(uMoonPhaseFraction.mul(0.28)))
      .mul(float(1.0).sub(daylightFactor.mul(0.78)));

    const coronaColor = vec3(0.84, 0.90, 1.0).mul(extinctionColor);
    const finalRgb = mix(coronaColor, diskColor, diskEdge);

    // Disk opacity: at night, dark limb occults stars slightly with Earthshine; in daylight, unlit side blends into blue sky
    const sunlitAlpha = clamp(sunlitRadiance.mul(1.65), float(0.0), float(1.0));
    const diskAlpha = mix(float(0.96), sunlitAlpha, daylightFactor.mul(0.92));
    const alpha = clamp(
      max(diskAlpha.mul(diskEdge), coronaGlow).mul(horizonFade),
      float(0.0),
      float(1.0),
    );

    return vec4(finalRgb, alpha);
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    fog: false,
  });
  material.vertexNode = vertexNode;
  material.colorNode = moonAppearanceNode.rgb;
  material.opacityNode = moonAppearanceNode.a;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Moon3DPhase';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  return {
    mesh,
    uMoonWorldDir,
    uMoonSunLocal,
    uMoonPole2D,
    uMoonRadiusPx,
    uMoonPhaseFraction,
    uSunAltDeg,
    uViewport,
    uPixelRatio,
    uShowAtmosphere,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createPlanetsAndSunMesh() {
  const instanceCount = 8; // Sun + Mercury..Neptune
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = instanceCount;
  basePlane.dispose();

  const worldDirData = new Float32Array(instanceCount * 3);
  // [vmag, bodyType (0=planet, 1=sun, 2=saturn), ringTiltRad, phaseFraction]
  const metaData = new Float32Array(instanceCount * 4);
  const colorData = new Float32Array(instanceCount * 3);

  const dirAttr = new THREE.InstancedBufferAttribute(worldDirData, 3);
  dirAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.InstancedBufferAttribute(metaData, 4);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(colorData, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('aBodyWorldDir', dirAttr);
  geometry.setAttribute('aBodyMeta', metaAttr);
  geometry.setAttribute('aBodyColor', colorAttr);

  const uFovDeg = uniform(72);
  const uSunAltDeg = uniform(-30);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);
  const uShowAtmosphere = uniform(1.0);

  const aBodyWorldDir = attribute('aBodyWorldDir', 'vec3');
  const aBodyMeta = attribute('aBodyMeta', 'vec4');
  const aBodyColor = attribute('aBodyColor', 'vec3');

  const vQuadUv = varying(positionGeometry.xy, 'vBodyQuadUv');
  const vBodyColor = varying(aBodyColor, 'vBodyColor');
  const vBodyMeta = varying(aBodyMeta, 'vBodyMeta');

  const vBodyBrightness = varying(
    Fn(() => {
      const mag = aBodyMeta.x;
      const bodyType = aBodyMeta.y;
      const altSin = normalize(aBodyWorldDir).y;

      const isSun = bodyType.greaterThan(0.5).and(bodyType.lessThan(1.5));
      const horizonFade = smoothstep(float(-0.015), float(0.025), altSin);

      // Dim fainter planets gracefully in daylight while keeping Sun and bright Venus visible
      const brightPlanetNorm = float(1.0).sub(smoothstep(float(-4.8), float(2.5), mag));
      const twilightThreshold = mix(float(-9.0), float(8.0), brightPlanetNorm);
      const daylightFade = mix(
        float(1.0),
        float(1.0).sub(smoothstep(twilightThreshold.sub(4.0), twilightThreshold.add(4.0), uSunAltDeg)),
        uShowAtmosphere,
      );

      const flux = pow(float(10.0), float(-0.4).mul(mag.sub(1.0)));
      const planetBrightness = clamp(pow(flux, float(0.32)).mul(0.85), float(0.45), float(1.4)).mul(daylightFade);

      return select(isSun, float(1.35), planetBrightness).mul(horizonFade);
    })(),
    'vBodyBrightness',
  );

  const vertexNode = Fn(() => {
    const mag = aBodyMeta.x;
    const bodyType = aBodyMeta.y;
    const worldDir = normalize(aBodyWorldDir);
    const worldPos = worldDir.mul(PLANET_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    const isSun = bodyType.greaterThan(0.5).and(bodyType.lessThan(1.5));
    const isSaturn = bodyType.greaterThan(1.5);

    const zoomBoost = mix(
      float(1.0),
      float(1.65),
      float(1.0).sub(smoothstep(float(10.0), float(95.0), uFovDeg)),
    );
    const planetRadiusPx = clamp(
      float(4.5).add(max(float(0.0), float(4.2).sub(mag)).mul(1.75)).mul(zoomBoost),
      float(4.2),
      float(18.0),
    );
    const sunRadiusPx = clamp(float(28.0).mul(float(72.0).div(max(uFovDeg, float(12.0)))), float(22.0), float(76.0));
    const saturnBoost = select(isSaturn, float(1.45), float(1.0));
    const baseRadiusPx = select(isSun, sunRadiusPx, planetRadiusPx.mul(saturnBoost));

    const isVisible = worldDir.y.greaterThan(-0.03).and(centerClip.w.greaterThan(0.0));
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
    const r = length(vQuadUv);
    const bodyType = vBodyMeta.y;
    const isSun = bodyType.greaterThan(0.5).and(bodyType.lessThan(1.5));
    const coreWeight = exp(r.mul(r).mul(-12.0));
    const sunCore = mix(vec3(1.0, 0.82, 0.45), vec3(1.0, 0.99, 0.94), smoothstep(float(0.42), float(0.0), r));
    const planetColor = mix(vBodyColor, vec3(1.0, 1.0, 1.0), coreWeight.mul(0.55));
    return select(isSun, sunCore, planetColor);
  })();

  const fragmentOpacityNode = Fn(() => {
    const r = length(vQuadUv);
    const bodyType = vBodyMeta.y;
    const ringTilt = vBodyMeta.z;
    const isSun = bodyType.greaterThan(0.5).and(bodyType.lessThan(1.5));
    const isSaturn = bodyType.greaterThan(1.5);

    const radialMask = float(1.0).sub(smoothstep(float(0.82), float(1.0), r));

    // Sun: bright photosphere disk + warm radial corona
    const sunDisk = float(1.0).sub(smoothstep(float(0.26), float(0.32), r));
    const sunCorona = exp(r.mul(r).mul(-4.8)).mul(0.62);
    const sunAlpha = clamp(sunDisk.add(sunCorona), float(0.0), float(1.0));

    // Planet: crisp planetary disk + non-twinkling Airy halo
    const planetDisk = exp(r.mul(r).mul(-18.0));
    const planetHalo = exp(r.mul(r).mul(-4.2)).mul(0.38);

    // Subtle elliptical ring profile for Saturn scaled by ringTilt
    const tiltFactor = clamp(abs(sin(ringTilt)).add(0.24), float(0.24), float(0.65));
    const ringDist = length(vec2(vQuadUv.x, vQuadUv.y.div(tiltFactor)));
    const ringBand = exp(pow(ringDist.sub(0.52), float(2.0)).mul(-90.0)).mul(0.42);
    const saturnRing = select(isSaturn, ringBand, float(0.0));

    const planetAlpha = clamp(planetDisk.add(planetHalo).add(saturnRing), float(0.0), float(1.0));
    return clamp(select(isSun, sunAlpha, planetAlpha).mul(vBodyBrightness).mul(radialMask), float(0.0), float(1.0));
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
  mesh.name = 'SolarSystemBodies';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  return {
    mesh,
    worldDirData,
    metaData,
    colorData,
    dirAttr,
    metaAttr,
    colorAttr,
    uFovDeg,
    uSunAltDeg,
    uViewport,
    uPixelRatio,
    uShowAtmosphere,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Creates the Solar System GPU layer: 3D Lunar Phase shader + Sun & Mercury-Neptune planetary billboards.
 */
export function createSolarSystemLayer(): SolarSystemLayer {
  const group = new THREE.Group();
  group.name = 'SolarSystemGroup';

  const moonLayer = createMoonPhaseMesh();
  const bodiesLayer = createPlanetsAndSunMesh();
  group.add(bodiesLayer.mesh);
  group.add(moonLayer.mesh);

  const tempCamUp = new THREE.Vector3();
  const tempMoonForward = new THREE.Vector3();
  const tempMoonRight = new THREE.Vector3();
  const tempMoonUp = new THREE.Vector3();
  const tempSunFromMoon = new THREE.Vector3();
  const tempPoleWorld = new THREE.Vector3();
  const tempProjected = new THREE.Vector3();
  const lunarPoleJ2000 = new THREE.Vector3(LUNAR_POLE_X, LUNAR_POLE_Y, LUNAR_POLE_Z);

  return {
    group,
    update({
      ephemeris,
      eqToWorld,
      camera,
      fovDeg,
      viewportWidth,
      viewportHeight,
      pixelRatio,
      showAtmosphere,
      visible,
    }) {
      group.visible = visible;
      if (!visible) return;

      const { sun, moon, planets } = ephemeris;

      // 1. Update 3D Lunar Phase shader uniforms
      moonLayer.uMoonWorldDir.value.set(moon.worldDir[0], moon.worldDir[1], moon.worldDir[2]).normalize();

      // Orthonormal billboard frame aligned with camera up so disk (+u, +v) matches screen (+X, +Y)
      const me = camera.matrixWorld.elements;
      tempCamUp.set(me[4], me[5], me[6]).normalize();
      tempMoonForward.copy(moonLayer.uMoonWorldDir.value).negate();
      tempMoonRight.crossVectors(tempCamUp, tempMoonForward);
      if (tempMoonRight.lengthSq() < 1e-6) {
        tempMoonRight.set(1, 0, 0);
      } else {
        tempMoonRight.normalize();
      }
      tempMoonUp.crossVectors(tempMoonForward, tempMoonRight).normalize();

      tempSunFromMoon.set(
        moon.sunFromMoonWorldDir[0],
        moon.sunFromMoonWorldDir[1],
        moon.sunFromMoonWorldDir[2],
      );
      moonLayer.uMoonSunLocal.value.set(
        tempSunFromMoon.dot(tempMoonRight),
        tempSunFromMoon.dot(tempMoonUp),
        tempSunFromMoon.dot(tempMoonForward),
      );

      // Project J2000 Lunar North Pole into Moon billboard 2D axes to orient selenographic maria
      tempPoleWorld.copy(lunarPoleJ2000).applyMatrix4(eqToWorld).normalize();
      const px = tempPoleWorld.dot(tempMoonRight);
      const py = tempPoleWorld.dot(tempMoonUp);
      const pLen = Math.hypot(px, py) || 1;
      moonLayer.uMoonPole2D.value.set(px / pLen, py / pLen);

      // Scale Moon radius smoothly (~14 px at 72 deg wide FOV up to ~54 px at 10 deg telephoto FOV)
      const tZoom = Math.max(0, Math.min(1, (72 - fovDeg) / 62));
      const moonRadiusPx = 14 + tZoom * 40;
      moonLayer.uMoonRadiusPx.value = moonRadiusPx;
      moonLayer.uMoonPhaseFraction.value = moon.phaseFraction;
      moonLayer.uSunAltDeg.value = sun.altDeg;
      moonLayer.uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      moonLayer.uPixelRatio.value = pixelRatio;
      moonLayer.uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;

      // 2. Update Sun (index 0) and Mercury-Neptune (indices 1..7)
      const allBodies = [sun, ...planets];
      for (let i = 0; i < allBodies.length; i++) {
        const b = allBodies[i];
        const vIdx = i * 3;
        bodiesLayer.worldDirData[vIdx] = b.worldDir[0];
        bodiesLayer.worldDirData[vIdx + 1] = b.worldDir[1];
        bodiesLayer.worldDirData[vIdx + 2] = b.worldDir[2];

        const [r, g, bl] = PLANET_COLORS[b.id];
        bodiesLayer.colorData[vIdx] = r;
        bodiesLayer.colorData[vIdx + 1] = g;
        bodiesLayer.colorData[vIdx + 2] = bl;

        const mIdx = i * 4;
        bodiesLayer.metaData[mIdx] = b.vmag;
        bodiesLayer.metaData[mIdx + 1] = b.id === 'sun' ? 1.0 : b.id === 'saturn' ? 2.0 : 0.0;
        bodiesLayer.metaData[mIdx + 2] = (b.ringTiltDeg ?? 0) * DEG_TO_RAD;
        bodiesLayer.metaData[mIdx + 3] = b.phaseFraction;
      }

      bodiesLayer.dirAttr.needsUpdate = true;
      bodiesLayer.metaAttr.needsUpdate = true;
      bodiesLayer.colorAttr.needsUpdate = true;

      bodiesLayer.uFovDeg.value = fovDeg;
      bodiesLayer.uSunAltDeg.value = sun.altDeg;
      bodiesLayer.uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      bodiesLayer.uPixelRatio.value = pixelRatio;
      bodiesLayer.uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
    },

    collectVisibleLabels(camera, ephemeris, viewportWidth, viewportHeight, fovDeg, showAtmosphere) {
      if (!group.visible) return [];

      const labels: ScreenLabelItem[] = [];
      const sunAlt = ephemeris.sun.altDeg;
      const candidates = [ephemeris.moon, ephemeris.sun, ...ephemeris.planets];

      for (const body of candidates) {
        if (body.altDeg < -0.5) continue;

        // Hide faint outer planets (Uranus/Neptune) in wide FOV unless zoomed in < 48 deg
        if ((body.id === 'uranus' || body.id === 'neptune') && fovDeg >= 48) continue;

        // Hide dimmer planets in bright daylight
        if (showAtmosphere && sunAlt > -1 && body.id !== 'sun' && body.id !== 'moon' && body.vmag > -2.5) {
          continue;
        }

        const radius = body.id === 'moon' ? MOON_SPHERE_RADIUS : PLANET_SPHERE_RADIUS;
        tempProjected
          .set(body.worldDir[0] * radius, body.worldDir[1] * radius, body.worldDir[2] * radius)
          .project(camera);

        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < 8 || sx > viewportWidth - 8 || sy < 8 || sy > viewportHeight - 8) continue;

        const text =
          body.id === 'moon'
            ? `Moon · ${Math.round(ephemeris.moon.phaseFraction * 100)}%`
            : body.name;

        labels.push({
          id: `body-${body.id}`,
          text,
          kind: 'planet',
          x: sx + (body.id === 'moon' ? 18 : 11),
          y: sy - 9,
          priority: body.id === 'moon' || body.id === 'sun' ? 95 : 85 - body.vmag,
        });
      }

      return labels;
    },

    dispose() {
      moonLayer.dispose();
      bodiesLayer.dispose();
    },
  };
}
