import { azimuthToCardinal, formatHMS } from '../astro/coordinates';
import type { ScreenLabelItem } from '../render/constellationLayer';
import type { LayerVisibilityState, SkyEngine, TelemetrySnapshot, TimeMode } from '../render/skyRenderer';
import {
  detectGpsLocation,
  saveObserverLocation,
  searchPresetLocations,
  type ObserverLocation,
} from '../services/locationService';

/**
 * Installs fallback polyfills and light-dismiss support strictly when native browser APIs are missing.
 */
function ensureModernDialogSupport(locationDialog: HTMLDialogElement): void {
  // Conditional invokers-polyfill for browsers lacking HTMLButtonElement.prototype.commandForElement
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    void import('invokers-polyfill');
  }

  // Fallback for browsers without <dialog closedby="any"> support (e.g. Safari)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = locationDialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    locationDialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e);
    });
    locationDialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e)) {
        locationDialog.close();
      }
      pressedOutside = false;
    });
  }
}

function formatCoordsSummary(loc: ObserverLocation): string {
  const latHem = loc.latitude >= 0 ? 'N' : 'S';
  const lonHem = loc.longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(loc.latitude).toFixed(2)}°${latHem}, ${Math.abs(loc.longitude).toFixed(2)}°${lonHem} · ${Math.round(loc.elevation)}m`;
}

export class HudController {
  private readonly engine: SkyEngine;
  private currentLocation: ObserverLocation;

  private readonly gpuBadge: HTMLElement;
  private readonly starCountLabel: HTMLElement;
  private readonly fpsLabel: HTMLElement;
  private readonly locationNameEl: HTMLElement;
  private readonly locationSourceBadge: HTMLElement;
  private readonly locationCoordsEl: HTMLElement;
  private readonly clockReadout: HTMLElement;
  private readonly lastReadout: HTMLElement;
  private readonly sunReadout: HTMLElement;
  private readonly azReadout: HTMLElement;
  private readonly altReadout: HTMLElement;
  private readonly fovReadout: HTMLElement;
  private readonly labelsLayer: HTMLElement;

  private readonly locationDialog: HTMLDialogElement;
  private readonly locationSearchInput: HTMLInputElement;
  private readonly presetListEl: HTMLUListElement;
  private readonly gpsDetectBtn: HTMLButtonElement;
  private readonly gpsStatusMsg: HTMLElement;
  private readonly customCoordsForm: HTMLFormElement;
  private readonly customNameInput: HTMLInputElement;
  private readonly customLatInput: HTMLInputElement;
  private readonly customLonInput: HTMLInputElement;
  private readonly customElevInput: HTMLInputElement;

  private readonly labelPool = new Map<string, HTMLSpanElement>();

  constructor(engine: SkyEngine, initialLocation: ObserverLocation) {
    this.engine = engine;
    this.currentLocation = initialLocation;

    this.gpuBadge = document.getElementById('gpu-badge')!;
    this.starCountLabel = document.getElementById('star-count-label')!;
    this.fpsLabel = document.getElementById('fps-label')!;
    this.locationNameEl = document.getElementById('location-name')!;
    this.locationSourceBadge = document.getElementById('location-source-badge')!;
    this.locationCoordsEl = document.getElementById('location-coords')!;
    this.clockReadout = document.getElementById('clock-readout')!;
    this.lastReadout = document.getElementById('last-readout')!;
    this.sunReadout = document.getElementById('sun-readout')!;
    this.azReadout = document.getElementById('az-readout')!;
    this.altReadout = document.getElementById('alt-readout')!;
    this.fovReadout = document.getElementById('fov-readout')!;
    this.labelsLayer = document.getElementById('sky-labels-layer')!;

    this.locationDialog = document.getElementById('location-dialog') as HTMLDialogElement;
    this.locationSearchInput = document.getElementById('location-search-input') as HTMLInputElement;
    this.presetListEl = document.getElementById('location-preset-list') as HTMLUListElement;
    this.gpsDetectBtn = document.getElementById('gps-detect-btn') as HTMLButtonElement;
    this.gpsStatusMsg = document.getElementById('gps-status-msg')!;
    this.customCoordsForm = document.getElementById('custom-coords-form') as HTMLFormElement;
    this.customNameInput = document.getElementById('custom-name') as HTMLInputElement;
    this.customLatInput = document.getElementById('custom-lat') as HTMLInputElement;
    this.customLonInput = document.getElementById('custom-lon') as HTMLInputElement;
    this.customElevInput = document.getElementById('custom-elev') as HTMLInputElement;

    ensureModernDialogSupport(this.locationDialog);
    this.renderLocationHeader(initialLocation);
    this.syncCustomFormInputs(initialLocation);
    this.renderPresetList('');
    this.bindUiEvents();
  }

  applyLocation(location: ObserverLocation): void {
    this.currentLocation = location;
    saveObserverLocation(location);
    this.engine.setLocation(location);
    this.renderLocationHeader(location);
    this.syncCustomFormInputs(location);
  }

  private renderLocationHeader(loc: ObserverLocation): void {
    this.locationNameEl.textContent = loc.name;
    this.locationSourceBadge.textContent = loc.source.toUpperCase();
    this.locationCoordsEl.textContent = formatCoordsSummary(loc);
  }

  private syncCustomFormInputs(loc: ObserverLocation): void {
    this.customNameInput.value = loc.name;
    this.customLatInput.value = loc.latitude.toFixed(4);
    this.customLonInput.value = loc.longitude.toFixed(4);
    this.customElevInput.value = String(Math.round(loc.elevation));
  }

  private renderPresetList(query: string): void {
    const matches = searchPresetLocations(query);
    this.presetListEl.textContent = '';

    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'preset-item-btn';
      empty.textContent = 'No matching cities or observatories found.';
      this.presetListEl.appendChild(empty);
      return;
    }

    for (const loc of matches) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-item-btn';
      btn.setAttribute('role', 'option');
      btn.setAttribute(
        'aria-selected',
        String(loc.name === this.currentLocation.name),
      );

      const left = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'preset-item-title';
      title.textContent = loc.name;
      const region = document.createElement('span');
      region.className = 'preset-item-region';
      region.textContent = loc.region;
      left.append(title, region);

      const right = document.createElement('span');
      right.className = 'preset-item-coords';
      right.textContent = `${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°`;

      btn.append(left, right);
      btn.addEventListener('click', () => {
        this.applyLocation(loc);
        this.locationDialog.close('preset');
      });

      li.appendChild(btn);
      this.presetListEl.appendChild(li);
    }
  }

  private bindUiEvents(): void {
    // Layer toggle buttons
    document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.layer as keyof LayerVisibilityState | undefined;
        if (!key) return;
        const current = this.engine.getLayers();
        const nextVal = !current[key];
        this.engine.setLayers({ [key]: nextVal });
        btn.classList.toggle('is-active', nextVal);
        btn.setAttribute('aria-pressed', String(nextVal));
      });
    });

    // Quick compass / zenith look buttons
    document.querySelectorAll<HTMLButtonElement>('[data-look-az]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const az = Number(btn.dataset.lookAz ?? 0);
        const alt = Number(btn.dataset.lookAlt ?? 25);
        this.engine.lookAt(az, alt);
      });
    });

    // Time mode switcher (Live Now / Sunset / Tonight 22:30)
    const timeModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-time-mode]');
    timeModeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.timeMode as TimeMode | undefined;
        if (!mode) return;
        this.engine.setTimeMode(mode);
        timeModeButtons.forEach((other) => other.classList.toggle('is-active', other === btn));
      });
    });

    // Zoom buttons
    document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.engine.zoomBy(-12));
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.engine.zoomBy(12));

    // Search presets
    this.locationSearchInput.addEventListener('input', () => {
      this.renderPresetList(this.locationSearchInput.value);
    });

    // GPS detection inside modal
    this.gpsDetectBtn.addEventListener('click', async () => {
      this.gpsDetectBtn.disabled = true;
      this.gpsStatusMsg.textContent = 'Requesting browser GPS coordinates…';
      try {
        const loc = await detectGpsLocation();
        this.applyLocation(loc);
        this.gpsStatusMsg.textContent = `Locked: ${loc.name}`;
        this.locationDialog.close('gps');
      } catch (err) {
        this.gpsStatusMsg.textContent = err instanceof Error ? err.message : 'GPS detection failed.';
      } finally {
        this.gpsDetectBtn.disabled = false;
      }
    });

    // Custom coordinate submission
    this.customCoordsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const lat = Number(this.customLatInput.value);
      const lon = Number(this.customLonInput.value);
      const elev = Number(this.customElevInput.value) || 0;
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        this.gpsStatusMsg.textContent = 'Latitude must be [-90, 90] and Longitude [-180, 180].';
        return;
      }
      const name = this.customNameInput.value.trim() || 'Custom Site';
      this.applyLocation({
        name,
        region: 'Custom Coordinates',
        latitude: Number(lat.toFixed(4)),
        longitude: Number(lon.toFixed(4)),
        elevation: Math.round(elev),
        source: 'custom',
      });
      this.locationDialog.close('custom');
    });

    // Reset returnValue cleanly on dialog close per modern-web-guidance
    this.locationDialog.addEventListener('close', () => {
      this.locationDialog.returnValue = '';
    });
  }

  updateTelemetry(snapshot: TelemetrySnapshot): void {
    this.gpuBadge.textContent = snapshot.backendLabel;
    this.starCountLabel.textContent = `${snapshot.starCount.toLocaleString()} stars`;
    this.fpsLabel.textContent = `${snapshot.fps} FPS`;

    const utcStr = snapshot.observedDate.toISOString().slice(11, 19);
    const localStr = snapshot.observedDate.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    this.clockReadout.textContent = snapshot.timeMode === 'live'
      ? `${localStr} (${utcStr} UTC)`
      : `${utcStr} UTC (${snapshot.timeMode.toUpperCase()})`;

    this.lastReadout.textContent = formatHMS(snapshot.lastRad, true);
    this.sunReadout.textContent = `${snapshot.sun.twilightPhase} (${snapshot.sun.altDeg >= 0 ? '+' : ''}${snapshot.sun.altDeg.toFixed(1)}°)`;

    const cardinal = azimuthToCardinal(snapshot.azDeg);
    this.azReadout.textContent = `${snapshot.azDeg.toFixed(1)}° ${cardinal}`;
    this.altReadout.textContent = `${snapshot.altDeg >= 0 ? '+' : ''}${snapshot.altDeg.toFixed(1)}°`;
    this.fovReadout.textContent = `${Math.round(snapshot.fovDeg)}°`;

    this.renderProjectedLabels(snapshot.labels);
  }

  private renderProjectedLabels(items: ScreenLabelItem[]): void {
    const activeIds = new Set<string>();

    for (const item of items) {
      activeIds.add(item.id);
      let el = this.labelPool.get(item.id);
      if (!el) {
        el = document.createElement('span');
        el.className = `sky-label sky-label-${item.kind}`;
        el.textContent = item.text;
        this.labelsLayer.appendChild(el);
        this.labelPool.set(item.id, el);
      }
      el.style.left = `${item.x.toFixed(1)}px`;
      el.style.top = `${item.y.toFixed(1)}px`;
    }

    for (const [id, el] of this.labelPool.entries()) {
      if (!activeIds.has(id)) {
        el.remove();
        this.labelPool.delete(id);
      }
    }
  }
}
