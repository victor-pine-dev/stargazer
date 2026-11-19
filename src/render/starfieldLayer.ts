import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  asin,
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
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { StarCatalogData } from '../data/catalogLoader';
import { getBortleProfile } from '../astro/spectral';

const STAR_SPHERE_RADIUS = 460;

export interface StarfieldLayer {
  mesh: THREE.Mesh;
  starCount: number;
  update: (params: {
    eqToWorld: THREE.Matrix4;
    elapsedSec: number;
    fovDeg: number;
    sunAltDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    showAtmosphere: boolean;
    bortleClass?: number;
  }) => void;
  dispose: () => void;
}

/**
 * Evaluates Ballesteros' B-V -> Kelvin -> display RGB spectral tint once per star on catalog load.
 */
function computePrecomputedStarRgb(bvInput: number): [number, number, number] {
  const bv = Math.max(-0.35, Math.min(2.1, Number.isFinite(bvInput) ? bvInput : 0.65));
  const termA = 1.0 / (bv * 0.92 + 1.7);
  const termB = 1.0 / (bv * 0.92 + 0.62);
  const tempK = 4600.0 * (termA + termB);
  const t = Math.max(1800.0, Math.min(32000.0, tempK)) / 100.0;

  const tOver60 = Math.max(t - 60.0, 0.01);
  const rHigh = Math.max(0.0, Math.min(1.0, 1.292936 * Math.pow(tOver60, -0.133205)));
  const r = t <= 66.0 ? 1.0 : rHigh;

  const gLow = Math.max(0.0, Math.min(1.0, 0.390082 * Math.log(Math.max(t, 1.0)) - 0.631841));
  const gHigh = Math.max(0.0, Math.min(1.0, 1.129891 * Math.pow(tOver60, -0.075515)));
  const g = t <= 66.0 ? gLow : gHigh;

  const tMinus10 = Math.max(t - 10.0, 1.0);
  const bMid = Math.max(0.0, Math.min(1.0, 0.543207 * Math.log(tMinus10) - 1.196254));
  const b = t >= 66.0 ? 1.0 : t <= 19.0 ? 0.0 : bMid;

  return [
    1.0 + (r - 1.0) * 0.88,
    1.0 + (g - 1.0) * 0.88,
    1.0 + (b - 1.0) * 0.88,
  ];
}

function cpuSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Creates the single-draw-call instanced spectral starfield layer (WebGPU + WebGL2 compatible).
 */
