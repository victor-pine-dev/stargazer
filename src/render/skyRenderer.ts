import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  buildTonightsBestTour,
  computeObjectTelemetry,
  searchCelestialCatalog,
  slerpHorizontalLook,
  type CelestialObjectKind,
  type CelestialObjectRef,
  type InspectedObjectTelemetry,
  type SearchResultItem,
  type TourStopItem,
} from '../astro/celestialIndex';
import {
  classifyTwilight,
  computeEquatorialToWorldMatrix4,
  computeLocalApparentSiderealTimeRad,
  DEG_TO_RAD,
  raDecToJ2000UnitVector,
  type SunTelemetry,
} from '../astro/coordinates';
import {
  computeSolarSystemEphemeris,
  type MoonEphemerisState,
  type SolarSystemBodyState,
  type SolarSystemEphemeris,
} from '../astro/solarSystem';
import type { LoadedCelestialData } from '../data/catalogLoader';
import type { ObserverLocation } from '../services/locationService';
import { createAtmosphereDome } from './atmosphereDome';
import { createCompassHorizon } from './compassHorizon';
import { createConstellationLayer, type ScreenLabelItem } from './constellationLayer';
import { createDsoLayer } from './dsoLayer';
import { createSolarSystemLayer } from './solarSystemLayer';
import { createStarfieldLayer } from './starfieldLayer';

export interface LayerVisibilityState {
  constellations: boolean;
  boundaries: boolean;
  labels: boolean;
  atmosphere: boolean;
  horizon: boolean;
  planets: boolean;
  dso: boolean;
}

export type TimeMode = 'live' | 'tonight' | 'sunset' | 'custom';

export interface ReticleScreenPosition {
  x: number;
  y: number;
  visible: boolean;
}

export interface TelemetrySnapshot {
  backendLabel: 'WebGPU · WGSL' | 'WebGL2 Fallback';
  starCount: number;
  dsoCount: number;
  fps: number;
  azDeg: number;
  altDeg: number;
  fovDeg: number;
  lastRad: number;
  sun: SunTelemetry;
  moon: MoonEphemerisState;
  planets: SolarSystemBodyState[];
  observedDate: Date;
  timeMode: TimeMode;
  isPlaying: boolean;
  timeWarpMultiplier: number;
  labels: ScreenLabelItem[];
  selectedObject: InspectedObjectTelemetry | null;
  selectedReticle: ReticleScreenPosition | null;
  isTrackingObject: boolean;
}

export interface SkyEngineOptions {
  canvas: HTMLCanvasElement;
  catalog: LoadedCelestialData;
  initialLocation: ObserverLocation;
  onTelemetry: (snapshot: TelemetrySnapshot) => void;
  onSelectObject?: (telemetry: InspectedObjectTelemetry | null) => void;
}

function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/**
 * Computes a local wall-clock solar time preset (e.g. 22:00 tonight or sunset golden hour)
 * relative to the observer's longitude timezone offset so night/twilight sky can be previewed anytime.
 */
function computePresetDate(now: Date, longitudeDeg: number, mode: TimeMode): Date {
  if (mode === 'live' || mode === 'custom') return now;

  // Approximate local solar hour offset from UTC using longitude / 15
  const approxOffsetHours = Math.round(longitudeDeg / 15);
  const targetLocalHour = mode === 'tonight' ? 22.5 : 18.2;
  const targetUtcHour = ((targetLocalHour - approxOffsetHours) % 24 + 24) % 24;

  const preset = new Date(now.getTime());
  const hours = Math.floor(targetUtcHour);
  const minutes = Math.floor((targetUtcHour - hours) * 60);
  preset.setUTCHours(hours, minutes, 0, 0);
  return preset;
}

