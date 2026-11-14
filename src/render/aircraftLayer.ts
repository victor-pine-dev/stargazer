import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
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
  positionWorld,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type {
  AircraftTelemetryState,
  AircraftTrackPoint,
} from '../astro/aircraft';
import type { ScreenLabelItem } from './constellationLayer';

export const AC_SPHERE_RADIUS = 444;
const MAX_AIRCRAFT = 48;
const MAX_CONTRAIL_VERTICES = 384;
const MAX_ARC_VERTICES = 256;

export interface AircraftLayer {
  group: THREE.Group;
  update: (params: {
    aircraft: AircraftTelemetryState[];
    selectedArc: AircraftTrackPoint[];
    selectedHex: string | null;
    elapsedSec: number;
    fovDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    visible: boolean;
  }) => void;
  collectVisibleLabels: (
    camera: THREE.PerspectiveCamera,
    aircraft: AircraftTelemetryState[],
    selectedHex: string | null,
    viewportWidth: number,
    viewportHeight: number,
    fovDeg: number,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

function createDynamicLineLayer(
  name: string,
  maxVertices: number,
  baseOpacity: number,
  renderOrder: number,
) {
  const positions = new Float32Array(maxVertices * 3);
  const colors = new Float32Array(maxVertices * 3);
  const alphas = new Float32Array(maxVertices);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAcLineColor', colorAttr);
  geometry.setAttribute('aAcLineAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const uOpacity = uniform(baseOpacity);
  const vColor = varying(attribute('aAcLineColor', 'vec3'), `v${name}Color`);
  const vAlpha = varying(attribute('aAcLineAlpha', 'float'), `v${name}Alpha`);
  const horizonClipMask = smoothstep(float(-0.01), float(0.025), normalize(positionWorld).y);

  const material = new LineBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  material.colorNode = vColor;
  material.opacityNode = clamp(vAlpha.mul(uOpacity).mul(horizonClipMask), float(0.0), float(1.0));

  const line = new THREE.LineSegments(geometry, material);
  line.name = name;
  line.frustumCulled = false;
  line.renderOrder = renderOrder;
  line.visible = false;

  return {
    line,
    positions,
    colors,
    alphas,
    posAttr,
    colorAttr,
    alphaAttr,
    geometry,
    commit(vertexCount: number) {
      if (vertexCount <= 0) {
        line.visible = false;
        geometry.setDrawRange(0, 0);
        return;
      }
      posAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      geometry.setDrawRange(0, vertexCount);
      line.visible = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Creates the WebGPU/WebGL2 instanced swept-wing aircraft + contrail + flight-path layer.
 */
export function createAircraftLayer(): AircraftLayer {
  const group = new THREE.Group();
  group.name = 'AircraftGroup';

  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = 0;
  basePlane.dispose();

  const worldDirData = new Float32Array(MAX_AIRCRAFT * 3);
  const nextWorldDirData = new Float32Array(MAX_AIRCRAFT * 3);
  // [altitudeNorm, isHeavy (0|1), strobePhase (0..1), isHighlighted (0|1)]
  const metaData = new Float32Array(MAX_AIRCRAFT * 4);
  const colorData = new Float32Array(MAX_AIRCRAFT * 3);

  const dirAttr = new THREE.InstancedBufferAttribute(worldDirData, 3);
  dirAttr.setUsage(THREE.DynamicDrawUsage);
  const nextDirAttr = new THREE.InstancedBufferAttribute(nextWorldDirData, 3);
  nextDirAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.InstancedBufferAttribute(metaData, 4);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(colorData, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('aAcWorldDir', dirAttr);
  geometry.setAttribute('aAcNextWorldDir', nextDirAttr);
  geometry.setAttribute('aAcMeta', metaAttr);
  geometry.setAttribute('aAcColor', colorAttr);

  const uTime = uniform(0);
  const uFovDeg = uniform(72);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);

  const aAcWorldDir = attribute('aAcWorldDir', 'vec3');
  const aAcNextWorldDir = attribute('aAcNextWorldDir', 'vec3');
  const aAcMeta = attribute('aAcMeta', 'vec4');
  const aAcColor = attribute('aAcColor', 'vec3');

  const vQuadUv = varying(positionGeometry.xy, 'vAcQuadUv');
  const vAcMeta = varying(aAcMeta, 'vAcMeta');
  const vAcColor = varying(aAcColor, 'vAcColor');
  const vAcVisibility = varying(
    smoothstep(float(-0.01), float(0.025), normalize(aAcWorldDir).y),
    'vAcVisibility',
  );

  const vertexNode = Fn(() => {
    const isHeavy = aAcMeta.y;
    const isHighlighted = aAcMeta.w;
    const currDir = normalize(aAcWorldDir);
    const nextDir = normalize(aAcNextWorldDir);
    const currPos = currDir.mul(AC_SPHERE_RADIUS);

    // Small tangent step along the aircraft's velocity direction keeps stepClip safely in front of camera
    const deltaDir = nextDir.sub(currDir);
    const deltaLen3 = length(deltaDir);
    const tangentDir = select(
      deltaLen3.greaterThan(0.00005),
      deltaDir.div(max(deltaLen3, float(0.00005))),
      vec3(0.0, 1.0, 0.0),
    );
    const stepPos = currPos.add(tangentDir.mul(1.5));

    const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
    const currClip = viewProj.mul(vec4(currPos, 1.0));
    const stepClip = viewProj.mul(vec4(stepPos, 1.0));

    const safeCurrW = max(currClip.w, float(0.001));
    const safeStepW = max(stepClip.w, float(0.001));
    const currNdc = currClip.xy.div(safeCurrW);
    const stepNdc = stepClip.xy.div(safeStepW);

    const deltaPx = stepNdc.sub(currNdc).mul(uViewport);
    const deltaLen2 = length(deltaPx);
    const fwd2D = select(
      deltaLen2.greaterThan(0.0001),
      deltaPx.div(max(deltaLen2, float(0.0001))),
      vec2(0.0, 1.0),
    );

    const localXY = positionGeometry.xy;
    // Rotate billboard so local +Y aligns with fwd2D and local +X aligns with starboard (fwd2D.y, -fwd2D.x)
    const rotatedXY = vec2(
      fwd2D.y.mul(localXY.x).add(fwd2D.x.mul(localXY.y)),
      fwd2D.y.mul(localXY.y).sub(fwd2D.x.mul(localXY.x)),
    );

    const zoomBoost = mix(
      float(1.0),
      float(1.45),
      float(1.0).sub(smoothstep(float(10.0), float(95.0), uFovDeg)),
    );
    const baseRadius = select(
      isHighlighted.greaterThan(0.5),
      float(19.0),
      select(isHeavy.greaterThan(0.5), float(15.5), float(13.0)),
    );
    const radiusPx = clamp(baseRadius.mul(zoomBoost), float(11.0), float(28.0));

    const isVisible = currDir.y.greaterThan(-0.015).and(currClip.w.greaterThan(0.0));
    const finalRadiusPx = select(isVisible, radiusPx, float(0.0));

    const ndcOffset = rotatedXY
      .mul(finalRadiusPx)
      .mul(uPixelRatio)
      .mul(2.0)
      .div(max(uViewport, vec2(1.0, 1.0)));

    const offscreen = vec4(2.0, 2.0, 2.0, 1.0);
    const projected = vec4(
      currClip.xy.add(ndcOffset.mul(currClip.w)),
      currClip.z,
      currClip.w,
    );

    return select(isVisible, projected, offscreen);
  })();

  const fragmentColorNode = Fn(() => {
    const uv = vQuadUv;
    const strobePhase = vAcMeta.z;
    const s = max(sin(uTime.mul(5.8).add(strobePhase.mul(6.28318))), float(0.0));
    const strobe = s.mul(s).mul(s).mul(s);

    // Port (left, red) & starboard (right, green) wingtip nav lights + white anti-collision strobe
    const portDist = length(uv.sub(vec2(-0.68, -0.28)));
    const stbdDist = length(uv.sub(vec2(0.68, -0.28)));
    const beaconDist = length(uv.sub(vec2(0.0, 0.08)));

    const portGlow = exp(portDist.mul(portDist).mul(-120.0));
    const stbdGlow = exp(stbdDist.mul(stbdDist).mul(-120.0));
    const beaconGlow = exp(beaconDist.mul(beaconDist).mul(-95.0)).mul(strobe);

    let tint = mix(vAcColor, vec3(0.96, 0.98, 1.0), float(0.32));
    tint = mix(tint, vec3(1.0, 0.25, 0.25), clamp(portGlow.mul(0.95), float(0.0), float(1.0)));
    tint = mix(tint, vec3(0.22, 1.0, 0.45), clamp(stbdGlow.mul(0.95), float(0.0), float(1.0)));
    tint = mix(tint, vec3(1.0, 0.98, 0.92), clamp(beaconGlow, float(0.0), float(1.0)));
    return tint;
  })();

  const fragmentOpacityNode = Fn(() => {
    const uv = vQuadUv;
    const r = length(uv);
    const strobePhase = vAcMeta.z;
    const isHighlighted = vAcMeta.w;

    const pulse = sin(uTime.mul(3.4)).mul(0.5).add(0.5);
    const s = max(sin(uTime.mul(5.8).add(strobePhase.mul(6.28318))), float(0.0));
    const strobe = s.mul(s).mul(s).mul(s);

    // Tapered fuselage spine along local Y axis
    const noseTaper = smoothstep(float(0.3), float(0.62), uv.y);
    const tailTaper = smoothstep(float(-0.3), float(-0.56), uv.y);
    const fuseWidth = mix(float(0.075), float(0.022), noseTaper).mul(
      mix(float(1.0), float(0.38), tailTaper),
    );
    const fuseX = float(1.0).sub(smoothstep(fuseWidth.mul(0.45), fuseWidth.add(0.035), abs(uv.x)));
    const fuseY = smoothstep(float(-0.58), float(-0.51), uv.y).mul(
      float(1.0).sub(smoothstep(float(0.57), float(0.64), uv.y)),
    );
    const fuselageMask = fuseX.mul(fuseY);

    // Swept main wings (from y=+0.11 at root to y=-0.30 at wingtips)
    const wingCenterY = float(0.11).sub(abs(uv.x).mul(0.56));
    const wingChord = mix(float(0.11), float(0.042), clamp(abs(uv.x).div(0.72), float(0.0), float(1.0)));
    const wingSpanMask = float(1.0)
      .sub(smoothstep(float(0.66), float(0.74), abs(uv.x)))
      .mul(smoothstep(float(0.02), float(0.06), abs(uv.x)));
    const wingMask = float(1.0)
      .sub(smoothstep(wingChord.mul(0.5), wingChord.add(0.038), abs(uv.y.sub(wingCenterY))))
      .mul(wingSpanMask);

    // Swept horizontal tailplane
    const tailCenterY = float(-0.37).sub(abs(uv.x).mul(0.4));
    const tailSpanMask = float(1.0).sub(smoothstep(float(0.26), float(0.34), abs(uv.x)));
    const tailMask = float(1.0)
      .sub(smoothstep(float(0.032), float(0.072), abs(uv.y.sub(tailCenterY))))
      .mul(tailSpanMask);

    // Wingtip nav lights & strobe flare
    const portDist = length(uv.sub(vec2(-0.68, -0.28)));
    const stbdDist = length(uv.sub(vec2(0.68, -0.28)));
    const beaconDist = length(uv.sub(vec2(0.0, 0.08)));
    const navLights = exp(portDist.mul(portDist).mul(-120.0))
      .add(exp(stbdDist.mul(stbdDist).mul(-120.0)))
      .mul(0.65);
    const beaconFlare = exp(beaconDist.mul(beaconDist).mul(-85.0)).mul(strobe).mul(0.85);

    // Highlight / selection reticle ring
    const selectRing = float(1.0)
      .sub(smoothstep(float(0.025), float(0.075), abs(r.sub(0.84))))
      .mul(isHighlighted)
      .mul(mix(float(0.55), float(0.95), pulse));

    const bodyMask = clamp(
      fuselageMask.add(wingMask).add(tailMask).add(navLights).add(beaconFlare).add(selectRing),
      float(0.0),
      float(1.0),
    );
    const radialCut = float(1.0).sub(smoothstep(float(0.9), float(1.0), r));

    return clamp(bodyMask.mul(vAcVisibility).mul(radialCut).mul(0.94), float(0.0), float(1.0));
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    fog: false,
  });
  material.vertexNode = vertexNode;
  material.colorNode = fragmentColorNode;
  material.opacityNode = fragmentOpacityNode;

  const markersMesh = new THREE.Mesh(geometry, material);
  markersMesh.name = 'AircraftMarkers';
  markersMesh.frustumCulled = false;
  markersMesh.renderOrder = 5;
  markersMesh.visible = false;

  const contrails = createDynamicLineLayer('AircraftContrails', MAX_CONTRAIL_VERTICES, 0.55, 3);
  const selectedArcLine = createDynamicLineLayer('SelectedAircraftArc', MAX_ARC_VERTICES, 0.85, 4);

  group.add(contrails.line);
  group.add(selectedArcLine.line);
  group.add(markersMesh);

  const tempColor = new THREE.Color();
  const tempProjected = new THREE.Vector3();

  const hashStrobePhase = (hex: string): number => {
    let acc = 0;
    for (let i = 0; i < hex.length; i++) {
      acc = (acc * 31 + hex.charCodeAt(i)) % 997;
    }
    return acc / 997;
  };

  return {
    group,
    update({
      aircraft,
      selectedArc,
      selectedHex,
      elapsedSec,
      fovDeg,
      viewportWidth,
      viewportHeight,
      pixelRatio,
      visible,
    }) {
      group.visible = visible;
      if (!visible) return;

      // Keep only above-horizon (or just-below-horizon) aircraft up to MAX_AIRCRAFT
      const activeList: AircraftTelemetryState[] = [];
      for (const ac of aircraft) {
        if (ac.altDeg < -0.5 && ac.hex !== selectedHex) continue;
        activeList.push(ac);
        if (activeList.length >= MAX_AIRCRAFT) break;
      }

      const count = activeList.length;
      geometry.instanceCount = count;
      markersMesh.visible = count > 0;

      let contrailVertexCount = 0;
      const maxContrailSegs = Math.floor(MAX_CONTRAIL_VERTICES / 2);

      for (let i = 0; i < count; i++) {
        const ac = activeList[i];
        const vIdx = i * 3;
        worldDirData[vIdx] = ac.worldDir[0];
        worldDirData[vIdx + 1] = ac.worldDir[1];
        worldDirData[vIdx + 2] = ac.worldDir[2];

        nextWorldDirData[vIdx] = ac.nextWorldDir[0];
        nextWorldDirData[vIdx + 1] = ac.nextWorldDir[1];
        nextWorldDirData[vIdx + 2] = ac.nextWorldDir[2];

        tempColor.set(ac.colorHex);
        colorData[vIdx] = tempColor.r;
        colorData[vIdx + 1] = tempColor.g;
        colorData[vIdx + 2] = tempColor.b;

        const mIdx = i * 4;
        metaData[mIdx] = Math.min(1, ac.altitudeFt / 42000);
        metaData[mIdx + 1] = ac.isHeavy ? 1.0 : 0.0;
        metaData[mIdx + 2] = hashStrobePhase(ac.hex);
        metaData[mIdx + 3] = ac.hex === selectedHex ? 1.0 : 0.0;

        // Render short fading contrail wakes behind high-altitude aircraft (>= 14,000 ft)
        if ((ac.altitudeFt >= 14000 || ac.hex === selectedHex) && ac.trailPoints.length >= 2) {
          for (let j = 0; j < ac.trailPoints.length - 1; j++) {
            if (contrailVertexCount / 2 >= maxContrailSegs) break;
            const p0 = ac.trailPoints[j];
            const p1 = ac.trailPoints[j + 1];
            if (p0.altDeg < -1 && p1.altDeg < -1) continue;

            const v0 = contrailVertexCount;
            const v1 = contrailVertexCount + 1;
            contrails.positions[v0 * 3] = p0.worldDir[0] * AC_SPHERE_RADIUS;
            contrails.positions[v0 * 3 + 1] = p0.worldDir[1] * AC_SPHERE_RADIUS;
            contrails.positions[v0 * 3 + 2] = p0.worldDir[2] * AC_SPHERE_RADIUS;
            contrails.positions[v1 * 3] = p1.worldDir[0] * AC_SPHERE_RADIUS;
            contrails.positions[v1 * 3 + 1] = p1.worldDir[1] * AC_SPHERE_RADIUS;
            contrails.positions[v1 * 3 + 2] = p1.worldDir[2] * AC_SPHERE_RADIUS;

            contrails.colors[v0 * 3] = tempColor.r;
            contrails.colors[v0 * 3 + 1] = tempColor.g;
            contrails.colors[v0 * 3 + 2] = tempColor.b;
            contrails.colors[v1 * 3] = tempColor.r;
            contrails.colors[v1 * 3 + 1] = tempColor.g;
            contrails.colors[v1 * 3 + 2] = tempColor.b;

            contrails.alphas[v0] = Math.max(0.08, 1 - Math.abs(p0.timeOffsetSec) / 38);
            contrails.alphas[v1] = Math.max(0.08, 1 - Math.abs(p1.timeOffsetSec) / 38);
            contrailVertexCount += 2;
          }
        }
      }

      if (count > 0) {
        dirAttr.needsUpdate = true;
        nextDirAttr.needsUpdate = true;
        metaAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
      }

      contrails.commit(contrailVertexCount);

      // Update selected aircraft -60s to +90s trajectory arc
      let arcVertexCount = 0;
      const selectedAc = selectedHex ? aircraft.find((a) => a.hex === selectedHex) : undefined;
      if (selectedAc && selectedArc.length >= 2) {
        const baseColor = new THREE.Color(selectedAc.colorHex);
        const futureColor = baseColor.clone().lerp(new THREE.Color('#ffffff'), 0.35);
        const maxArcSegs = Math.floor(MAX_ARC_VERTICES / 2);

        for (let i = 0; i < selectedArc.length - 1 && arcVertexCount / 2 < maxArcSegs; i++) {
          const a = selectedArc[i];
          const b = selectedArc[i + 1];
          if (a.altDeg < -2 && b.altDeg < -2) continue;

          const v0 = arcVertexCount;
          const v1 = arcVertexCount + 1;

          selectedArcLine.positions[v0 * 3] = a.worldDir[0] * AC_SPHERE_RADIUS;
          selectedArcLine.positions[v0 * 3 + 1] = a.worldDir[1] * AC_SPHERE_RADIUS;
          selectedArcLine.positions[v0 * 3 + 2] = a.worldDir[2] * AC_SPHERE_RADIUS;

          selectedArcLine.positions[v1 * 3] = b.worldDir[0] * AC_SPHERE_RADIUS;
          selectedArcLine.positions[v1 * 3 + 1] = b.worldDir[1] * AC_SPHERE_RADIUS;
          selectedArcLine.positions[v1 * 3 + 2] = b.worldDir[2] * AC_SPHERE_RADIUS;

          const writePt = (idx: number, pt: AircraftTrackPoint) => {
            const isFuture = pt.timeOffsetSec >= 0;
            const c = isFuture ? futureColor : baseColor;
            selectedArcLine.colors[idx * 3] = c.r;
            selectedArcLine.colors[idx * 3 + 1] = c.g;
            selectedArcLine.colors[idx * 3 + 2] = c.b;
            const edgeFade = Math.max(0.2, 1 - Math.abs(pt.timeOffsetSec) / 96);
            selectedArcLine.alphas[idx] = edgeFade * (isFuture ? 0.92 : 0.48);
          };

          writePt(v0, a);
          writePt(v1, b);
          arcVertexCount += 2;
        }
      }
      selectedArcLine.commit(arcVertexCount);

      uTime.value = elapsedSec;
      uFovDeg.value = fovDeg;
      uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      uPixelRatio.value = pixelRatio;
    },

    collectVisibleLabels(
      camera,
      aircraft,
      selectedHex,
      viewportWidth,
      viewportHeight,
      fovDeg,
    ) {
      if (!group.visible) return [];

      const labels: ScreenLabelItem[] = [];
      let emitted = 0;

      for (const ac of aircraft) {
        if (ac.altDeg < 0.5 && ac.hex !== selectedHex) continue;
        const isSelected = ac.hex === selectedHex;

        // Avoid clutter at wide FOV: always show selected aircraft, plus prominent high-elevation / close flights
        if (!isSelected && fovDeg >= 60 && ac.altDeg < 8 && ac.slantRangeKm > 45) {
          continue;
        }

        tempProjected
          .set(
            ac.worldDir[0] * AC_SPHERE_RADIUS,
            ac.worldDir[1] * AC_SPHERE_RADIUS,
            ac.worldDir[2] * AC_SPHERE_RADIUS,
          )
          .project(camera);

        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < 8 || sx > viewportWidth - 8 || sy < 8 || sy > viewportHeight - 8) continue;

        labels.push({
          id: ac.id,
          text: `✈ ${ac.callsign} · ${ac.flightLevel}`,
          kind: 'aircraft',
          x: sx + 14,
          y: sy - 10,
          priority: isSelected ? 96 : 74 + Math.min(18, ac.altDeg * 0.28) - ac.slantRangeKm * 0.12,
        });

        emitted += 1;
        if (emitted >= 22) break;
      }

      return labels;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      contrails.dispose();
      selectedArcLine.dispose();
    },
  };
}
