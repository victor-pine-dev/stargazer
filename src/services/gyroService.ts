import * as THREE from 'three';
import { slerpHorizontalLook } from '../astro/celestialIndex';
import { DEG_TO_RAD, RAD_TO_DEG } from '../astro/coordinates';

export type GyroSensorStatus =
  | 'off'
  | 'requesting'
  | 'active'
  | 'simulated'
  | 'denied'
  | 'unsupported';

export interface SkyLookAngles {
  azDeg: number;
  altDeg: number;
  rollDeg: number;
}

export interface GyroControllerState {
  status: GyroSensorStatus;
  azDeg: number;
  altDeg: number;
  compassOffsetDeg: number;
  hasAbsoluteHeading: boolean;
  statusMessage: string;
}

interface ExtendedDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface DeviceOrientationStaticWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const ZEE = new THREE.Vector3(0, 0, 1);
const Q_ENU_TO_THREE = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

const tempEuler = new THREE.Euler(0, 0, 0, 'ZXY');
const tempQDev = new THREE.Quaternion();
const tempQScreen = new THREE.Quaternion();
const tempQWorld = new THREE.Quaternion();
const tempForward = new THREE.Vector3();
const tempUp = new THREE.Vector3();
const tempRight = new THREE.Vector3();
const tempWorldUp = new THREE.Vector3(0, 1, 0);
const tempHorizonUp = new THREE.Vector3();

function normalizeDeg360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function normalizeSigned180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function getScreenOrientationAngleDeg(): number {
  if (typeof window === 'undefined') return 0;
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === 'number' && Number.isFinite(angle)) {
    return angle;
  }
  const legacyOrientation = (window as unknown as { orientation?: number }).orientation;
  return typeof legacyOrientation === 'number' && Number.isFinite(legacyOrientation)
    ? legacyOrientation
    : 0;
}

/**
 * Converts W3C DeviceOrientation Euler angles (alpha, beta, gamma) plus screen rotation,
 * optional iOS webkitCompassHeading, and manual compass trim offset into Three.js horizontal
 * sky look angles (Azimuth 0=N..270=W, Altitude [-80, +89.5]) using ZXY quaternion fusion.
 */
export function deviceOrientationToSkyLook(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenOrientationDeg = 0,
  webkitCompassHeading: number | null = null,
  compassOffsetDeg = 0,
): SkyLookAngles {
  const useCompassHeading =
    typeof webkitCompassHeading === 'number' && Number.isFinite(webkitCompassHeading);
  const alphaUsed = useCompassHeading
    ? 360 - webkitCompassHeading + screenOrientationDeg
    : alphaDeg;

  tempEuler.set(
    betaDeg * DEG_TO_RAD,
    gammaDeg * DEG_TO_RAD,
    alphaUsed * DEG_TO_RAD,
    'ZXY',
  );
  tempQDev.setFromEuler(tempEuler);
  tempQScreen.setFromAxisAngle(ZEE, -screenOrientationDeg * DEG_TO_RAD);
  tempQDev.multiply(tempQScreen);

  tempQWorld.copy(Q_ENU_TO_THREE).multiply(tempQDev);

  // Rear camera looks along local -Z
  tempForward.set(0, 0, -1).applyQuaternion(tempQWorld).normalize();
  tempUp.set(0, 1, 0).applyQuaternion(tempQWorld).normalize();

  const rawAltDeg = Math.asin(Math.max(-1, Math.min(1, tempForward.y))) * RAD_TO_DEG;
  const altDeg = Math.max(-80, Math.min(89.5, rawAltDeg));
  const rawAzDeg = normalizeDeg360(Math.atan2(tempForward.x, -tempForward.z) * RAD_TO_DEG);
  const azDeg = normalizeDeg360(rawAzDeg + compassOffsetDeg);

  // Compute camera roll relative to local horizon
  tempRight.crossVectors(tempForward, tempWorldUp);
  let rollDeg = 0;
  if (tempRight.lengthSq() > 1e-6) {
    tempRight.normalize();
    tempHorizonUp.crossVectors(tempRight, tempForward).normalize();
    const cosRoll = Math.max(-1, Math.min(1, tempUp.dot(tempHorizonUp)));
    const sinRoll = tempUp.dot(tempRight);
    rollDeg = Math.atan2(sinRoll, cosRoll) * RAD_TO_DEG;
  }

  return { azDeg, altDeg, rollDeg };
}

/**
 * Manages DeviceOrientation permission handshakes, live compass fusion,
 * low-pass spherical smoothing, and desktop simulated fallback mode.
 */
export class GyroSensorController {
  private status: GyroSensorStatus = 'off';
  private rawTargetAzDeg = 180;
  private rawTargetAltDeg = 32;
  private smoothedAzDeg = 180;
  private smoothedAltDeg = 32;
  private compassOffsetDeg = 0;
  private hasAbsoluteHeading = false;
  private statusMessage = 'AR Gyro inactive';
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private hasHardwareSample = false;
  private readonly onStateChange?: (state: GyroControllerState) => void;

  constructor(onStateChange?: (state: GyroControllerState) => void) {
    this.onStateChange = onStateChange;
  }

  private emitState(): void {
    this.onStateChange?.(this.getState());
  }