export class SkyEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGPURenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly catalog: LoadedCelestialData;
  private readonly onTelemetry: (snapshot: TelemetrySnapshot) => void;
  private readonly onSelectObject?: (telemetry: InspectedObjectTelemetry | null) => void;

  private readonly atmosphere: ReturnType<typeof createAtmosphereDome>;
  private readonly starfield: ReturnType<typeof createStarfieldLayer>;
  private readonly dso: ReturnType<typeof createDsoLayer>;
  private readonly solarSystem: ReturnType<typeof createSolarSystemLayer>;
  private readonly constellations: ReturnType<typeof createConstellationLayer>;
  private readonly horizon: ReturnType<typeof createCompassHorizon>;

  private readonly dsoPickAnchors: Array<{ id: string; mag: number; j2000Vec: THREE.Vector3 }>;

  private location: ObserverLocation;
  private timeMode: TimeMode = 'live';
  private simTimestampMs = Date.now();
  private isPlaying = true;
  private timeWarpMultiplier = 1;
  private lastEphemeris: SolarSystemEphemeris;

  private layers: LayerVisibilityState = {
    constellations: true,
    boundaries: false,
    labels: true,
    atmosphere: true,
    horizon: true,
    planets: true,
    dso: true,
  };

  private backendLabel: TelemetrySnapshot['backendLabel'] = 'WebGPU · WGSL';

  // Camera look state (Azimuth 0=N, 90=E, 180=S, 270=W; Altitude [-85, +89.9]; FOV [10, 120])
  private azDeg = 180;
  private altDeg = 32;
  private fovDeg = 72;
  private targetAzDeg = 180;
  private targetAltDeg = 32;
  private targetFovDeg = 72;

  // Quaternion slerp Fly-To transition state
  private slerpActive = false;
  private slerpElapsedSec = 0;
  private readonly slerpDurationSec = 0.85;
  private slerpStartAzDeg = 180;
  private slerpStartAltDeg = 32;

  // Object inspection & tracking state
  private selectedRef: CelestialObjectRef | null = null;
  private isTrackingObject = false;

  private readonly eqToWorld = new THREE.Matrix4();
  private readonly tempPickWorld = new THREE.Vector3();
  private readonly tempPickProj = new THREE.Vector3();
  private readonly tempInvEq = new THREE.Matrix4();
  private readonly tempRayJ2000 = new THREE.Vector3();
  private rafId = 0;
  private disposed = false;
  private startPerfMs = performance.now();
  private lastFramePerfMs = performance.now();
  private fpsAccumFrames = 0;
  private fpsAccumSec = 0;
  private currentFps = 60;
  private lastHudPushMs = 0;

  // Pointer & touch gesture tracking
  private activePointers = new Map<number, { x: number; y: number }>();
  private pointerDownStart: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  private lastPinchDistance: number | null = null;
  private viewportWidth = 1280;
  private viewportHeight = 720;

  private constructor(
    options: SkyEngineOptions,
    renderer: WebGPURenderer,
    backendLabel: TelemetrySnapshot['backendLabel'],
  ) {
    this.canvas = options.canvas;
    this.renderer = renderer;
    this.backendLabel = backendLabel;
    this.catalog = options.catalog;
    this.location = options.initialLocation;
    this.onTelemetry = options.onTelemetry;
    this.onSelectObject = options.onSelectObject;

    this.dsoPickAnchors = options.catalog.dsos.map((d) => {
      const [x, y, z] = raDecToJ2000UnitVector(d.raRad, d.decRad);
      return {
        id: d.id,
        mag: d.mag,
        j2000Vec: new THREE.Vector3(x, y, z),
      };
    });

    this.scene = new THREE.Scene();
    this.viewportWidth = this.canvas.clientWidth || window.innerWidth;
    this.viewportHeight = this.canvas.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(
      this.fovDeg,
      this.viewportWidth / Math.max(1, this.viewportHeight),
      0.1,
      2000,
    );
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';

    this.atmosphere = createAtmosphereDome();
    this.starfield = createStarfieldLayer(options.catalog.stars);
    this.dso = createDsoLayer(options.catalog.dsos);
    this.solarSystem = createSolarSystemLayer();
    this.constellations = createConstellationLayer(
      options.catalog.constellations,
      options.catalog.namedStarList,
    );
    this.horizon = createCompassHorizon();

    this.scene.add(this.atmosphere.mesh);
    this.scene.add(this.starfield.mesh);
    this.scene.add(this.dso.mesh);
    this.scene.add(this.solarSystem.group);
    this.scene.add(this.constellations.group);
    this.scene.add(this.horizon.group);

    this.lastEphemeris = computeSolarSystemEphemeris(
      new Date(this.simTimestampMs),
      this.location.latitude,
      this.location.longitude,
      this.location.elevation,
    );
    this.refreshAstroState();

    this.handleResize();
    this.bindEvents();
    this.startLoop();
  }

  static async create(options: SkyEngineOptions): Promise<SkyEngine> {
    const renderer = new WebGPURenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    await renderer.init();

    const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    const backendLabel: TelemetrySnapshot['backendLabel'] = backend?.isWebGPUBackend
      ? 'WebGPU · WGSL'
      : 'WebGL2 Fallback';

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return new SkyEngine(options, renderer, backendLabel);
  }

  private refreshAstroState(): Date {
    const observedDate = new Date(this.simTimestampMs);
    computeEquatorialToWorldMatrix4(
      observedDate,
      this.location.latitude,
      this.location.longitude,
      this.eqToWorld,
    );
    this.lastEphemeris = computeSolarSystemEphemeris(
      observedDate,
      this.location.latitude,
      this.location.longitude,
      this.location.elevation,
    );
    return observedDate;
  }

  setLocation(loc: ObserverLocation): void {
    this.location = loc;
    this.refreshAstroState();
    this.lastHudPushMs = 0;
  }

  getCurrentLocation(): ObserverLocation {
    return this.location;
  }

  setTimeMode(mode: TimeMode): void {
    if (mode === 'live') {
      this.resetToNow();
      return;
    }
    this.timeMode = mode;
    if (mode === 'sunset' || mode === 'tonight') {
      this.simTimestampMs = computePresetDate(new Date(), this.location.longitude, mode).getTime();
    }
    this.refreshAstroState();
    this.lastHudPushMs = 0;
  }

  setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    if (!playing && this.timeMode === 'live') {
      this.timeMode = 'custom';
    }
    this.lastHudPushMs = 0;
  }

  togglePlaying(): boolean {
    this.setPlaying(!this.isPlaying);
    return this.isPlaying;
  }

  setTimeWarp(multiplier: number): void {
    this.timeWarpMultiplier = multiplier;
    if (multiplier !== 1 && this.timeMode === 'live') {
      this.timeMode = 'custom';
    }
    if (!this.isPlaying) {
      this.isPlaying = true;
    }
    this.lastHudPushMs = 0;
  }

  setObservedDate(date: Date, mode: TimeMode = 'custom'): void {
    const ms = date.getTime();
    if (!Number.isFinite(ms)) return;
    this.simTimestampMs = ms;
    this.timeMode = mode;
    this.refreshAstroState();
    this.lastHudPushMs = 0;
  }

  setLocalDayMinutes(minutesOfDay: number): void {
    const clamped = Math.max(0, Math.min(1439, Math.round(minutesOfDay)));
    const nextDate = new Date(this.simTimestampMs);
    nextDate.setHours(Math.floor(clamped / 60), clamped % 60, 0, 0);
    this.simTimestampMs = nextDate.getTime();
    this.timeMode = 'custom';
    this.refreshAstroState();
    this.lastHudPushMs = 0;
  }

  resetToNow(): void {
    this.timeMode = 'live';
    this.isPlaying = true;
    this.timeWarpMultiplier = 1;
    this.simTimestampMs = Date.now();
    this.refreshAstroState();
    this.lastHudPushMs = 0;
  }

  setLayers(next: Partial<LayerVisibilityState>): void {
    this.layers = { ...this.layers, ...next };
  }

  getLayers(): LayerVisibilityState {
    return { ...this.layers };
  }

  lookAt(azDeg: number, altDeg: number): void {
    this.slerpActive = false;
    this.isTrackingObject = false;
    this.targetAzDeg = normalizeDeg360(azDeg);
    this.targetAltDeg = Math.max(-80, Math.min(89.5, altDeg));
  }

  flyTo(azDeg: number, altDeg: number, fovDeg?: number): void {
    this.slerpStartAzDeg = this.azDeg;
    this.slerpStartAltDeg = this.altDeg;
    this.targetAzDeg = normalizeDeg360(azDeg);
    this.targetAltDeg = Math.max(-80, Math.min(89.5, altDeg));
    this.slerpElapsedSec = 0;
    this.slerpActive = true;
    if (fovDeg !== undefined) {
      this.setFov(fovDeg);
    }
  }

  zoomBy(deltaFovDeg: number): void {
    this.targetFovDeg = Math.max(10, Math.min(120, this.targetFovDeg + deltaFovDeg));
  }

  setFov(fovDeg: number): void {
    this.targetFovDeg = Math.max(10, Math.min(120, fovDeg));
  }

  selectObject(
    ref: CelestialObjectRef | null,
    options?: { flyTo?: boolean; track?: boolean; fovDeg?: number },
  ): InspectedObjectTelemetry | null {
    this.selectedRef = ref;
    this.isTrackingObject = Boolean(options?.track && ref);

    const observedDate = new Date(this.simTimestampMs);
    const telemetry = ref
      ? computeObjectTelemetry(
          ref,
          this.catalog,
          this.lastEphemeris,
          this.eqToWorld,
          observedDate,
          this.location,
        )
      : null;

    if (!telemetry) {
      this.selectedRef = null;
      this.isTrackingObject = false;
      this.onSelectObject?.(null);
      this.lastHudPushMs = 0;
      return null;
    }

    if (options?.flyTo) {
      this.flyTo(telemetry.azDeg, telemetry.altDeg, options.fovDeg ?? telemetry.recommendedFovDeg);
    }

    this.onSelectObject?.(telemetry);
    this.lastHudPushMs = 0;
    return telemetry;
  }

  setTrackingObject(track: boolean): void {
    this.isTrackingObject = Boolean(track && this.selectedRef);
    this.lastHudPushMs = 0;
  }

  centerSelectedObject(targetFovDeg?: number): void {
    if (!this.selectedRef) return;
    const telemetry = computeObjectTelemetry(
      this.selectedRef,
      this.catalog,
      this.lastEphemeris,
      this.eqToWorld,
      new Date(this.simTimestampMs),
      this.location,
    );
    if (!telemetry) return;
    this.isTrackingObject = true;
    this.flyTo(telemetry.azDeg, telemetry.altDeg, targetFovDeg ?? telemetry.recommendedFovDeg);
    this.lastHudPushMs = 0;
  }

  searchObjects(query: string, filter: CelestialObjectKind | 'all' = 'all'): SearchResultItem[] {
    return searchCelestialCatalog(
      query,
      filter,
      this.catalog,
      this.lastEphemeris,
      this.eqToWorld,
    );
  }

  getTonightsBestTour(): { stops: TourStopItem[]; evalDate: Date; isDaylightPreview: boolean } {
    return buildTonightsBestTour(this.catalog, this.location, new Date(this.simTimestampMs));
  }

  private projectWorldDirToReticle(worldDir: [number, number, number]): ReticleScreenPosition {
    this.tempPickProj.set(worldDir[0] * 450, worldDir[1] * 450, worldDir[2] * 450).project(this.camera);
    if (this.tempPickProj.z < -1 || this.tempPickProj.z > 1) {
      return { x: -100, y: -100, visible: false };
    }
    const x = (this.tempPickProj.x * 0.5 + 0.5) * this.viewportWidth;
    const y = (-this.tempPickProj.y * 0.5 + 0.5) * this.viewportHeight;
    const visible = x >= -24 && x <= this.viewportWidth + 24 && y >= -24 && y <= this.viewportHeight + 24;
    return { x, y, visible };
  }

  private pickObjectAtScreenPoint(screenX: number, screenY: number): CelestialObjectRef | null {
    this.camera.updateMatrixWorld();

    let bestRef: CelestialObjectRef | null = null;
    let bestRankScore = Infinity;

    const smoothstepVal = (edge0: number, edge1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };

    // 1. Check Solar System bodies (Moon, Sun, Mercury-Neptune)
    if (this.layers.planets) {
      const candidates = [this.lastEphemeris.moon, this.lastEphemeris.sun, ...this.lastEphemeris.planets];
      for (const body of candidates) {
        if (body.altDeg < -0.8) continue;
        const radius = body.id === 'moon' ? 448 : 450;
        this.tempPickProj
          .set(body.worldDir[0] * radius, body.worldDir[1] * radius, body.worldDir[2] * radius)
          .project(this.camera);
        if (this.tempPickProj.z < -1 || this.tempPickProj.z > 1) continue;

        const sx = (this.tempPickProj.x * 0.5 + 0.5) * this.viewportWidth;
        const sy = (-this.tempPickProj.y * 0.5 + 0.5) * this.viewportHeight;
        const distPx = Math.hypot(sx - screenX, sy - screenY);
        const tZoom = Math.max(0, Math.min(1, (72 - this.fovDeg) / 62));
        const hitRadius =
          body.id === 'moon'
            ? Math.max(26, 14 + tZoom * 40 + 8)
            : body.id === 'sun'
              ? 38
              : 26;

        if (distPx <= hitRadius) {
          const score = distPx - 10;
          if (score < bestRankScore) {
            bestRankScore = score;
            bestRef = { id: `body-${body.id}`, kind: 'planet', bodyId: body.id };
          }
        }
      }
    }

    // 2. Check visible Deep Sky Objects
    const dsoDaylightBlocked = this.layers.atmosphere && this.lastEphemeris.sun.altDeg > -2.5;
    if (this.layers.dso && !dsoDaylightBlocked) {
      const dsoZoomNorm = 1 - smoothstepVal(12, 88, this.fovDeg);
      const dsoMagLimit = 6.4 + (12.5 - 6.4) * dsoZoomNorm + 0.5;
      for (const anchor of this.dsoPickAnchors) {
        if (anchor.mag > dsoMagLimit) break;
        this.tempPickWorld.copy(anchor.j2000Vec).applyMatrix4(this.eqToWorld);
        if (this.tempPickWorld.y < -0.02) continue;

        this.tempPickProj.copy(this.tempPickWorld).multiplyScalar(452).project(this.camera);
        if (this.tempPickProj.z < -1 || this.tempPickProj.z > 1) continue;

        const sx = (this.tempPickProj.x * 0.5 + 0.5) * this.viewportWidth;
        const sy = (-this.tempPickProj.y * 0.5 + 0.5) * this.viewportHeight;
        const distPx = Math.hypot(sx - screenX, sy - screenY);
        if (distPx <= 26) {
          const score = distPx - 4 + Math.max(0, anchor.mag - 4) * 0.4;
          if (score < bestRankScore) {
            bestRankScore = score;
            bestRef = { id: `dso-${anchor.id}`, kind: 'dso', dsoId: anchor.id };
          }
        }
      }
    }

    // 3. Unproject screen ray into J2000 space and query catalog stars
    const ndcX = (screenX / Math.max(1, this.viewportWidth)) * 2 - 1;
    const ndcY = -(screenY / Math.max(1, this.viewportHeight)) * 2 + 1;
    this.tempPickProj.set(ndcX, ndcY, 0.5).unproject(this.camera).normalize();
    this.tempInvEq.copy(this.eqToWorld).transpose();
    this.tempRayJ2000.copy(this.tempPickProj).applyMatrix4(this.tempInvEq).normalize();

    const radPerPx = (this.fovDeg * DEG_TO_RAD) / Math.max(1, this.viewportHeight);
    const maxAngleRad = Math.min(0.22, 28 * radPerPx);
    const minDot = Math.cos(maxAngleRad);

    const starZoomNorm = 1 - smoothstepVal(14, 95, this.fovDeg);
    const starMagLimit = 6.6 + (8.35 - 6.6) * starZoomNorm + 0.3;

    const { count, positionsJ2000, starMeta } = this.catalog.stars;
    const rx = this.tempRayJ2000.x;
    const ry = this.tempRayJ2000.y;
    const rz = this.tempRayJ2000.z;

    for (let i = 0; i < count; i++) {
      const mIdx = i * 4;
      const vmag = starMeta[mIdx];
      if (vmag > starMagLimit) break;

      const pIdx = i * 3;
      const dot = positionsJ2000[pIdx] * rx + positionsJ2000[pIdx + 1] * ry + positionsJ2000[pIdx + 2] * rz;
      if (dot < minDot) continue;

      this.tempPickWorld
        .set(positionsJ2000[pIdx], positionsJ2000[pIdx + 1], positionsJ2000[pIdx + 2])
        .applyMatrix4(this.eqToWorld);
      if (this.tempPickWorld.y < -0.015) continue;

      this.tempPickProj.copy(this.tempPickWorld).multiplyScalar(460).project(this.camera);
      if (this.tempPickProj.z < -1 || this.tempPickProj.z > 1) continue;

      const sx = (this.tempPickProj.x * 0.5 + 0.5) * this.viewportWidth;
      const sy = (-this.tempPickProj.y * 0.5 + 0.5) * this.viewportHeight;
      const distPx = Math.hypot(sx - screenX, sy - screenY);

      if (distPx <= 26) {
        const hip = Math.round(starMeta[mIdx + 3]);
        const namedBonus = hip > 0 && this.catalog.starNames.has(hip) ? -2.5 : 0;
        const score = distPx + Math.max(0, vmag) * 1.15 + namedBonus;
        if (score < bestRankScore) {
          bestRankScore = score;
          bestRef = {
            id: hip > 0 ? `star-${hip}` : `star-idx-${i}`,
            kind: 'star',
            starIndex: i,
            hip: hip > 0 ? hip : undefined,
          };
        }
      }
    }

    return bestRef;
  }

  private handleResize = (): void => {
    this.viewportWidth = this.canvas.clientWidth || window.innerWidth;
    this.viewportHeight = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);

    this.camera.aspect = this.viewportWidth / Math.max(1, this.viewportHeight);
    this.camera.updateProjectionMatrix();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.activePointers.size === 1) {
      this.pointerDownStart = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: false,
      };
    } else if (this.pointerDownStart) {
      this.pointerDownStart.moved = true;
    }
    this.canvas.classList.add('is-dragging');
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.activePointers.get(e.pointerId);
    if (!prev) return;

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointerDownStart && this.pointerDownStart.pointerId === e.pointerId) {
      const totalDrag = Math.hypot(
        e.clientX - this.pointerDownStart.x,
        e.clientY - this.pointerDownStart.y,
      );
      if (totalDrag > 5) {
        this.pointerDownStart.moved = true;
        this.slerpActive = false;
        this.isTrackingObject = false;
      }
    }

    if (this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (this.lastPinchDistance !== null && dist > 10) {
        const scale = this.lastPinchDistance / dist;
        this.targetFovDeg = Math.max(10, Math.min(120, this.targetFovDeg * scale));
      }
      this.lastPinchDistance = dist;
      return;
    }

    this.lastPinchDistance = null;

    if (this.pointerDownStart && !this.pointerDownStart.moved) {
      return;
    }

    // Scale pan speed proportionally to current FOV so zoomed-in panning stays precise
    const degPerPx = this.fovDeg / Math.max(320, this.viewportHeight);
    const cosAlt = Math.max(0.25, Math.cos(this.altDeg * DEG_TO_RAD));

    this.targetAzDeg = normalizeDeg360(this.targetAzDeg - (dx * degPerPx) / cosAlt);
    this.targetAltDeg = Math.max(-80, Math.min(89.5, this.targetAltDeg + dy * degPerPx));
  };

  private onPointerUp = (e: PointerEvent): void => {
    const wasTap =
      this.pointerDownStart !== null &&
      this.pointerDownStart.pointerId === e.pointerId &&
      !this.pointerDownStart.moved &&
      e.type === 'pointerup' &&
      this.activePointers.size === 1;

    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDistance = null;
    }
    if (this.activePointers.size === 0) {
      this.canvas.classList.remove('is-dragging');
      this.pointerDownStart = null;
    }

    if (wasTap) {
      const rect = this.canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const hit = this.pickObjectAtScreenPoint(localX, localY);
      if (hit) {
        this.selectObject(hit, { flyTo: false, track: false });
      } else if (this.selectedRef) {
        this.selectObject(null);
      }
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const zoomStep = (e.deltaY / 120) * Math.max(2.5, this.targetFovDeg * 0.08);
    this.targetFovDeg = Math.max(10, Math.min(120, this.targetFovDeg + zoomStep));
  };

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private getTrackedAltAz(
    ref: CelestialObjectRef,
    ephemeris: SolarSystemEphemeris,
  ): { azDeg: number; altDeg: number } | null {
    if (ref.kind === 'planet' && ref.bodyId) {
      const b =
        ref.bodyId === 'sun'
          ? ephemeris.sun
          : ref.bodyId === 'moon'
            ? ephemeris.moon
            : ephemeris.planets.find((p) => p.id === ref.bodyId);
      return b ? { azDeg: b.azDeg, altDeg: b.altDeg } : null;
    }
    if (ref.kind === 'star' && typeof ref.starIndex === 'number') {
      const pIdx = ref.starIndex * 3;
      this.tempPickWorld
        .set(
          this.catalog.stars.positionsJ2000[pIdx],
          this.catalog.stars.positionsJ2000[pIdx + 1],
          this.catalog.stars.positionsJ2000[pIdx + 2],
        )
        .applyMatrix4(this.eqToWorld)
        .normalize();
      const len = this.tempPickWorld.length() || 1;
      const ny = Math.max(-1, Math.min(1, this.tempPickWorld.y / len));
      const altDeg = (Math.asin(ny) * 180) / Math.PI;
      const azDeg = (((Math.atan2(this.tempPickWorld.x, -this.tempPickWorld.z) * 180) / Math.PI) % 360 + 360) % 360;
      return { azDeg, altDeg };
    }
    if (ref.kind === 'dso' && ref.dsoId) {
      const anchor = this.dsoPickAnchors.find((d) => d.id === ref.dsoId);
      if (!anchor) return null;
      this.tempPickWorld.copy(anchor.j2000Vec).applyMatrix4(this.eqToWorld).normalize();
      const ny = Math.max(-1, Math.min(1, this.tempPickWorld.y));
      const altDeg = (Math.asin(ny) * 180) / Math.PI;
      const azDeg = (((Math.atan2(this.tempPickWorld.x, -this.tempPickWorld.z) * 180) / Math.PI) % 360 + 360) % 360;
      return { azDeg, altDeg };
    }
    if (ref.kind === 'constellation' && ref.constellationId) {
      const c = this.catalog.constellations.find((item) => item.id === ref.constellationId);
      if (!c) return null;
      const [vx, vy, vz] = raDecToJ2000UnitVector(c.labelRaRad, c.labelDecRad);
      this.tempPickWorld.set(vx, vy, vz).applyMatrix4(this.eqToWorld).normalize();
      const ny = Math.max(-1, Math.min(1, this.tempPickWorld.y));
      const altDeg = (Math.asin(ny) * 180) / Math.PI;
      const azDeg = (((Math.atan2(this.tempPickWorld.x, -this.tempPickWorld.z) * 180) / Math.PI) % 360 + 360) % 360;
      return { azDeg, altDeg };
    }
    return null;
  }

  private startLoop(): void {
    const tick = (nowMs: number) => {
      if (this.disposed) return;

      const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - this.lastFramePerfMs) / 1000));
      this.lastFramePerfMs = nowMs;

      this.fpsAccumFrames += 1;
      this.fpsAccumSec += dtSec;
      if (this.fpsAccumSec >= 0.5) {
        this.currentFps = Math.round(this.fpsAccumFrames / this.fpsAccumSec);
        this.fpsAccumFrames = 0;
        this.fpsAccumSec = 0;
      }

      // Advance simulated Time Machine clock
      if (this.timeMode === 'live' && this.isPlaying && this.timeWarpMultiplier === 1) {
        this.simTimestampMs = Date.now();
      } else if (this.isPlaying) {
        this.simTimestampMs += dtSec * 1000 * this.timeWarpMultiplier;
      }

      const observedDate = this.refreshAstroState();
      const lastRad = computeLocalApparentSiderealTimeRad(observedDate, this.location.longitude);
      const ephemeris = this.lastEphemeris;
      const sun: SunTelemetry = {
        altDeg: ephemeris.sun.altDeg,
        azDeg: ephemeris.sun.azDeg,
        raRad: ephemeris.sun.raRad,
        decRad: ephemeris.sun.decRad,
        worldDir: ephemeris.sun.worldDir,
        twilightPhase: classifyTwilight(ephemeris.sun.altDeg),
      };

      // Update tracked target coordinates continuously during time playback/warp
      if (this.isTrackingObject && this.selectedRef) {
        const tracked = this.getTrackedAltAz(this.selectedRef, ephemeris);
        if (tracked) {
          this.targetAzDeg = normalizeDeg360(tracked.azDeg);
          this.targetAltDeg = Math.max(-80, Math.min(89.5, tracked.altDeg));
        }
      }

      // Smooth quaternion slerp Fly-To or damped camera tracking
      const smooth = 1 - Math.exp(-14 * dtSec);
      if (this.slerpActive) {
        this.slerpElapsedSec += dtSec;
        const u = Math.min(1, this.slerpElapsedSec / this.slerpDurationSec);
        const eased = 1 - Math.pow(1 - u, 3);
        const slerped = slerpHorizontalLook(
          this.slerpStartAzDeg,
          this.slerpStartAltDeg,
          this.targetAzDeg,
          this.targetAltDeg,
          eased,
        );
        this.azDeg = slerped.azDeg;
        this.altDeg = slerped.altDeg;
        if (u >= 1) {
          this.slerpActive = false;
        }
      } else {
        const azDiff = shortestAngleDeltaDeg(this.azDeg, this.targetAzDeg);
        this.azDeg = normalizeDeg360(this.azDeg + azDiff * smooth);
        this.altDeg += (this.targetAltDeg - this.altDeg) * smooth;
      }
      this.fovDeg += (this.targetFovDeg - this.fovDeg) * smooth;

      if (Math.abs(this.camera.fov - this.fovDeg) > 0.01) {
        this.camera.fov = this.fovDeg;
        this.camera.updateProjectionMatrix();
      }

      this.camera.rotation.y = -this.azDeg * DEG_TO_RAD;
      this.camera.rotation.x = this.altDeg * DEG_TO_RAD;
      this.camera.rotation.z = 0;
      this.camera.updateMatrixWorld();

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const elapsedSec = (nowMs - this.startPerfMs) / 1000;

      this.atmosphere.update(sun.worldDir, sun.altDeg, this.layers.atmosphere);
      this.starfield.update({
        eqToWorld: this.eqToWorld,
        elapsedSec,
        fovDeg: this.fovDeg,
        sunAltDeg: sun.altDeg,
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        pixelRatio: dpr,
        showAtmosphere: this.layers.atmosphere,
      });
      this.dso.update({
        eqToWorld: this.eqToWorld,
        fovDeg: this.fovDeg,
        sunAltDeg: sun.altDeg,
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        pixelRatio: dpr,
        showAtmosphere: this.layers.atmosphere,
        visible: this.layers.dso,
      });
      this.solarSystem.update({
        ephemeris,
        eqToWorld: this.eqToWorld,
        camera: this.camera,
        fovDeg: this.fovDeg,
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        pixelRatio: dpr,
        showAtmosphere: this.layers.atmosphere,
        visible: this.layers.planets,
      });
      this.constellations.setEqToWorldMatrix(this.eqToWorld);
      this.constellations.setVisibility({
        showLines: this.layers.constellations,
        showBounds: this.layers.boundaries,
        showLabels: this.layers.labels,
        sunAltDeg: sun.altDeg,
        showAtmosphere: this.layers.atmosphere,
      });
      this.horizon.setVisible(this.layers.horizon);

      this.renderer.render(this.scene, this.camera);

      // Update projected HTML labels & HUD telemetry at ~30 Hz for crisp motion with minimal DOM churn
      if (nowMs - this.lastHudPushMs >= 32) {
        this.lastHudPushMs = nowMs;
        const compassLabels = this.horizon.collectCompassLabels(
          this.camera,
          this.viewportWidth,
          this.viewportHeight,
        );

        let mergedSkyLabels: ScreenLabelItem[] = [];
        if (this.layers.labels) {
          const planetLabels = this.solarSystem.collectVisibleLabels(
            this.camera,
            ephemeris,
            this.viewportWidth,
            this.viewportHeight,
            this.fovDeg,
            this.layers.atmosphere,
          );
          const dsoLabels = this.dso.collectVisibleLabels(
            this.camera,
            this.eqToWorld,
            this.viewportWidth,
            this.viewportHeight,
            this.fovDeg,
            sun.altDeg,
            this.layers.atmosphere,
          );
          const constStarLabels = this.constellations.collectVisibleLabels(
            this.camera,
            this.eqToWorld,
            this.viewportWidth,
            this.viewportHeight,
            this.fovDeg,
          );

          const allSkyCandidates = [...planetLabels, ...constStarLabels, ...dsoLabels];
          allSkyCandidates.sort((a, b) => b.priority - a.priority);
          for (const item of allSkyCandidates) {
            const tooClose = mergedSkyLabels.some(
              (other) => Math.abs(other.x - item.x) < 76 && Math.abs(other.y - item.y) < 22,
            );
            if (!tooClose) {
              mergedSkyLabels.push(item);
            }
            if (mergedSkyLabels.length >= 72) break;
          }
        }

        const selectedObject = this.selectedRef
          ? computeObjectTelemetry(
              this.selectedRef,
              this.catalog,
              ephemeris,
              this.eqToWorld,
              observedDate,
              this.location,
            )
          : null;
        const selectedReticle = selectedObject
          ? this.projectWorldDirToReticle(selectedObject.worldDir)
          : null;

        this.onTelemetry({
          backendLabel: this.backendLabel,
          starCount: this.starfield.starCount,
          dsoCount: this.dso.dsoCount,
          fps: this.currentFps,
          azDeg: this.azDeg,
          altDeg: this.altDeg,
          fovDeg: this.fovDeg,
          lastRad,
          sun,
          moon: ephemeris.moon,
          planets: ephemeris.planets,
          observedDate,
          timeMode: this.timeMode,
          isPlaying: this.isPlaying,
          timeWarpMultiplier: this.timeWarpMultiplier,
          labels: [...compassLabels, ...mergedSkyLabels],
          selectedObject,
          selectedReticle,
          isTrackingObject: this.isTrackingObject,
        });
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);

    this.atmosphere.dispose();
    this.starfield.dispose();
    this.dso.dispose();
    this.solarSystem.dispose();
    this.constellations.dispose();
    this.horizon.dispose();
    this.renderer.dispose();
  }
}
