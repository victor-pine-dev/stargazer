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
import {
  ISS_NORAD_ID,
  type SatelliteOrbitArcPoint,
  type SatelliteTelemetryState,
} from '../astro/satellites';
import type { ScreenLabelItem } from './constellationLayer';

const SAT_SPHERE_RADIUS = 446;
const MAX_SATELLITES = 16;
const MAX_ARC_VERTICES = 512;

export interface SatelliteLayer {
  group: THREE.Group;
  update: (params: {
    satellites: SatelliteTelemetryState[];
    issArc: SatelliteOrbitArcPoint[];
    selectedArc: SatelliteOrbitArcPoint[];
    selectedNoradId: number | null;
    elapsedSec: number;
    fovDeg: number;
    viewportWidth: number;
    viewportHeight: number;
    pixelRatio: number;
    visible: boolean;
  }) => void;
  collectVisibleLabels: (
    camera: THREE.PerspectiveCamera,
    satellites: SatelliteTelemetryState[],
    selectedNoradId: number | null,
    viewportWidth: number,
    viewportHeight: number,
    fovDeg: number,
  ) => ScreenLabelItem[];
  dispose: () => void;
}

function createOrbitArcLine(name: string, renderOrder: number) {
  const positions = new Float32Array(MAX_ARC_VERTICES * 3);
  const colors = new Float32Array(MAX_ARC_VERTICES * 3);
  const alphas = new Float32Array(MAX_ARC_VERTICES);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aArcColor', colorAttr);
  geometry.setAttribute('aArcAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const uOpacity = uniform(0.75);
  const vColor = varying(attribute('aArcColor', 'vec3'), 'vSatArcColor');
  const vAlpha = varying(attribute('aArcAlpha', 'float'), 'vSatArcAlpha');
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

  const baseColor = new THREE.Color();
  const eclipsedColor = new THREE.Color('#64748b');
  const futureTint = new THREE.Color('#e0f2fe');
  const futureColor = new THREE.Color();

  const updateArc = (
    points: SatelliteOrbitArcPoint[],
    baseColorHex: string,
    visible: boolean,
  ) => {
    if (!visible || points.length < 2) {
      line.visible = false;
      geometry.setDrawRange(0, 0);
      return;
    }

    baseColor.set(baseColorHex);
    futureColor.copy(baseColor).lerp(futureTint, 0.25);

    let vertexCount = 0;
    const maxSegments = Math.floor(MAX_ARC_VERTICES / 2);

    for (let i = 0; i < points.length - 1 && vertexCount / 2 < maxSegments; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.altDeg < -4 && b.altDeg < -4) continue;

      const p0 = a.worldDir;
      const p1 = b.worldDir;
      const v0 = vertexCount;
      const v1 = vertexCount + 1;

      positions[v0 * 3] = p0[0] * SAT_SPHERE_RADIUS;
      positions[v0 * 3 + 1] = p0[1] * SAT_SPHERE_RADIUS;
      positions[v0 * 3 + 2] = p0[2] * SAT_SPHERE_RADIUS;

      positions[v1 * 3] = p1[0] * SAT_SPHERE_RADIUS;
      positions[v1 * 3 + 1] = p1[1] * SAT_SPHERE_RADIUS;
      positions[v1 * 3 + 2] = p1[2] * SAT_SPHERE_RADIUS;

      const writeVertexStyle = (idx: number, pt: SatelliteOrbitArcPoint) => {
        const isFuture = pt.timeOffsetSec >= 0;
        const c = !pt.isSunlit ? eclipsedColor : isFuture ? futureColor : baseColor;
        colors[idx * 3] = c.r;
        colors[idx * 3 + 1] = c.g;
        colors[idx * 3 + 2] = c.b;

        // Fade near ends of the ±46 min window and show past track softer than upcoming path
        const edgeFade = Math.max(0.18, 1 - Math.abs(pt.timeOffsetSec) / (50 * 60));
        const timeAlpha = isFuture ? 0.92 : 0.42;
        const sunlitScale = pt.isSunlit ? 1.0 : 0.55;
        alphas[idx] = edgeFade * timeAlpha * sunlitScale;
      };

      writeVertexStyle(v0, a);
      writeVertexStyle(v1, b);
      vertexCount += 2;
    }

    if (vertexCount === 0) {
      line.visible = false;
      geometry.setDrawRange(0, 0);
      return;
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    geometry.setDrawRange(0, vertexCount);
    line.visible = true;
  };

  return {
    line,
    updateArc,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Creates the WebGPU/WebGL2 instanced satellite marker + orbital trajectory arc layer.
 */
export function createSatelliteLayer(): SatelliteLayer {
  const group = new THREE.Group();
  group.name = 'SatelliteGroup';

  const basePlane = new THREE.PlaneGeometry(2, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = basePlane.index;
  geometry.setAttribute('position', basePlane.getAttribute('position'));
  geometry.instanceCount = 0;
  basePlane.dispose();

  const worldDirData = new Float32Array(MAX_SATELLITES * 3);
  // [vmag, isStation (0|1), isSunlit (0|1), isHighlighted (0|1)]
  const metaData = new Float32Array(MAX_SATELLITES * 4);
  const colorData = new Float32Array(MAX_SATELLITES * 3);

  const dirAttr = new THREE.InstancedBufferAttribute(worldDirData, 3);
  dirAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.InstancedBufferAttribute(metaData, 4);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(colorData, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('aSatWorldDir', dirAttr);
  geometry.setAttribute('aSatMeta', metaAttr);
  geometry.setAttribute('aSatColor', colorAttr);

  const uTime = uniform(0);
  const uFovDeg = uniform(72);
  const uViewport = uniform(new THREE.Vector2(1280, 720));
  const uPixelRatio = uniform(1);

  const aSatWorldDir = attribute('aSatWorldDir', 'vec3');
  const aSatMeta = attribute('aSatMeta', 'vec4');
  const aSatColor = attribute('aSatColor', 'vec3');

  const vQuadUv = varying(positionGeometry.xy, 'vSatQuadUv');
  const vSatMeta = varying(aSatMeta, 'vSatMeta');
  const vSatColor = varying(aSatColor, 'vSatColor');
  const vSatVisibility = varying(
    smoothstep(float(-0.015), float(0.025), normalize(aSatWorldDir).y),
    'vSatVisibility',
  );

  const vertexNode = Fn(() => {
    const isStation = aSatMeta.y;
    const isHighlighted = aSatMeta.w;
    const worldDir = normalize(aSatWorldDir);
    const worldPos = worldDir.mul(SAT_SPHERE_RADIUS);
    const centerClip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));

    const zoomBoost = mix(
      float(1.0),
      float(1.55),
      float(1.0).sub(smoothstep(float(10.0), float(95.0), uFovDeg)),
    );
    const baseRadius = select(
      isStation.greaterThan(0.5),
      float(17.5),
      select(isHighlighted.greaterThan(0.5), float(14.5), float(11.5)),
    );
    const radiusPx = clamp(baseRadius.mul(zoomBoost), float(10.0), float(28.0));

    const isVisible = worldDir.y.greaterThan(-0.02).and(centerClip.w.greaterThan(0.0));
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
    const isSunlit = vSatMeta.z;
    const coreMix = exp(r.mul(r).mul(-24.0));
    const sunlitTint = mix(vSatColor, vec3(1.0, 1.0, 1.0), coreMix.mul(0.75));
    const eclipsedTint = mix(vec3(0.45, 0.52, 0.65), vec3(0.82, 0.88, 0.96), coreMix.mul(0.5));
    return select(isSunlit.greaterThan(0.5), sunlitTint, eclipsedTint);
  })();

  const fragmentOpacityNode = Fn(() => {
    const uv = vQuadUv;
    const r = length(uv);
    const isStation = vSatMeta.y;
    const isSunlit = vSatMeta.z;
    const isHighlighted = vSatMeta.w;

    const pulse = sin(uTime.mul(3.1)).mul(0.5).add(0.5);

    // Space Station H-solar-array silhouette + outer orbital ring
    const truss = float(1.0)
      .sub(smoothstep(float(0.03), float(0.085), abs(uv.y)))
      .mul(float(1.0).sub(smoothstep(float(0.36), float(0.44), abs(uv.x))));
    const solarLeft = float(1.0)
      .sub(smoothstep(float(0.03), float(0.09), abs(uv.x.add(0.32))))
      .mul(float(1.0).sub(smoothstep(float(0.36), float(0.45), abs(uv.y))));
    const solarRight = float(1.0)
      .sub(smoothstep(float(0.03), float(0.09), abs(uv.x.sub(0.32))))
      .mul(float(1.0).sub(smoothstep(float(0.36), float(0.45), abs(uv.y))));
    const stationRing = float(1.0)
      .sub(smoothstep(float(0.025), float(0.095), abs(r.sub(0.76))))
      .mul(mix(float(0.5), float(0.95), pulse));
    const stationCore = exp(r.mul(r).mul(-22.0)).mul(0.85);
    const stationMask = clamp(
      truss.add(solarLeft).add(solarRight).add(stationRing).add(stationCore),
      float(0.0),
      float(1.0),
    );

    // Visual satellite 4-point diamond contour + pinpoint beacon
    const diamond = abs(uv.x).add(abs(uv.y));
    const diamondEdge = float(1.0).sub(smoothstep(float(0.03), float(0.11), abs(diamond.sub(0.48))));
    const satCore = exp(r.mul(r).mul(-28.0)).mul(0.9);
    const highlightRing = float(1.0)
      .sub(smoothstep(float(0.025), float(0.09), abs(r.sub(0.72))))
      .mul(isHighlighted)
      .mul(mix(float(0.45), float(0.9), pulse));
    const satMask = clamp(diamondEdge.add(satCore).add(highlightRing), float(0.0), float(1.0));

    const shapeMask = select(isStation.greaterThan(0.5), stationMask, satMask);
    const radialCut = float(1.0).sub(smoothstep(float(0.88), float(1.0), r));
    const sunlitOpacity = mix(float(0.48), float(0.96), isSunlit);

    return clamp(shapeMask.mul(vSatVisibility).mul(radialCut).mul(sunlitOpacity), float(0.0), float(1.0));
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

  const markersMesh = new THREE.Mesh(geometry, material);
  markersMesh.name = 'Satellites';
  markersMesh.frustumCulled = false;
  markersMesh.renderOrder = 4;
  markersMesh.visible = false;

  const issArcLine = createOrbitArcLine('ISSOrbitArc', 3);
  const selectedArcLine = createOrbitArcLine('SelectedSatOrbitArc', 3);

  group.add(issArcLine.line);
  group.add(selectedArcLine.line);
  group.add(markersMesh);

  const tempColor = new THREE.Color();
  const tempProjected = new THREE.Vector3();

  return {
    group,
    update({
      satellites,
      issArc,
      selectedArc,
      selectedNoradId,
      elapsedSec,
      fovDeg,
      viewportWidth,
      viewportHeight,
      pixelRatio,
      visible,
    }) {
      group.visible = visible;
      if (!visible) return;

      const count = Math.min(satellites.length, MAX_SATELLITES);
      geometry.instanceCount = count;
      markersMesh.visible = count > 0;

      for (let i = 0; i < count; i++) {
        const sat = satellites[i];
        const vIdx = i * 3;
        worldDirData[vIdx] = sat.worldDir[0];
        worldDirData[vIdx + 1] = sat.worldDir[1];
        worldDirData[vIdx + 2] = sat.worldDir[2];

        tempColor.set(sat.colorHex);
        colorData[vIdx] = tempColor.r;
        colorData[vIdx + 1] = tempColor.g;
        colorData[vIdx + 2] = tempColor.b;

        const mIdx = i * 4;
        metaData[mIdx] = sat.vmag;
        metaData[mIdx + 1] = sat.category === 'Space Station' ? 1.0 : 0.0;
        metaData[mIdx + 2] = sat.isSunlit ? 1.0 : 0.0;
        metaData[mIdx + 3] =
          sat.noradId === selectedNoradId || sat.noradId === ISS_NORAD_ID ? 1.0 : 0.0;
      }

      if (count > 0) {
        dirAttr.needsUpdate = true;
        metaAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
      }

      uTime.value = elapsedSec;
      uFovDeg.value = fovDeg;
      uViewport.value.set(
        Math.max(1, viewportWidth * pixelRatio),
        Math.max(1, viewportHeight * pixelRatio),
      );
      uPixelRatio.value = pixelRatio;

      issArcLine.updateArc(issArc, '#38bdf8', true);

      const selectedSat =
        selectedNoradId && selectedNoradId !== ISS_NORAD_ID
          ? satellites.find((s) => s.noradId === selectedNoradId)
          : undefined;
      selectedArcLine.updateArc(
        selectedArc,
        selectedSat?.colorHex ?? '#a78bfa',
        Boolean(selectedSat && selectedArc.length >= 2),
      );
    },

    collectVisibleLabels(
      camera,
      satellites,
      selectedNoradId,
      viewportWidth,
      viewportHeight,
      fovDeg,
    ) {
      if (!group.visible) return [];

      const labels: ScreenLabelItem[] = [];
      for (const sat of satellites) {
        if (sat.altDeg < -0.5) continue;

        const isIss = sat.noradId === ISS_NORAD_ID;
        const isSelected = sat.noradId === selectedNoradId;
        if (!isIss && !isSelected && !sat.isSunlit && fovDeg >= 60) {
          continue;
        }

        tempProjected
          .set(
            sat.worldDir[0] * SAT_SPHERE_RADIUS,
            sat.worldDir[1] * SAT_SPHERE_RADIUS,
            sat.worldDir[2] * SAT_SPHERE_RADIUS,
          )
          .project(camera);

        if (tempProjected.z > 1 || tempProjected.z < -1) continue;

        const sx = (tempProjected.x * 0.5 + 0.5) * viewportWidth;
        const sy = (-tempProjected.y * 0.5 + 0.5) * viewportHeight;
        if (sx < 8 || sx > viewportWidth - 8 || sy < 8 || sy > viewportHeight - 8) continue;

        const statusTag = sat.isSunlit ? '' : ' (Eclipsed)';
        labels.push({
          id: sat.id,
          text: `${sat.shortName}${isIss ? ' · ISS' : ''}${statusTag}`,
          kind: 'satellite',
          x: sx + 14,
          y: sy - 10,
          priority: isIss ? 92 : isSelected ? 90 : 76 - sat.vmag,
        });
      }

      return labels;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      issArcLine.dispose();
      selectedArcLine.dispose();
    },
  };
}