export function createStarfieldLayer(catalog: StarCatalogData): StarfieldLayer {
  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = catalog.count;

  const starColors = new Float32Array(catalog.count * 3);
  const starMags = new Float32Array(catalog.count);
  for (let i = 0; i < catalog.count; i++) {
    const mIdx = i * 4;
    starMags[i] = catalog.starMeta[mIdx];
    const [r, g, b] = computePrecomputedStarRgb(catalog.starMeta[mIdx + 1]);
    const cIdx = i * 3;
    starColors[cIdx] = r;
    starColors[cIdx + 1] = g;
    starColors[cIdx + 2] = b;
  }

  const countStarsUpToMag = (maxMag: number): number => {
    let lo = 0;
    let hi = starMags.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starMags[mid] <= maxMag) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const dirAttr = new THREE.InstancedBufferAttribute(catalog.positionsJ2000, 3);
  const metaAttr = new THREE.InstancedBufferAttribute(catalog.starMeta, 4);
  const colorAttr = new THREE.InstancedBufferAttribute(starColors, 3);
  geometry.setAttribute('aStarDir', dirAttr);
  geometry.setAttribute('aStarMeta', metaAttr);
  geometry.setAttribute('aStarColor', colorAttr);

  const uEqToWorld = uniform(new THREE.Matrix4());
  const uTime = uniform(0);
  const uFovDeg = uniform(75);
  const uSunAltDeg = uniform(-30);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);
  const uShowAtmosphere = uniform(1.0);
  const uBortleMagShift = uniform(0.0);

  const aStarDir = attribute('aStarDir', 'vec3');
  const aStarMeta = attribute('aStarMeta', 'vec4');

  const vQuadUv = varying(positionGeometry.xy, 'vStarQuadUv');
  const vStarColor = varying(attribute('aStarColor', 'vec3'), 'vStarSpectralRgb');

  const vStarData = varying(
    Fn(() => {
      const mag = aStarMeta.x;
      const phase = aStarMeta.z;

      const worldDir = normalize(uEqToWorld.mul(vec4(aStarDir, 0.0)).xyz);
      const altSin = worldDir.y;
      const altDeg = asin(clamp(altSin, float(-1.0), float(1.0))).mul(57.2957795);

      // Kasten-Young style airmass extinction near horizon (X ~ 1 / sin(Alt))
      const sinSafe = max(altSin, float(0.025));
      const airmass = float(1.0).div(sinSafe.add(float(0.025).mul(exp(float(-11.0).mul(sinSafe)))));
      const extinction = exp(float(-0.12).mul(airmass.sub(1.0)).mul(uShowAtmosphere));

      // High-frequency atmospheric scintillation intensified near the horizon (Alt < 20 deg)
      const horizonScintWeight = float(1.0)
        .sub(smoothstep(float(1.0), float(24.0), altDeg))
        .mul(uShowAtmosphere);
      const twinkleA = sin(uTime.mul(6.4).add(phase.mul(7.0)));
      const twinkleB = sin(uTime.mul(13.9).add(phase.mul(17.0)));
      const scintillation = float(1.0).add(
        twinkleA.mul(0.55).add(twinkleB.mul(0.45)).mul(0.28).mul(horizonScintWeight.add(0.06)),
      );

      // Pogson flux F = 10^(-0.4 * (m - m0))
      const flux = pow(float(10.0), float(-0.4).mul(mag.sub(1.4)));

      // Zoom-dependent limiting magnitude reveal + Bortle sky quality offset
      const zoomNorm = float(1.0).sub(smoothstep(float(14.0), float(95.0), uFovDeg));
      const zoomFactor = clamp(float(75.0).div(max(uFovDeg, float(10.0))), float(0.8), float(3.8));
      const magLimit = mix(float(6.6), float(8.35), zoomNorm).add(uBortleMagShift.mul(uShowAtmosphere));
      const magVisibility = float(1.0).sub(smoothstep(magLimit.sub(0.8), magLimit.add(0.4), mag));

      // Suppress stars gracefully in bright daylight while preserving bright stars through twilight
      const brightStarNorm = float(1.0).sub(smoothstep(float(-1.5), float(2.5), mag));
      const brightTwilightThreshold = mix(float(-9.5), float(2.5), brightStarNorm);
      const daylightSuppression = mix(
        float(1.0),
        float(1.0).sub(smoothstep(brightTwilightThreshold.sub(4.0), brightTwilightThreshold.add(3.5), uSunAltDeg)),
        uShowAtmosphere,
      );

      // Horizon clip fade (-0.5 deg to +1.5 deg)
      const horizonFade = smoothstep(float(-0.015), float(0.02), altSin);

      const brightness = clamp(
        pow(flux.mul(zoomFactor), float(0.42)).mul(0.76),
        float(0.1),
        float(1.9),
      )
        .mul(extinction)
        .mul(scintillation)
        .mul(magVisibility)
        .mul(daylightSuppression)
        .mul(horizonFade);

      return vec3(brightness, mag, altSin);
    })(),
    'vStarData',
  );

  const vertexNode = Fn(() => {
    const mag = aStarMeta.x;
    const worldDir = normalize(uEqToWorld.mul(vec4(aStarDir, 0.0)).xyz);
    const worldPos = worldDir.mul(STAR_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    // Billboard radius in CSS pixels: large bright core + halo for m < 2, crisp pinpoint for m > 5
    const flux = pow(float(10.0), float(-0.4).mul(mag.sub(1.2)));
    const zoomSizeBoost = mix(
      float(0.95),
      float(1.5),
      float(1.0).sub(smoothstep(float(12.0), float(100.0), uFovDeg)),
    );
    const baseRadiusPx = clamp(
      float(1.9).add(pow(flux, float(0.36)).mul(3.6)).mul(zoomSizeBoost),
      float(1.7),
      float(22.0),
    );

    // Collapse quads below horizon or behind the camera clip plane
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

  const fragmentIntensityNode = Fn(() => {
    const r = length(vQuadUv);
    const brightness = vStarData.x;
    const mag = vStarData.y;

    const radialCut = float(1.0).sub(smoothstep(float(0.8), float(1.0), r));
    // Crisp Gaussian PSF core
    const core = exp(r.mul(r).mul(-15.0));
    // Soft Airy/Gaussian diffraction halo for bright stars (m < 2.5)
    const haloStrength = float(1.0).sub(smoothstep(float(-1.2), float(2.8), mag)).mul(0.58);
    const halo = exp(r.mul(r).mul(-3.4)).mul(haloStrength);

    return clamp(core.add(halo).mul(brightness).mul(radialCut), float(0.0), float(1.0));
  })();

  const fragmentColorNode = Fn(() => {
    const r = length(vQuadUv);
    const coreTint = exp(r.mul(r).mul(-18.0));
    // White-hot center blending outward into Ballesteros blackbody spectral hue
    return mix(vStarColor, vec3(1.0, 1.0, 1.0), coreTint.mul(0.7));
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
  material.opacityNode = fragmentIntensityNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'SpectralStarfield';
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;

  basePlane.dispose();

  return {
    mesh,
    starCount: catalog.count,
    update({
      eqToWorld,
      elapsedSec,
      fovDeg,
      sunAltDeg,
      viewportWidth,
      viewportHeight,
      pixelRatio,
      showAtmosphere,
      bortleClass = 4,
    }) {
      const bortleShift = showAtmosphere ? getBortleProfile(bortleClass).magShift : 0;
      const zoomNorm = 1.0 - cpuSmoothstep(14.0, 95.0, fovDeg);
      const effectiveMagLimit = 6.6 + (8.35 - 6.6) * zoomNorm + bortleShift;
      const maxDrawMag =
        showAtmosphere && sunAltDeg > 5.5 ? 1.6 : effectiveMagLimit + 0.45;
      geometry.instanceCount = countStarsUpToMag(maxDrawMag);

      uEqToWorld.value.copy(eqToWorld);
      uTime.value = elapsedSec;
      uFovDeg.value = fovDeg;
      uSunAltDeg.value = sunAltDeg;
      uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      uPixelRatio.value = pixelRatio;
      uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
      uBortleMagShift.value = bortleShift;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
