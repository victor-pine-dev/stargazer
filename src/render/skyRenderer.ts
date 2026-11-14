import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  computeEquatorialToWorldMatrix4,
  computeLocalApparentSiderealTimeRad,
  computeSunPosition,
  DEG_TO_RAD,
  type SunTelemetry,
} from '../astro/coordinates';
import type { LoadedCelestialData } from '../data/catalogLoader';
import type { ObserverLocation } from '../services/locationService';
import { createAtmosphereDome } from './atmosphereDome';
import { createCompassHorizon } from './compassHorizon';
import { createConstellationLayer, type ScreenLabelItem } from './constellationLayer';
import { createStarfieldLayer } from './starfieldLayer';

export interface LayerVisibilityState {
  constellations: boolean;
  boundaries: boolean;
  labels: boolean;
  atmosphere: boolean;
  horizon: boolean;
}

export type TimeMode = 'live' | 'tonight' | 'sunset';

export interface TelemetrySnapshot {
  backendLabel: 'WebGPU · WGSL' | 'WebGL2 Fallback';
  starCount: number;
  fps: number;
  azDeg: number;
  altDeg: number;
  fovDeg: number;
  lastRad: number;
  sun: SunTelemetry;
  observedDate: Date;
  timeMode: TimeMode;
  labels: ScreenLabelItem[];
}

export interface SkyEngineOptions {
  canvas: HTMLCanvasElement;
  catalog: LoadedCelestialData;
  initialLocation: ObserverLocation;
  onTelemetry: (snapshot: TelemetrySnapshot) => void;
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
  if (mode === 'live') return now;

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
  private readonly onTelemetry: (snapshot: TelemetrySnapshot) => void;

  private readonly atmosphere: ReturnType<typeof createAtmosphereDome>;
  private readonly starfield: ReturnType<typeof createStarfieldLayer>;
  private readonly constellations: ReturnType<typeof createConstellationLayer>;
  private readonly horizon: ReturnType<typeof createCompassHorizon>;

  private location: ObserverLocation;
  private timeMode: TimeMode = 'live';
  private layers: LayerVisibilityState = {
    constellations: true,
    boundaries: false,
    labels: true,
    atmosphere: true,
    horizon: true,
  };

  private backendLabel: TelemetrySnapshot['backendLabel'] = 'WebGPU · WGSL';

  // Camera look state (Azimuth 0=N, 90=E, 180=S, 270=W; Altitude [-85, +89.9]; FOV [10, 120])
  private azDeg = 180;
  private altDeg = 32;
  private fovDeg = 72;
  private targetAzDeg = 180;
  private targetAltDeg = 32;
  private targetFovDeg = 72;

  private readonly eqToWorld = new THREE.Matrix4();
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
    this.location = options.initialLocation;
    this.onTelemetry = options.onTelemetry;

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
    this.constellations = createConstellationLayer(
      options.catalog.constellations,
      options.catalog.namedStarList,
    );
    this.horizon = createCompassHorizon();

    this.scene.add(this.atmosphere.mesh);
    this.scene.add(this.starfield.mesh);
    this.scene.add(this.constellations.group);
    this.scene.add(this.horizon.group);

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

  setLocation(loc: ObserverLocation): void {
    this.location = loc;
  }

  setTimeMode(mode: TimeMode): void {
    this.timeMode = mode;
  }

  setLayers(next: Partial<LayerVisibilityState>): void {
    this.layers = { ...this.layers, ...next };
  }

  getLayers(): LayerVisibilityState {
    return { ...this.layers };
  }

  lookAt(azDeg: number, altDeg: number): void {
    this.targetAzDeg = normalizeDeg360(azDeg);
    this.targetAltDeg = Math.max(-80, Math.min(89.5, altDeg));
  }

  zoomBy(deltaFovDeg: number): void {
    this.targetFovDeg = Math.max(10, Math.min(120, this.targetFovDeg + deltaFovDeg));
  }

  setFov(fovDeg: number): void {
    this.targetFovDeg = Math.max(10, Math.min(120, fovDeg));
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
    this.canvas.classList.add('is-dragging');
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.activePointers.get(e.pointerId);
    if (!prev) return;

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

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

    // Scale pan speed proportionally to current FOV so zoomed-in panning stays precise
    const degPerPx = this.fovDeg / Math.max(320, this.viewportHeight);
    const cosAlt = Math.max(0.25, Math.cos(this.altDeg * DEG_TO_RAD));

    this.targetAzDeg = normalizeDeg360(this.targetAzDeg - (dx * degPerPx) / cosAlt);
    this.targetAltDeg = Math.max(-80, Math.min(89.5, this.targetAltDeg + dy * degPerPx));
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDistance = null;
    }
    if (this.activePointers.size === 0) {
      this.canvas.classList.remove('is-dragging');
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

      // Smooth damped camera tracking
      const smooth = 1 - Math.exp(-14 * dtSec);
      const azDiff = shortestAngleDeltaDeg(this.azDeg, this.targetAzDeg);
      this.azDeg = normalizeDeg360(this.azDeg + azDiff * smooth);
      this.altDeg += (this.targetAltDeg - this.altDeg) * smooth;
      this.fovDeg += (this.targetFovDeg - this.fovDeg) * smooth;

      if (Math.abs(this.camera.fov - this.fovDeg) > 0.01) {
        this.camera.fov = this.fovDeg;
        this.camera.updateProjectionMatrix();
      }

      this.camera.rotation.y = -this.azDeg * DEG_TO_RAD;
      this.camera.rotation.x = this.altDeg * DEG_TO_RAD;
      this.camera.rotation.z = 0;
      this.camera.updateMatrixWorld();

      // Astronomical state for current observer location & time
      const observedDate = computePresetDate(new Date(), this.location.longitude, this.timeMode);
      const lastRad = computeLocalApparentSiderealTimeRad(observedDate, this.location.longitude);
      computeEquatorialToWorldMatrix4(
        observedDate,
        this.location.latitude,
        this.location.longitude,
        this.eqToWorld,
      );
      const sun = computeSunPosition(
        observedDate,
        this.location.latitude,
        this.location.longitude,
        this.location.elevation,
      );

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
        const skyLabels = this.constellations.collectVisibleLabels(
          this.camera,
          this.eqToWorld,
          this.viewportWidth,
          this.viewportHeight,
          this.fovDeg,
        );
        const compassLabels = this.horizon.collectCompassLabels(
          this.camera,
          this.viewportWidth,
          this.viewportHeight,
        );

        this.onTelemetry({
          backendLabel: this.backendLabel,
          starCount: this.starfield.starCount,
          fps: this.currentFps,
          azDeg: this.azDeg,
          altDeg: this.altDeg,
          fovDeg: this.fovDeg,
          lastRad,
          sun,
          observedDate,
          timeMode: this.timeMode,
          labels: [...compassLabels, ...skyLabels],
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
    this.constellations.dispose();
    this.horizon.dispose();
    this.renderer.dispose();
  }
}