  private handleOrientationEvent = (event: Event): void => {
    const ev = event as ExtendedDeviceOrientationEvent;
    if (
      typeof ev.alpha !== 'number' ||
      typeof ev.beta !== 'number' ||
      typeof ev.gamma !== 'number' ||
      !Number.isFinite(ev.alpha) ||
      !Number.isFinite(ev.beta) ||
      !Number.isFinite(ev.gamma)
    ) {
      return;
    }

    const screenDeg = getScreenOrientationAngleDeg();
    const compassHeading =
      typeof ev.webkitCompassHeading === 'number' && Number.isFinite(ev.webkitCompassHeading)
        ? ev.webkitCompassHeading
        : null;

    const isAbsolute = event.type === 'deviceorientationabsolute' || ev.absolute === true || compassHeading !== null;
    this.hasAbsoluteHeading = isAbsolute;

    const look = deviceOrientationToSkyLook(
      ev.alpha,
      ev.beta,
      ev.gamma,
      screenDeg,
      compassHeading,
      this.compassOffsetDeg,
    );

    if (!this.hasHardwareSample) {
      this.hasHardwareSample = true;
      if (this.fallbackTimer) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
      this.smoothedAzDeg = look.azDeg;
      this.smoothedAltDeg = look.altDeg;
    }

    this.rawTargetAzDeg = look.azDeg;
    this.rawTargetAltDeg = look.altDeg;
    if (this.status !== 'active') {
      this.status = 'active';
      this.statusMessage = isAbsolute
        ? 'LIVE GYRO · Absolute compass lock'
        : 'LIVE GYRO · Relative IMU (trim North if needed)';
      this.emitState();
    }
  };

  async requestAndStart(initialAzDeg = 180, initialAltDeg = 32): Promise<GyroSensorStatus> {
    this.stop();

    this.rawTargetAzDeg = normalizeDeg360(initialAzDeg);
    this.rawTargetAltDeg = Math.max(-80, Math.min(89.5, initialAltDeg));
    this.smoothedAzDeg = this.rawTargetAzDeg;
    this.smoothedAltDeg = this.rawTargetAltDeg;
    this.hasHardwareSample = false;
    this.hasAbsoluteHeading = false;

    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      this.status = 'simulated';
      this.statusMessage = 'SIMULATED SENSOR · Drag or trim compass to align';
      this.emitState();
      return this.status;
    }

    const DeviceOrientCtor = window.DeviceOrientationEvent as unknown as DeviceOrientationStaticWithPermission;
    if (typeof DeviceOrientCtor?.requestPermission === 'function') {
      this.status = 'requesting';
      this.statusMessage = 'Requesting iOS Motion & Orientation access…';
      this.emitState();
      try {
        const permission = await DeviceOrientCtor.requestPermission();
        if (permission !== 'granted') {
          this.status = 'denied';
          this.statusMessage = 'Motion sensor permission denied in browser settings.';
          this.emitState();
          return this.status;
        }
      } catch {
        this.status = 'denied';
        this.statusMessage = 'Unable to acquire iOS DeviceOrientation permission.';
        this.emitState();
        return this.status;
      }
    }

    this.status = 'requesting';
    this.statusMessage = 'Listening for gyroscope & magnetometer telemetry…';
    this.emitState();

    window.addEventListener('deviceorientationabsolute', this.handleOrientationEvent);
    window.addEventListener('deviceorientation', this.handleOrientationEvent);

    // Gracefully enter calibrated simulated mode on desktop devices with no IMU stream
    this.fallbackTimer = setTimeout(() => {
      if (!this.hasHardwareSample && this.status === 'requesting') {
        this.status = 'simulated';
        this.statusMessage = 'SIMULATED SENSOR · No hardware IMU detected (drag/trim enabled)';
        this.emitState();
      }
    }, 800);

    return this.status;
  }

  getSmoothedLook(dtSec: number): { azDeg: number; altDeg: number } | null {
    if (this.status !== 'active' && this.status !== 'simulated') {
      return null;
    }

    const alpha = 1 - Math.exp(-16 * Math.max(0.001, dtSec));
    const interpolated = slerpHorizontalLook(
      this.smoothedAzDeg,
      this.smoothedAltDeg,
      this.rawTargetAzDeg,
      this.rawTargetAltDeg,
      alpha,
    );
    this.smoothedAzDeg = interpolated.azDeg;
    this.smoothedAltDeg = interpolated.altDeg;
    return interpolated;
  }

  adjustCompassOffset(deltaDeg: number): void {
    this.compassOffsetDeg = normalizeSigned180(this.compassOffsetDeg + deltaDeg);
    this.rawTargetAzDeg = normalizeDeg360(this.rawTargetAzDeg + deltaDeg);
    this.smoothedAzDeg = normalizeDeg360(this.smoothedAzDeg + deltaDeg);
    this.emitState();
  }

  adjustSimulatedPitch(deltaDeg: number): void {
    if (this.status !== 'simulated') return;
    this.rawTargetAltDeg = Math.max(-80, Math.min(89.5, this.rawTargetAltDeg + deltaDeg));
    this.emitState();
  }

  resetCalibration(): void {
    const revert = -this.compassOffsetDeg;
    this.compassOffsetDeg = 0;
    if (this.status === 'simulated') {
      this.rawTargetAzDeg = normalizeDeg360(this.rawTargetAzDeg + revert);
      this.smoothedAzDeg = normalizeDeg360(this.smoothedAzDeg + revert);
    }
    this.emitState();
  }

  getState(): GyroControllerState {
    return {
      status: this.status,
      azDeg: this.smoothedAzDeg,
      altDeg: this.smoothedAltDeg,
      compassOffsetDeg: this.compassOffsetDeg,
      hasAbsoluteHeading: this.hasAbsoluteHeading,
      statusMessage: this.statusMessage,
    };
  }

  isEnabled(): boolean {
    return this.status === 'active' || this.status === 'simulated' || this.status === 'requesting';
  }

  stop(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('deviceorientationabsolute', this.handleOrientationEvent);
      window.removeEventListener('deviceorientation', this.handleOrientationEvent);
    }
    this.status = 'off';
    this.hasHardwareSample = false;
    this.hasAbsoluteHeading = false;
    this.statusMessage = 'AR Gyro inactive';
    this.emitState();
  }
}
