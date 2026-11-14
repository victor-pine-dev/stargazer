import type {
  CelestialObjectKind,
  InspectedObjectTelemetry,
  SearchResultItem,
  TourStopItem,
} from '../astro/celestialIndex';
import { azimuthToCardinal, formatHMS } from '../astro/coordinates';
import type { ScreenLabelItem } from '../render/constellationLayer';
import type {
  LayerVisibilityState,
  ReticleScreenPosition,
  SkyEngine,
  TelemetrySnapshot,
  TimeMode,
} from '../render/skyRenderer';
import {
  detectGpsLocation,
  saveObserverLocation,
  searchPresetLocations,
  type ObserverLocation,
} from '../services/locationService';

let invokerPolyfillChecked = false;

/**
 * Installs fallback polyfills and light-dismiss support strictly when native browser APIs are missing.
 */
function ensureModernDialogSupport(dialog: HTMLDialogElement): void {
  // Conditional invokers-polyfill for browsers lacking HTMLButtonElement.prototype.commandForElement
  if (!invokerPolyfillChecked) {
    invokerPolyfillChecked = true;
    if (!('commandForElement' in HTMLButtonElement.prototype)) {
      void import('invokers-polyfill');
    }
  }

  // Fallback for browsers without <dialog closedby="any"> support (e.g. Safari)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
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

function formatDateTimeLocalValue(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function formatMinutesHHMM(minutesOfDay: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutesOfDay)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function syncRangeSliderCssVars(slider: HTMLInputElement): void {
  slider.style.setProperty('--attr-min', slider.min || '0');
  slider.style.setProperty('--attr-max', slider.max || '1439');
  slider.style.setProperty('--control-value', slider.value);
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
  private readonly moonReadout: HTMLElement;
  private readonly azReadout: HTMLElement;
  private readonly altReadout: HTMLElement;
  private readonly fovReadout: HTMLElement;
  private readonly labelsLayer: HTMLElement;

  private readonly timePlayPauseBtn: HTMLButtonElement;
  private readonly timeNowBtn: HTMLButtonElement;
  private readonly timeScrubSlider: HTMLInputElement;
  private readonly timeScrubReadout: HTMLElement;
  private readonly timeDatetimeInput: HTMLInputElement;
  private readonly timeWarpButtons: NodeListOf<HTMLButtonElement>;
  private readonly timeModeButtons: NodeListOf<HTMLButtonElement>;
  private isScrubbingTime = false;

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

  // Phase 3: Search Dialog, Object Inspector & "Tonight's Best" Tour
  private readonly searchTriggerBtn: HTMLButtonElement;
  private readonly searchDialog: HTMLDialogElement;
  private readonly celestialSearchInput: HTMLInputElement;
  private readonly searchResultsEl: HTMLUListElement;
  private readonly searchFilterButtons: NodeListOf<HTMLButtonElement>;
  private activeSearchFilter: CelestialObjectKind | 'all' = 'all';
  private currentSearchResults: SearchResultItem[] = [];
  private highlightedSearchIndex = 0;

  private readonly skyReticle: HTMLElement;
  private readonly inspectCard: HTMLElement;
  private readonly inspectColorDot: HTMLElement;
  private readonly inspectBadge: HTMLElement;
  private readonly inspectHorizonBadge: HTMLElement;
  private readonly inspectTitle: HTMLElement;
  private readonly inspectSubtitle: HTMLElement;
  private readonly inspectCloseBtn: HTMLButtonElement;
  private readonly inspectTourBanner: HTMLElement;
  private readonly inspectTourStep: HTMLElement;
  private readonly inspectTourNote: HTMLElement;
  private readonly inspectTourPrevBtn: HTMLButtonElement;
  private readonly inspectTourNextBtn: HTMLButtonElement;
  private readonly inspectAltAz: HTMLElement;
  private readonly inspectRaDec: HTMLElement;
  private readonly inspectMag: HTMLElement;
  private readonly inspectDist: HTMLElement;
  private readonly inspectSpectral: HTMLElement;
  private readonly inspectRise: HTMLElement;
  private readonly inspectTransit: HTMLElement;
  private readonly inspectSet: HTMLElement;
  private readonly inspectAirmass: HTMLElement;
  private readonly inspectDescription: HTMLElement;
  private readonly inspectCenterBtn: HTMLButtonElement;
  private readonly inspectZoomBtn: HTMLButtonElement;

  private readonly tourToggleBtn: HTMLButtonElement;
  private readonly tourPanel: HTMLElement;
  private readonly tourCloseBtn: HTMLButtonElement;
  private readonly tourWindowLabel: HTMLElement;
  private readonly tourPrevBtn: HTMLButtonElement;
  private readonly tourNextBtn: HTMLButtonElement;
  private readonly tourStepReadout: HTMLElement;
  private readonly tourStopListEl: HTMLOListElement;
  private activeTourStops: TourStopItem[] = [];
  private activeTourIndex: number | null = null;
  private tourIsDaylightPreview = false;
  private lastSunAltDeg = -20;

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
    this.moonReadout = document.getElementById('moon-readout')!;
    this.azReadout = document.getElementById('az-readout')!;
    this.altReadout = document.getElementById('alt-readout')!;
    this.fovReadout = document.getElementById('fov-readout')!;
    this.labelsLayer = document.getElementById('sky-labels-layer')!;

    this.timePlayPauseBtn = document.getElementById('time-play-pause-btn') as HTMLButtonElement;
    this.timeNowBtn = document.getElementById('time-now-btn') as HTMLButtonElement;
    this.timeScrubSlider = document.getElementById('time-scrub-slider') as HTMLInputElement;
    this.timeScrubReadout = document.getElementById('time-scrub-readout')!;
    this.timeDatetimeInput = document.getElementById('time-datetime-input') as HTMLInputElement;
    this.timeWarpButtons = document.querySelectorAll<HTMLButtonElement>('[data-time-warp]');
    this.timeModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-time-mode]');

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

    this.searchTriggerBtn = document.getElementById('search-trigger-btn') as HTMLButtonElement;
    this.searchDialog = document.getElementById('search-dialog') as HTMLDialogElement;
    this.celestialSearchInput = document.getElementById('celestial-search-input') as HTMLInputElement;
    this.searchResultsEl = document.getElementById('celestial-search-results') as HTMLUListElement;
    this.searchFilterButtons = document.querySelectorAll<HTMLButtonElement>('[data-search-filter]');

    this.skyReticle = document.getElementById('sky-reticle')!;
    this.inspectCard = document.getElementById('inspect-card')!;
    this.inspectColorDot = document.getElementById('inspect-color-dot')!;
    this.inspectBadge = document.getElementById('inspect-badge')!;
    this.inspectHorizonBadge = document.getElementById('inspect-horizon-badge')!;
    this.inspectTitle = document.getElementById('inspect-title')!;
    this.inspectSubtitle = document.getElementById('inspect-subtitle')!;
    this.inspectCloseBtn = document.getElementById('inspect-close-btn') as HTMLButtonElement;
    this.inspectTourBanner = document.getElementById('inspect-tour-banner')!;
    this.inspectTourStep = document.getElementById('inspect-tour-step')!;
    this.inspectTourNote = document.getElementById('inspect-tour-note')!;
    this.inspectTourPrevBtn = document.getElementById('inspect-tour-prev') as HTMLButtonElement;
    this.inspectTourNextBtn = document.getElementById('inspect-tour-next') as HTMLButtonElement;
    this.inspectAltAz = document.getElementById('inspect-altaz')!;
    this.inspectRaDec = document.getElementById('inspect-radec')!;
    this.inspectMag = document.getElementById('inspect-mag')!;
    this.inspectDist = document.getElementById('inspect-dist')!;
    this.inspectSpectral = document.getElementById('inspect-spectral')!;
    this.inspectRise = document.getElementById('inspect-rise')!;
    this.inspectTransit = document.getElementById('inspect-transit')!;
    this.inspectSet = document.getElementById('inspect-set')!;
    this.inspectAirmass = document.getElementById('inspect-airmass')!;
    this.inspectDescription = document.getElementById('inspect-description')!;
    this.inspectCenterBtn = document.getElementById('inspect-center-btn') as HTMLButtonElement;
    this.inspectZoomBtn = document.getElementById('inspect-zoom-btn') as HTMLButtonElement;

    this.tourToggleBtn = document.getElementById('tour-toggle-btn') as HTMLButtonElement;
    this.tourPanel = document.getElementById('tour-panel')!;
    this.tourCloseBtn = document.getElementById('tour-close-btn') as HTMLButtonElement;
    this.tourWindowLabel = document.getElementById('tour-window-label')!;
    this.tourPrevBtn = document.getElementById('tour-prev-btn') as HTMLButtonElement;
    this.tourNextBtn = document.getElementById('tour-next-btn') as HTMLButtonElement;
    this.tourStepReadout = document.getElementById('tour-step-readout')!;
    this.tourStopListEl = document.getElementById('tour-stop-list') as HTMLOListElement;

    ensureModernDialogSupport(this.locationDialog);
    ensureModernDialogSupport(this.searchDialog);
    syncRangeSliderCssVars(this.timeScrubSlider);
    this.renderLocationHeader(initialLocation);
    this.syncCustomFormInputs(initialLocation);
    this.renderPresetList('');
    this.renderSearchResults();
    this.bindUiEvents();
  }

  applyLocation(location: ObserverLocation): void {
    this.currentLocation = location;
    saveObserverLocation(location);
    this.engine.setLocation(location);
    this.renderLocationHeader(location);
    this.syncCustomFormInputs(location);
    if (!this.tourPanel.hidden) {
      this.refreshTourStops();
    }
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
    this.timeModeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.timeMode as TimeMode | undefined;
        if (!mode) return;
        this.engine.setTimeMode(mode);
        this.timeModeButtons.forEach((other) => other.classList.toggle('is-active', other === btn));
      });
    });

    // Time Machine Play/Pause, Now, Scrub Slider, Time Warp, and Date/Time Picker
    this.timePlayPauseBtn.addEventListener('click', () => {
      const playing = this.engine.togglePlaying();
      this.timePlayPauseBtn.textContent = playing ? 'Pause' : 'Play';
      this.timePlayPauseBtn.classList.toggle('is-active', playing);
      this.timePlayPauseBtn.setAttribute('aria-label', playing ? 'Pause simulation' : 'Play simulation');
    });

    this.timeNowBtn.addEventListener('click', () => {
      this.engine.resetToNow();
    });

    const stopScrubbing = () => {
      this.isScrubbingTime = false;
    };
    this.timeScrubSlider.addEventListener('pointerdown', () => {
      this.isScrubbingTime = true;
    });
    this.timeScrubSlider.addEventListener('pointerup', stopScrubbing);
    this.timeScrubSlider.addEventListener('pointercancel', stopScrubbing);
    this.timeScrubSlider.addEventListener('blur', stopScrubbing);
    this.timeScrubSlider.addEventListener('input', () => {
      syncRangeSliderCssVars(this.timeScrubSlider);
      const minutes = Number(this.timeScrubSlider.value);
      const hhmm = formatMinutesHHMM(minutes);
      this.timeScrubReadout.textContent = hhmm;
      this.timeScrubSlider.setAttribute('aria-valuetext', `${hhmm} local time`);
      this.engine.setLocalDayMinutes(minutes);
    });

    this.timeWarpButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const warp = Number(btn.dataset.timeWarp ?? 1);
        this.engine.setTimeWarp(warp);
        this.timeWarpButtons.forEach((other) => other.classList.toggle('is-active', other === btn));
      });
    });

    this.timeDatetimeInput.addEventListener('change', () => {
      if (!this.timeDatetimeInput.value) return;
      const parsed = new Date(this.timeDatetimeInput.value);
      if (!Number.isNaN(parsed.getTime())) {
        this.engine.setObservedDate(parsed, 'custom');
      }
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

    this.searchDialog.addEventListener('close', () => {
      this.searchDialog.returnValue = '';
    });

    // Search trigger refresh before opening
    this.searchTriggerBtn.addEventListener('click', () => {
      this.highlightedSearchIndex = 0;
      this.renderSearchResults();
    });

    // Global Cmd/Ctrl+K shortcut to toggle Search Catalog palette
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (this.locationDialog.open) {
          this.locationDialog.close();
        }
        if (this.searchDialog.open) {
          this.searchDialog.close();
        } else {
          this.highlightedSearchIndex = 0;
          this.renderSearchResults();
          this.searchDialog.showModal();
          this.celestialSearchInput.focus();
          this.celestialSearchInput.select();
        }
      }
    });

    // Catalog Search filtering & keyboard navigation
    this.celestialSearchInput.addEventListener('input', () => {
      this.highlightedSearchIndex = 0;
      this.renderSearchResults();
    });

    this.celestialSearchInput.addEventListener('keydown', (e) => {
      const len = this.currentSearchResults.length;
      if (len === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.highlightedSearchIndex = (this.highlightedSearchIndex + 1) % len;
        this.syncSearchHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.highlightedSearchIndex = (this.highlightedSearchIndex - 1 + len) % len;
        this.syncSearchHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = this.currentSearchResults[this.highlightedSearchIndex];
        if (item) {
          this.selectFromSearch(item);
        }
      }
    });

    this.searchFilterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const filter = (btn.dataset.searchFilter as CelestialObjectKind | 'all' | undefined) ?? 'all';
        this.activeSearchFilter = filter;
        this.searchFilterButtons.forEach((other) => {
          const active = other === btn;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-pressed', String(active));
        });
        this.highlightedSearchIndex = 0;
        this.renderSearchResults();
        this.celestialSearchInput.focus();
      });
    });

    // Object Inspector actions
    this.inspectCloseBtn.addEventListener('click', () => {
      this.activeTourIndex = null;
      this.renderTourList();
      this.engine.selectObject(null);
    });

    this.inspectCenterBtn.addEventListener('click', () => {
      this.engine.centerSelectedObject();
    });

    this.inspectZoomBtn.addEventListener('click', () => {
      this.engine.centerSelectedObject(18);
    });

    // Tonight's Best Tour panel & stepping
    this.tourToggleBtn.addEventListener('click', () => {
      const opening = this.tourPanel.hidden;
      this.setTourPanelOpen(opening);
    });

    this.tourCloseBtn.addEventListener('click', () => {
      this.setTourPanelOpen(false);
    });

    const stepTour = (delta: number) => {
      if (this.activeTourStops.length === 0) {
        this.refreshTourStops();
      }
      if (this.activeTourStops.length === 0) return;
      const base = this.activeTourIndex ?? (delta > 0 ? -1 : 0);
      const nextIdx = (base + delta + this.activeTourStops.length) % this.activeTourStops.length;
      this.activateTourStep(nextIdx);
    };

    this.tourPrevBtn.addEventListener('click', () => stepTour(-1));
    this.tourNextBtn.addEventListener('click', () => stepTour(1));
    this.inspectTourPrevBtn.addEventListener('click', () => stepTour(-1));
    this.inspectTourNextBtn.addEventListener('click', () => stepTour(1));
  }

  private renderSearchResults(): void {
    const query = this.celestialSearchInput.value;
    this.currentSearchResults = this.engine.searchObjects(query, this.activeSearchFilter);
    this.searchResultsEl.textContent = '';

    if (this.currentSearchResults.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'preset-item-btn';
      empty.textContent = 'No matching stars, planets, DSOs, or constellations.';
      this.searchResultsEl.appendChild(empty);
      return;
    }

    if (this.highlightedSearchIndex >= this.currentSearchResults.length) {
      this.highlightedSearchIndex = 0;
    }

    this.currentSearchResults.forEach((item, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-item-btn';
      btn.classList.toggle('is-highlighted', idx === this.highlightedSearchIndex);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(idx === this.highlightedSearchIndex));

      const left = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'preset-item-title';
      title.textContent = item.name;
      const sub = document.createElement('span');
      sub.className = 'preset-item-region';
      sub.textContent = `${item.categoryBadge} · ${item.subtitle}`;
      left.append(title, sub);

      const right = document.createElement('span');
      right.className = 'search-result-right';
      const altBadge = document.createElement('span');
      altBadge.className = 'preset-item-coords';
      altBadge.textContent = item.isAboveHorizon
        ? `${item.altDeg.toFixed(0)}° ${item.azCardinal}`
        : `Below (${item.altDeg.toFixed(0)}°)`;
      const magSpan = document.createElement('span');
      magSpan.className = 'preset-item-region';
      magSpan.textContent = item.vmag !== null ? `mag ${item.vmag.toFixed(1)}` : 'Region';
      right.append(altBadge, magSpan);

      btn.append(left, right);
      btn.addEventListener('click', () => this.selectFromSearch(item));
      li.appendChild(btn);
      this.searchResultsEl.appendChild(li);
    });
  }

  private syncSearchHighlight(): void {
    const buttons = this.searchResultsEl.querySelectorAll<HTMLButtonElement>('.preset-item-btn');
    buttons.forEach((btn, idx) => {
      const isHighlighted = idx === this.highlightedSearchIndex;
      btn.classList.toggle('is-highlighted', isHighlighted);
      btn.setAttribute('aria-selected', String(isHighlighted));
      if (isHighlighted) {
        btn.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  private selectFromSearch(item: SearchResultItem): void {
    this.activeTourIndex = null;
    this.renderTourList();
    this.searchDialog.close('select');
    this.engine.selectObject(item.ref, { flyTo: true, track: true });
  }

  private setTourPanelOpen(open: boolean): void {
    this.tourPanel.hidden = !open;
    this.tourToggleBtn.classList.toggle('is-active', open);
    this.tourToggleBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.refreshTourStops();
    }
  }

  private refreshTourStops(): void {
    const { stops, evalDate, isDaylightPreview } = this.engine.getTonightsBestTour();
    this.activeTourStops = stops;
    this.tourIsDaylightPreview = isDaylightPreview;

    const timeLabel = evalDate.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    this.tourWindowLabel.textContent = isDaylightPreview
      ? `Evening preview (${timeLabel} tonight) · ${stops.length} top targets`
      : `Live sky window (${timeLabel}) · ${stops.length} visible targets`;

    this.renderTourList();
  }

  private renderTourList(): void {
    this.tourStopListEl.textContent = '';
    const count = this.activeTourStops.length;
    this.tourStepReadout.textContent =
      this.activeTourIndex !== null && count > 0
        ? `Step ${this.activeTourIndex + 1} / ${count}`
        : `${count} targets ranked`;

    if (count === 0) {
      const empty = document.createElement('li');
      empty.className = 'preset-item-region';
      empty.textContent = 'No bright tour targets currently computed.';
      this.tourStopListEl.appendChild(empty);
      return;
    }

    this.activeTourStops.forEach((stop, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tour-stop-btn';
      btn.classList.toggle('is-active', idx === this.activeTourIndex);

      const main = document.createElement('span');
      main.className = 'tour-stop-main';
      const title = document.createElement('span');
      title.className = 'tour-stop-title';
      title.textContent = `${idx + 1}. ${stop.name}`;
      const sub = document.createElement('span');
      sub.className = 'tour-stop-sub';
      sub.textContent = `${stop.categoryBadge} · ${stop.subtitle}`;
      main.append(title, sub);

      const meta = document.createElement('span');
      meta.className = 'tour-stop-meta mono';
      const pos = document.createElement('span');
      pos.textContent = `${stop.altDeg.toFixed(0)}° ${stop.azCardinal}`;
      const mag = document.createElement('span');
      mag.textContent = stop.vmag !== null ? `m ${stop.vmag.toFixed(1)}` : '';
      meta.append(pos, mag);

      btn.append(main, meta);
      btn.addEventListener('click', () => this.activateTourStep(idx));
      li.appendChild(btn);
      this.tourStopListEl.appendChild(li);
    });
  }

  private activateTourStep(index: number): void {
    const stop = this.activeTourStops[index];
    if (!stop) return;

    // If user starts a nighttime tour while in daylight, jump clock to Tonight 22:30 automatically
    if (this.tourIsDaylightPreview && this.lastSunAltDeg > -6) {
      this.engine.setTimeMode('tonight');
    }

    this.activeTourIndex = index;
    this.renderTourList();
    this.engine.selectObject(stop.ref, {
      flyTo: true,
      track: true,
      fovDeg: stop.recommendedFovDeg,
    });
  }

  updateSelectedObject(
    telemetry: InspectedObjectTelemetry | null,
    reticle?: ReticleScreenPosition | null,
    isTracking = false,
  ): void {
    if (!telemetry) {
      this.inspectCard.hidden = true;
      this.skyReticle.hidden = true;
      return;
    }

    // Clear active tour highlight if user clicked a different object manually
    if (
      this.activeTourIndex !== null &&
      this.activeTourStops[this.activeTourIndex]?.id !== telemetry.id
    ) {
      this.activeTourIndex = null;
      this.renderTourList();
    }

    this.inspectCard.hidden = false;
    this.inspectColorDot.style.background = telemetry.spectralColorHex;
    this.inspectColorDot.style.color = telemetry.spectralColorHex;
    this.inspectBadge.textContent = telemetry.categoryLabel.toUpperCase();
    this.inspectHorizonBadge.textContent = telemetry.isAboveHorizon ? 'ABOVE HORIZON' : 'BELOW HORIZON';
    this.inspectHorizonBadge.classList.toggle('is-below', !telemetry.isAboveHorizon);

    this.inspectTitle.textContent = telemetry.name;
    this.inspectSubtitle.textContent = telemetry.subtitle;
    this.inspectAltAz.textContent = `${telemetry.altDeg >= 0 ? '+' : ''}${telemetry.altDeg.toFixed(1)}° / ${telemetry.azDeg.toFixed(1)}° ${telemetry.azCardinal}`;
    this.inspectRaDec.textContent = `${telemetry.raFormatted} · ${telemetry.decFormatted}`;
    this.inspectMag.textContent = telemetry.vmagFormatted;
    this.inspectDist.textContent = telemetry.distanceLabel;
    this.inspectSpectral.textContent = telemetry.spectralOrMorphology;
    this.inspectRise.textContent = telemetry.rts.rise;
    this.inspectTransit.textContent = `${telemetry.rts.transit} (${Math.round(telemetry.rts.transitAltDeg)}°)`;
    this.inspectSet.textContent = telemetry.rts.set;
    this.inspectAirmass.textContent = telemetry.airmass !== null ? `${telemetry.airmass.toFixed(2)}×` : '—';
    this.inspectDescription.textContent = telemetry.description;

    this.inspectCenterBtn.textContent = isTracking ? 'Tracking Target' : 'Center & Track';
    this.inspectCenterBtn.classList.toggle('is-active', isTracking);

    const activeStop =
      this.activeTourIndex !== null ? this.activeTourStops[this.activeTourIndex] : undefined;
    if (activeStop && activeStop.id === telemetry.id) {
      this.inspectTourBanner.hidden = false;
      this.inspectTourStep.textContent = `TOUR ${this.activeTourIndex! + 1}/${this.activeTourStops.length}`;
      this.inspectTourNote.textContent = activeStop.highlightNote;
    } else {
      this.inspectTourBanner.hidden = true;
    }

    if (reticle !== undefined) {
      if (reticle && reticle.visible) {
        this.skyReticle.hidden = false;
        this.skyReticle.style.left = `${reticle.x.toFixed(1)}px`;
        this.skyReticle.style.top = `${reticle.y.toFixed(1)}px`;
      } else {
        this.skyReticle.hidden = true;
      }
    }
  }

  updateTelemetry(snapshot: TelemetrySnapshot): void {
    this.lastSunAltDeg = snapshot.sun.altDeg;
    this.gpuBadge.textContent = snapshot.backendLabel;
    this.starCountLabel.textContent = `${snapshot.starCount.toLocaleString()} stars · ${snapshot.dsoCount} DSOs`;
    this.fpsLabel.textContent = `${snapshot.fps} FPS`;

    const utcStr = snapshot.observedDate.toISOString().slice(11, 19);
    const localStr = snapshot.observedDate.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const speedTag = !snapshot.isPlaying
      ? 'PAUSED'
      : snapshot.timeWarpMultiplier !== 1
        ? `${snapshot.timeWarpMultiplier}×`
        : snapshot.timeMode === 'live'
          ? ''
          : snapshot.timeMode.toUpperCase();

    this.clockReadout.textContent = speedTag
      ? `${localStr} · ${utcStr} UTC (${speedTag})`
      : `${localStr} (${utcStr} UTC)`;

    this.lastReadout.textContent = formatHMS(snapshot.lastRad, true);
    this.sunReadout.textContent = `${snapshot.sun.twilightPhase} (${snapshot.sun.altDeg >= 0 ? '+' : ''}${snapshot.sun.altDeg.toFixed(1)}°)`;
    this.moonReadout.textContent = `${snapshot.moon.phaseName} (${Math.round(snapshot.moon.phaseFraction * 100)}%)`;

    // Sync Time Machine controls
    this.timePlayPauseBtn.textContent = snapshot.isPlaying ? 'Pause' : 'Play';
    this.timePlayPauseBtn.classList.toggle('is-active', snapshot.isPlaying);
    this.timePlayPauseBtn.setAttribute('aria-label', snapshot.isPlaying ? 'Pause simulation' : 'Play simulation');

    this.timeModeButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.timeMode === snapshot.timeMode);
    });

    this.timeWarpButtons.forEach((btn) => {
      const warp = Number(btn.dataset.timeWarp ?? 1);
      btn.classList.toggle('is-active', warp === snapshot.timeWarpMultiplier);
    });

    if (!this.isScrubbingTime && document.activeElement !== this.timeScrubSlider) {
      const minutesOfDay = snapshot.observedDate.getHours() * 60 + snapshot.observedDate.getMinutes();
      this.timeScrubSlider.value = String(minutesOfDay);
      syncRangeSliderCssVars(this.timeScrubSlider);
      const hhmm = formatMinutesHHMM(minutesOfDay);
      this.timeScrubReadout.textContent = hhmm;
      this.timeScrubSlider.setAttribute('aria-valuetext', `${hhmm} local time`);
    }

    if (document.activeElement !== this.timeDatetimeInput) {
      const formattedDt = formatDateTimeLocalValue(snapshot.observedDate);
      if (this.timeDatetimeInput.value !== formattedDt) {
        this.timeDatetimeInput.value = formattedDt;
      }
    }

    const cardinal = azimuthToCardinal(snapshot.azDeg);
    this.azReadout.textContent = `${snapshot.azDeg.toFixed(1)}° ${cardinal}`;
    this.altReadout.textContent = `${snapshot.altDeg >= 0 ? '+' : ''}${snapshot.altDeg.toFixed(1)}°`;
    this.fovReadout.textContent = `${Math.round(snapshot.fovDeg)}°`;

    this.updateSelectedObject(
      snapshot.selectedObject,
      snapshot.selectedReticle,
      snapshot.isTrackingObject,
    );
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
      } else if (el.textContent !== item.text) {
        el.textContent = item.text;
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
