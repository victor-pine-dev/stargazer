import type {
  CelestialObjectKind,
  InspectedObjectTelemetry,
  SearchResultItem,
  TourStopItem,
} from '../astro/celestialIndex';
import { azimuthToCardinal, formatHMS } from '../astro/coordinates';
import {
  ISS_NORAD_ID,
  type SatellitePassPrediction,
  type SatelliteSystemSnapshot,
  type SatelliteTelemetryState,
} from '../astro/satellites';
import type {
  AircraftSystemSnapshot,
  AircraftTelemetryState,
} from '../astro/aircraft';
import type { CalmModeSnapshot, MeteorRateMode } from '../astro/meteors';
import {
  CalmAudioController,
  type CalmAudioPreset,
  type CalmAudioState,
} from '../services/calmAudioService';
import type { GyroControllerState } from '../services/gyroService';
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

type DrawerKey = 'tour' | 'time' | 'layers' | 'iss' | 'flights';

export class HudController {
  private readonly engine: SkyEngine;
  private currentLocation: ObserverLocation;

  private readonly skyCanvas: HTMLCanvasElement;
  private readonly hudHideBtn: HTMLButtonElement;
  private isHudMinimized = false;
  private activeDrawer: DrawerKey | null = null;

  private readonly gpuBadge: HTMLElement;
  private readonly starCountLabel: HTMLElement;
  private readonly fpsLabel: HTMLElement;
  private readonly locationNameEl: HTMLElement;
  private readonly locationSourceBadge: HTMLElement;
  private readonly locationCoordsEl: HTMLElement;
  private readonly clockReadout: HTMLElement;
  private readonly utcReadout: HTMLElement;
  private readonly lastReadout: HTMLElement;
  private readonly sunReadout: HTMLElement;
  private readonly moonReadout: HTMLElement;
  private readonly azReadout: HTMLElement;
  private readonly altReadout: HTMLElement;
  private readonly fovReadout: HTMLElement;
  private readonly layersAzReadout: HTMLElement;
  private readonly layersAltReadout: HTMLElement;
  private readonly layersFovReadout: HTMLElement;
  private readonly labelsLayer: HTMLElement;

  private readonly timeQuickBtn: HTMLButtonElement;
  private readonly timeToggleBtn: HTMLButtonElement;
  private readonly timePanel: HTMLElement;
  private readonly timeCloseBtn: HTMLButtonElement;
  private readonly timePlayPauseBtn: HTMLButtonElement;
  private readonly timeNowBtn: HTMLButtonElement;
  private readonly timeScrubSlider: HTMLInputElement;
  private readonly timeScrubReadout: HTMLElement;
  private readonly timeDatetimeInput: HTMLInputElement;
  private readonly timeWarpButtons: NodeListOf<HTMLButtonElement>;
  private readonly timeModeButtons: NodeListOf<HTMLButtonElement>;
  private isScrubbingTime = false;

  private readonly layersToggleBtn: HTMLButtonElement;
  private readonly layersPanel: HTMLElement;
  private readonly layersCloseBtn: HTMLButtonElement;
  private readonly layersZoomInBtn: HTMLButtonElement;
  private readonly layersZoomOutBtn: HTMLButtonElement;

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
  private readonly inspectMagLabel: HTMLElement;
  private readonly inspectMag: HTMLElement;
  private readonly inspectDist: HTMLElement;
  private readonly inspectSpectral: HTMLElement;
  private readonly inspectRiseLabel: HTMLElement;
  private readonly inspectRise: HTMLElement;
  private readonly inspectTransitLabel: HTMLElement;
  private readonly inspectTransit: HTMLElement;
  private readonly inspectSetLabel: HTMLElement;
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

  // Phase 4: ISS & Satellites Drawer + Mobile AR Gyroscope HUD
  private readonly issToggleBtn: HTMLButtonElement;
  private readonly issPanel: HTMLElement;
  private readonly issCloseBtn: HTMLButtonElement;
  private readonly issTleSourceEl: HTMLElement;
  private readonly issSunlitBadge: HTMLElement;
  private readonly issLiveAltAz: HTMLElement;
  private readonly issLiveOrbit: HTMLElement;
  private readonly issTrackBtn: HTMLButtonElement;
  private readonly issRefreshBtn: HTMLButtonElement;
  private readonly issPassListEl: HTMLOListElement;
  private readonly satCatalogListEl: HTMLUListElement;
  private lastPassesRenderKey = '';
  private lastSatListRenderMs = 0;
  private readonly satRowPool = new Map<
    number,
    { btn: HTMLButtonElement; titleEl: HTMLElement; subEl: HTMLElement; posEl: HTMLElement; magEl: HTMLElement }
  >();

  // Phase 6: Live ADS-B Aircraft Flights Drawer
  private readonly flightsToggleBtn: HTMLButtonElement;
  private readonly flightsPanel: HTMLElement;
  private readonly flightsCloseBtn: HTMLButtonElement;
  private readonly flightsSourceLabel: HTMLElement;
  private readonly flightsClosestBadge: HTMLElement;
  private readonly flightsClosestName: HTMLElement;
  private readonly flightsClosestPhase: HTMLElement;
  private readonly flightsClosestAltAz: HTMLElement;
  private readonly flightsClosestMetrics: HTMLElement;
  private readonly flightsTrackBtn: HTMLButtonElement;
  private readonly flightsRefreshBtn: HTMLButtonElement;
  private readonly flightsListHeading: HTMLElement;
  private readonly flightsCatalogListEl: HTMLUListElement;
  private lastFlightsListRenderMs = 0;
  private readonly flightsRowPool = new Map<
    string,
    { li: HTMLLIElement; btn: HTMLButtonElement; titleEl: HTMLElement; subEl: HTMLElement; posEl: HTMLElement; altEl: HTMLElement }
  >();

  private readonly arGyroBtn: HTMLButtonElement;
  private readonly arHudBanner: HTMLElement;
  private readonly arStatusBadge: HTMLElement;
  private readonly arStatusText: HTMLElement;
  private readonly arHeadingReadout: HTMLElement;
  private readonly arTrimLeftBtn: HTMLButtonElement;
  private readonly arTrimResetBtn: HTMLButtonElement;
  private readonly arTrimRightBtn: HTMLButtonElement;
  private readonly arExitBtn: HTMLButtonElement;

  // Phase 7: Calm / Relax Mode (Campfire, Music & Meteors)
  private readonly calmAudio = new CalmAudioController();
  private readonly calmModeBtn: HTMLButtonElement;
  private readonly calmHudBanner: HTMLElement;
  private readonly calmStatusText: HTMLElement;
  private readonly calmMeteorCount: HTMLElement;
  private readonly calmAudioPresetButtons: NodeListOf<HTMLButtonElement>;
  private readonly calmAudioMuteBtn: HTMLButtonElement;
  private readonly calmVolumeSlider: HTMLInputElement;
  private readonly calmVolumeReadout: HTMLElement;
  private readonly calmMeteorRateButtons: NodeListOf<HTMLButtonElement>;
  private readonly calmWishBtn: HTMLButtonElement;
  private readonly calmFaceFireBtn: HTMLButtonElement;
  private readonly calmZenBtn: HTMLButtonElement;
  private readonly calmExitBtn: HTMLButtonElement;

  private readonly labelPool = new Map<string, HTMLSpanElement>();

  constructor(engine: SkyEngine, initialLocation: ObserverLocation) {
    this.engine = engine;
    this.currentLocation = initialLocation;

    this.skyCanvas = document.getElementById('sky-canvas') as HTMLCanvasElement;
    this.hudHideBtn = document.getElementById('hud-hide-btn') as HTMLButtonElement;

    this.gpuBadge = document.getElementById('gpu-badge')!;
    this.starCountLabel = document.getElementById('star-count-label')!;
    this.fpsLabel = document.getElementById('fps-label')!;
    this.locationNameEl = document.getElementById('location-name')!;
    this.locationSourceBadge = document.getElementById('location-source-badge')!;
    this.locationCoordsEl = document.getElementById('location-coords')!;
    this.clockReadout = document.getElementById('clock-readout')!;
    this.utcReadout = document.getElementById('utc-readout')!;
    this.lastReadout = document.getElementById('last-readout')!;
    this.sunReadout = document.getElementById('sun-readout')!;
    this.moonReadout = document.getElementById('moon-readout')!;
    this.azReadout = document.getElementById('az-readout')!;
    this.altReadout = document.getElementById('alt-readout')!;
    this.fovReadout = document.getElementById('fov-readout')!;
    this.layersAzReadout = document.getElementById('layers-az-readout')!;
    this.layersAltReadout = document.getElementById('layers-alt-readout')!;
    this.layersFovReadout = document.getElementById('layers-fov-readout')!;
    this.labelsLayer = document.getElementById('sky-labels-layer')!;

    this.timeQuickBtn = document.getElementById('time-quick-btn') as HTMLButtonElement;
    this.timeToggleBtn = document.getElementById('time-toggle-btn') as HTMLButtonElement;
    this.timePanel = document.getElementById('time-panel')!;
    this.timeCloseBtn = document.getElementById('time-close-btn') as HTMLButtonElement;
    this.timePlayPauseBtn = document.getElementById('time-play-pause-btn') as HTMLButtonElement;
    this.timeNowBtn = document.getElementById('time-now-btn') as HTMLButtonElement;
    this.timeScrubSlider = document.getElementById('time-scrub-slider') as HTMLInputElement;
    this.timeScrubReadout = document.getElementById('time-scrub-readout')!;
    this.timeDatetimeInput = document.getElementById('time-datetime-input') as HTMLInputElement;
    this.timeWarpButtons = document.querySelectorAll<HTMLButtonElement>('[data-time-warp]');
    this.timeModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-time-mode]');

    this.layersToggleBtn = document.getElementById('layers-toggle-btn') as HTMLButtonElement;
    this.layersPanel = document.getElementById('layers-panel')!;
    this.layersCloseBtn = document.getElementById('layers-close-btn') as HTMLButtonElement;
    this.layersZoomInBtn = document.getElementById('layers-zoom-in-btn') as HTMLButtonElement;
    this.layersZoomOutBtn = document.getElementById('layers-zoom-out-btn') as HTMLButtonElement;

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
    this.inspectMagLabel = document.getElementById('inspect-mag-label')!;
    this.inspectMag = document.getElementById('inspect-mag')!;
    this.inspectDist = document.getElementById('inspect-dist')!;
    this.inspectSpectral = document.getElementById('inspect-spectral')!;
    this.inspectRiseLabel = document.getElementById('inspect-rise-label')!;
    this.inspectRise = document.getElementById('inspect-rise')!;
    this.inspectTransitLabel = document.getElementById('inspect-transit-label')!;
    this.inspectTransit = document.getElementById('inspect-transit')!;
    this.inspectSetLabel = document.getElementById('inspect-set-label')!;
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

    this.issToggleBtn = document.getElementById('iss-toggle-btn') as HTMLButtonElement;
    this.issPanel = document.getElementById('iss-panel')!;
    this.issCloseBtn = document.getElementById('iss-close-btn') as HTMLButtonElement;
    this.issTleSourceEl = document.getElementById('iss-tle-source')!;
    this.issSunlitBadge = document.getElementById('iss-sunlit-badge')!;
    this.issLiveAltAz = document.getElementById('iss-live-altaz')!;
    this.issLiveOrbit = document.getElementById('iss-live-orbit')!;
    this.issTrackBtn = document.getElementById('iss-track-btn') as HTMLButtonElement;
    this.issRefreshBtn = document.getElementById('iss-refresh-btn') as HTMLButtonElement;
    this.issPassListEl = document.getElementById('iss-pass-list') as HTMLOListElement;
    this.satCatalogListEl = document.getElementById('sat-catalog-list') as HTMLUListElement;

    this.flightsToggleBtn = document.getElementById('flights-toggle-btn') as HTMLButtonElement;
    this.flightsPanel = document.getElementById('flights-panel')!;
    this.flightsCloseBtn = document.getElementById('flights-close-btn') as HTMLButtonElement;
    this.flightsSourceLabel = document.getElementById('flights-source-label')!;
    this.flightsClosestBadge = document.getElementById('flights-closest-badge')!;
    this.flightsClosestName = document.getElementById('flights-closest-name')!;
    this.flightsClosestPhase = document.getElementById('flights-closest-phase')!;
    this.flightsClosestAltAz = document.getElementById('flights-closest-altaz')!;
    this.flightsClosestMetrics = document.getElementById('flights-closest-metrics')!;
    this.flightsTrackBtn = document.getElementById('flights-track-btn') as HTMLButtonElement;
    this.flightsRefreshBtn = document.getElementById('flights-refresh-btn') as HTMLButtonElement;
    this.flightsListHeading = document.getElementById('flights-list-heading')!;
    this.flightsCatalogListEl = document.getElementById('flights-catalog-list') as HTMLUListElement;

    this.arGyroBtn = document.getElementById('ar-gyro-btn') as HTMLButtonElement;
    this.arHudBanner = document.getElementById('ar-hud-banner')!;
    this.arStatusBadge = document.getElementById('ar-status-badge')!;
    this.arStatusText = document.getElementById('ar-status-text')!;
    this.arHeadingReadout = document.getElementById('ar-heading-readout')!;
    this.arTrimLeftBtn = document.getElementById('ar-trim-left') as HTMLButtonElement;
    this.arTrimResetBtn = document.getElementById('ar-trim-reset') as HTMLButtonElement;
    this.arTrimRightBtn = document.getElementById('ar-trim-right') as HTMLButtonElement;
    this.arExitBtn = document.getElementById('ar-exit-btn') as HTMLButtonElement;

    this.calmModeBtn = document.getElementById('calm-mode-btn') as HTMLButtonElement;
    this.calmHudBanner = document.getElementById('calm-hud-banner')!;
    this.calmStatusText = document.getElementById('calm-status-text')!;
    this.calmMeteorCount = document.getElementById('calm-meteor-count')!;
    this.calmAudioPresetButtons = document.querySelectorAll<HTMLButtonElement>('[data-calm-audio]');
    this.calmAudioMuteBtn = document.getElementById('calm-audio-mute-btn') as HTMLButtonElement;
    this.calmVolumeSlider = document.getElementById('calm-volume-slider') as HTMLInputElement;
    this.calmVolumeReadout = document.getElementById('calm-volume-readout')!;
    this.calmMeteorRateButtons = document.querySelectorAll<HTMLButtonElement>('[data-meteor-rate]');
    this.calmWishBtn = document.getElementById('calm-wish-btn') as HTMLButtonElement;
    this.calmFaceFireBtn = document.getElementById('calm-face-fire-btn') as HTMLButtonElement;
    this.calmZenBtn = document.getElementById('calm-zen-btn') as HTMLButtonElement;
    this.calmExitBtn = document.getElementById('calm-exit-btn') as HTMLButtonElement;

    ensureModernDialogSupport(this.locationDialog);
    ensureModernDialogSupport(this.searchDialog);
    syncRangeSliderCssVars(this.timeScrubSlider);
    syncRangeSliderCssVars(this.calmVolumeSlider);
    this.syncCalmAudioUi(this.calmAudio.getState());
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

    // Zoom buttons (top bar & layers drawer)
    document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.engine.zoomBy(-12));
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.engine.zoomBy(12));
    this.layersZoomInBtn.addEventListener('click', () => this.engine.zoomBy(-12));
    this.layersZoomOutBtn.addEventListener('click', () => this.engine.zoomBy(12));

    // Unobstructed sky toggle (Hide/Show HUD)
    this.hudHideBtn.addEventListener('click', () => {
      this.isHudMinimized = !this.isHudMinimized;
      document.body.classList.toggle('is-hud-minimized', this.isHudMinimized);
      this.hudHideBtn.classList.toggle('is-active', this.isHudMinimized);
      this.hudHideBtn.setAttribute('aria-pressed', String(this.isHudMinimized));
      this.hudHideBtn.setAttribute(
        'aria-label',
        this.isHudMinimized ? 'Show HUD controls' : 'Hide HUD controls for unobstructed sky view',
      );
      if (this.isHudMinimized) {
        this.setActiveDrawer(null);
      }
    });

    // Time Machine & Layers drawers
    const toggleTimeDrawer = () => {
      this.setActiveDrawer(this.activeDrawer === 'time' ? null : 'time');
    };
    this.timeQuickBtn.addEventListener('click', toggleTimeDrawer);
    this.timeToggleBtn.addEventListener('click', toggleTimeDrawer);
    this.timeCloseBtn.addEventListener('click', () => this.setActiveDrawer(null));

    this.layersToggleBtn.addEventListener('click', () => {
      this.setActiveDrawer(this.activeDrawer === 'layers' ? null : 'layers');
    });
    this.layersCloseBtn.addEventListener('click', () => this.setActiveDrawer(null));

    // Light-dismiss open drawers on canvas tap (non-drag)
    let canvasTapStart: { pointerId: number; x: number; y: number } | null = null;
    this.skyCanvas.addEventListener('pointerdown', (e) => {
      if (e.isPrimary) {
        canvasTapStart = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      }
    });
    this.skyCanvas.addEventListener('pointerup', (e) => {
      if (!canvasTapStart || canvasTapStart.pointerId !== e.pointerId) return;
      const dist = Math.hypot(e.clientX - canvasTapStart.x, e.clientY - canvasTapStart.y);
      canvasTapStart = null;
      if (dist < 8 && this.activeDrawer !== null) {
        this.setActiveDrawer(null);
      }
    });
    this.skyCanvas.addEventListener('pointercancel', () => {
      canvasTapStart = null;
    });

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

    // Global Cmd/Ctrl+K shortcut to toggle Search Catalog palette, Escape to dismiss open drawer
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
        return;
      }

      if (e.key === 'Escape' && !this.locationDialog.open && !this.searchDialog.open) {
        if (this.activeDrawer !== null) {
          this.setActiveDrawer(null);
        } else if (!this.inspectCard.hidden) {
          this.activeTourIndex = null;
          this.renderTourList();
          this.engine.selectObject(null);
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
      this.setActiveDrawer(this.activeDrawer === 'tour' ? null : 'tour');
    });

    this.tourCloseBtn.addEventListener('click', () => {
      this.setActiveDrawer(null);
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

    // ISS & Satellites drawer
    this.issToggleBtn.addEventListener('click', () => {
      this.setActiveDrawer(this.activeDrawer === 'iss' ? null : 'iss');
    });
    this.issCloseBtn.addEventListener('click', () => {
      this.setActiveDrawer(null);
    });
    this.issTrackBtn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        this.setActiveDrawer(null);
      }
      this.engine.trackIss();
      this.syncLayerToggleButtons();
    });
    this.issRefreshBtn.addEventListener('click', async () => {
      this.issRefreshBtn.disabled = true;
      this.issRefreshBtn.textContent = 'Syncing…';
      try {
        const result = await this.engine.refreshSatelliteTles();
        this.issTleSourceEl.textContent =
          result.source === 'celestrak-live'
            ? `CelesTrak Live GP · ${result.updatedCount} TLEs synced`
            : result.source === 'celestrak-cache'
              ? `CelesTrak Cached TLEs (${result.updatedCount} objects)`
              : 'Embedded Epoch TLEs (offline fallback)';
      } finally {
        this.issRefreshBtn.disabled = false;
        this.issRefreshBtn.textContent = 'Refresh TLEs';
      }
    });

    // Live ADS-B Flights drawer
    this.flightsToggleBtn.addEventListener('click', () => {
      this.setActiveDrawer(this.activeDrawer === 'flights' ? null : 'flights');
    });
    this.flightsCloseBtn.addEventListener('click', () => {
      this.setActiveDrawer(null);
    });
    this.flightsTrackBtn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        this.setActiveDrawer(null);
      }
      this.engine.trackClosestAircraft();
      this.syncLayerToggleButtons();
    });
    this.flightsRefreshBtn.addEventListener('click', async () => {
      this.flightsRefreshBtn.disabled = true;
      this.flightsRefreshBtn.textContent = 'Scanning…';
      try {
        await this.engine.refreshAircraftRadar();
        this.lastFlightsListRenderMs = 0;
        this.updateFlightsDrawer(this.engine.getAircraftSnapshot(), null, true);
      } finally {
        this.flightsRefreshBtn.disabled = false;
        this.flightsRefreshBtn.textContent = 'Refresh Radar';
      }
    });

    // Mobile AR Gyroscope mode
    this.arGyroBtn.addEventListener('click', async () => {
      const state = await this.engine.toggleArGyro();
      if (state.status !== 'off' && window.innerWidth <= 768) {
        this.setActiveDrawer(null);
      }
      this.updateArBanner(state);
    });
    this.arTrimLeftBtn.addEventListener('click', () => this.engine.adjustArCompassOffset(-5));
    this.arTrimRightBtn.addEventListener('click', () => this.engine.adjustArCompassOffset(5));
    this.arTrimResetBtn.addEventListener('click', () => this.engine.resetArCalibration());
    this.arExitBtn.addEventListener('click', async () => {
      if (this.engine.getArGyroState().status !== 'off') {
        const state = await this.engine.toggleArGyro();
        this.updateArBanner(state);
      }
    });

    // Calm / Relax Mode (Campfire, Music & Meteors)
    const setCalmModeActive = (enable: boolean) => {
      if (enable) {
        const audioPromise = this.calmAudio.start();
        this.setActiveDrawer(null);
        const snap = this.engine.toggleCalmMode(true);
        this.syncCalmModeUi(snap);
        this.syncLayerToggleButtons();
        void audioPromise.then((audioState) => {
          this.syncCalmAudioUi(audioState);
        });
      } else {
        const snap = this.engine.toggleCalmMode(false);
        const audioState = this.calmAudio.stop();
        this.syncCalmModeUi(snap);
        this.syncCalmAudioUi(audioState);
      }
    };

    this.calmModeBtn.addEventListener('click', () => {
      const currentlyEnabled = this.engine.getCalmModeSnapshot().enabled;
      setCalmModeActive(!currentlyEnabled);
    });

    this.calmExitBtn.addEventListener('click', () => {
      setCalmModeActive(false);
    });

    this.calmAudioPresetButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.calmAudio as CalmAudioPreset | undefined;
        if (!preset) return;
        this.syncCalmAudioUi(this.calmAudio.setPreset(preset));
      });
    });

    this.calmAudioMuteBtn.addEventListener('click', () => {
      this.syncCalmAudioUi(this.calmAudio.toggleMuted());
    });

    this.calmVolumeSlider.addEventListener('input', () => {
      syncRangeSliderCssVars(this.calmVolumeSlider);
      const volume = Number(this.calmVolumeSlider.value);
      this.syncCalmAudioUi(this.calmAudio.setVolume(volume));
    });

    this.calmMeteorRateButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const rate = btn.dataset.meteorRate as MeteorRateMode | undefined;
        if (!rate) return;
        this.syncCalmModeUi(this.engine.setMeteorRate(rate));
      });
    });

    this.calmWishBtn.addEventListener('click', () => {
      this.engine.triggerWishMeteor();
    });

    this.calmFaceFireBtn.addEventListener('click', () => {
      this.engine.faceCampfire();
    });

    this.calmZenBtn.addEventListener('click', () => {
      const current = this.engine.getCalmModeSnapshot();
      this.syncCalmModeUi(this.engine.setCalmZenHud(!current.zenHud));
    });
  }

  private renderSearchResults(): void {
    const query = this.celestialSearchInput.value;
    this.currentSearchResults = this.engine.searchObjects(query, this.activeSearchFilter);
    this.searchResultsEl.textContent = '';

    if (this.currentSearchResults.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'preset-item-btn';
      empty.textContent = 'No matching stars, planets, satellites, aircraft, DSOs, or constellations.';
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
      magSpan.textContent =
        item.kind === 'aircraft'
          ? item.categoryBadge
          : item.vmag !== null
            ? `mag ${item.vmag.toFixed(1)}`
            : 'Region';
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
    if (window.innerWidth <= 768 && this.activeDrawer !== null) {
      this.setActiveDrawer(null);
    }
    if (item.kind === 'satellite') {
      this.engine.setLayers({ satellites: true });
      this.syncLayerToggleButtons();
    } else if (item.kind === 'aircraft') {
      this.engine.setLayers({ aircraft: true });
      this.syncLayerToggleButtons();
    }
    this.engine.selectObject(item.ref, { flyTo: true, track: true });
  }

  private setActiveDrawer(drawer: DrawerKey | null): void {
    this.activeDrawer = drawer;

    // On mobile viewports, keep only one bottom sheet visible at a time
    if (drawer !== null && window.innerWidth <= 768 && !this.inspectCard.hidden) {
      this.activeTourIndex = null;
      this.renderTourList();
      this.engine.selectObject(null);
    }

    const drawers: Array<{
      key: DrawerKey;
      panel: HTMLElement;
      triggers: HTMLButtonElement[];
      onOpen?: () => void;
    }> = [
      {
        key: 'tour',
        panel: this.tourPanel,
        triggers: [this.tourToggleBtn],
        onOpen: () => this.refreshTourStops(),
      },
      {
        key: 'time',
        panel: this.timePanel,
        triggers: [this.timeToggleBtn, this.timeQuickBtn],
      },
      {
        key: 'layers',
        panel: this.layersPanel,
        triggers: [this.layersToggleBtn],
        onOpen: () => this.syncLayerToggleButtons(),
      },
      {
        key: 'iss',
        panel: this.issPanel,
        triggers: [this.issToggleBtn],
        onOpen: () => {
          this.lastPassesRenderKey = '';
          this.lastSatListRenderMs = 0;
          this.updateSatelliteDrawer(this.engine.getSatelliteSnapshot(), null);
        },
      },
      {
        key: 'flights',
        panel: this.flightsPanel,
        triggers: [this.flightsToggleBtn],
        onOpen: () => {
          this.lastFlightsListRenderMs = 0;
          this.updateFlightsDrawer(this.engine.getAircraftSnapshot(), null, true);
        },
      },
    ];

    for (const entry of drawers) {
      const open = drawer === entry.key;
      entry.panel.hidden = !open;
      for (const trigger of entry.triggers) {
        trigger.classList.toggle('is-active', open);
        trigger.setAttribute('aria-expanded', String(open));
      }
      if (open) {
        entry.onOpen?.();
      }
    }
  }

  private syncLayerToggleButtons(): void {
    const layers = this.engine.getLayers();
    document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((btn) => {
      const key = btn.dataset.layer as keyof LayerVisibilityState | undefined;
      if (!key) return;
      const active = Boolean(layers[key]);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  private formatPassDayLabel(timestampMs: number, referenceMs: number): string {
    const passDate = new Date(timestampMs);
    const refDate = new Date(referenceMs);
    const passDay = new Date(passDate.getFullYear(), passDate.getMonth(), passDate.getDate()).getTime();
    const refDay = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()).getTime();
    const dayDiff = Math.round((passDay - refDay) / 86_400_000);
    if (dayDiff === 0) return 'Today';
    if (dayDiff === 1) return 'Tomorrow';
    return passDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  private formatPassClock(timestampMs: number): string {
    return new Date(timestampMs).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private updateSatelliteDrawer(
    satSnap: SatelliteSystemSnapshot,
    selectedId: string | null,
  ): void {
    if (this.issPanel.hidden) return;

    const sourceLabel =
      satSnap.tleSource === 'celestrak-live'
        ? 'SGP4 Worker · CelesTrak Live TLEs'
        : satSnap.tleSource === 'celestrak-cache'
          ? 'SGP4 Worker · CelesTrak Cached TLEs'
          : 'SGP4 Worker · Embedded Epoch TLEs';
    this.issTleSourceEl.textContent = sourceLabel;

    const iss = satSnap.satellites.find((s) => s.noradId === ISS_NORAD_ID);
    if (iss) {
      this.issSunlitBadge.textContent = iss.isSunlit ? 'SUNLIT' : 'ECLIPSED';
      this.issSunlitBadge.classList.toggle('badge-horizon', iss.isSunlit);
      this.issLiveAltAz.textContent = `ALT ${iss.altDeg >= 0 ? '+' : ''}${iss.altDeg.toFixed(1)}° · AZ ${iss.azDeg.toFixed(1)}° ${iss.azCardinal}`;
      this.issLiveOrbit.textContent = `Orbit ${Math.round(iss.altitudeKm)} km · Range ${Math.round(iss.rangeKm)} km · ${iss.speedKmS.toFixed(2)} km/s`;
    }

    const passesKey = satSnap.issPasses
      .map((p) => `${p.startTimeMs}:${Math.round(p.maxAltDeg)}:${p.quality}`)
      .join('|');
    if (passesKey !== this.lastPassesRenderKey) {
      this.lastPassesRenderKey = passesKey;
      this.renderIssPassList(satSnap.issPasses, satSnap.timestampMs);
    }

    const nowMs = performance.now();
    if (nowMs - this.lastSatListRenderMs >= 900) {
      this.lastSatListRenderMs = nowMs;
      this.renderSatelliteCatalogList(satSnap.satellites, selectedId);
    }
  }

  private renderIssPassList(passes: SatellitePassPrediction[], refTimeMs: number): void {
    this.issPassListEl.textContent = '';
    if (passes.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'preset-item-region';
      empty.textContent = 'No ISS passes peaking ≥ 10° in the next 36 hours.';
      this.issPassListEl.appendChild(empty);
      return;
    }

    for (const pass of passes.slice(0, 6)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tour-stop-btn';
      btn.classList.toggle('is-active', pass.quality === 'Visible Pass');

      const main = document.createElement('span');
      main.className = 'tour-stop-main';
      const title = document.createElement('span');
      title.className = 'tour-stop-title';
      title.textContent = `${this.formatPassDayLabel(pass.startTimeMs, refTimeMs)} · ${this.formatPassClock(pass.startTimeMs)}–${this.formatPassClock(pass.endTimeMs)}`;
      const sub = document.createElement('span');
      sub.className = 'tour-stop-sub';
      sub.textContent = `${pass.quality} · ${pass.startCardinal} → ${pass.maxCardinal} → ${pass.endCardinal}`;
      main.append(title, sub);

      const meta = document.createElement('span');
      meta.className = 'tour-stop-meta mono';
      const peak = document.createElement('span');
      peak.textContent = `Peak ${Math.round(pass.maxAltDeg)}°`;
      const mag = document.createElement('span');
      mag.textContent = pass.isSunlit ? `m ${pass.peakVmag.toFixed(1)}` : 'Umbra';
      meta.append(peak, mag);

      btn.append(main, meta);
      btn.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          this.setActiveDrawer(null);
        }
        this.engine.jumpToSatellitePass(pass);
        this.syncLayerToggleButtons();
      });
      li.appendChild(btn);
      this.issPassListEl.appendChild(li);
    }
  }

  private renderSatelliteCatalogList(
    satellites: SatelliteTelemetryState[],
    selectedId: string | null,
  ): void {
    const sorted = [...satellites].sort((a, b) => {
      if (a.isAboveHorizon !== b.isAboveHorizon) return a.isAboveHorizon ? -1 : 1;
      if (a.noradId === ISS_NORAD_ID) return -1;
      if (b.noradId === ISS_NORAD_ID) return 1;
      return b.altDeg - a.altDeg;
    });

    for (const sat of sorted) {
      let row = this.satRowPool.get(sat.noradId);
      if (!row) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tour-stop-btn';

        const main = document.createElement('span');
        main.className = 'tour-stop-main';
        const titleEl = document.createElement('span');
        titleEl.className = 'tour-stop-title';
        const subEl = document.createElement('span');
        subEl.className = 'tour-stop-sub';
        main.append(titleEl, subEl);

        const meta = document.createElement('span');
        meta.className = 'tour-stop-meta mono';
        const posEl = document.createElement('span');
        const magEl = document.createElement('span');
        meta.append(posEl, magEl);

        btn.append(main, meta);
        btn.addEventListener('click', () => {
          if (window.innerWidth <= 768) {
            this.setActiveDrawer(null);
          }
          this.engine.setLayers({ satellites: true });
          this.syncLayerToggleButtons();
          this.engine.selectObject(
            { id: sat.id, kind: 'satellite', satNoradId: sat.noradId },
            { flyTo: true, track: true, fovDeg: sat.noradId === ISS_NORAD_ID ? 42 : 46 },
          );
        });
        li.appendChild(btn);
        this.satCatalogListEl.appendChild(li);
        row = { btn, titleEl, subEl, posEl, magEl };
        this.satRowPool.set(sat.noradId, row);
      }

      row.btn.classList.toggle('is-active', selectedId === sat.id);
      row.titleEl.textContent = sat.name;
      row.subEl.textContent = `${sat.category} · ${Math.round(sat.altitudeKm)} km · ${sat.isSunlit ? 'Sunlit' : 'Shadow'}`;
      row.posEl.textContent = sat.isAboveHorizon
        ? `${sat.altDeg.toFixed(0)}° ${sat.azCardinal}`
        : `Below (${sat.altDeg.toFixed(0)}°)`;
      row.magEl.textContent = `m ${sat.vmag.toFixed(1)}`;
    }
  }

  private updateArBanner(arGyro: GyroControllerState): void {
    const isOn = arGyro.status !== 'off';
    this.arGyroBtn.classList.toggle('is-active', isOn);
    this.arGyroBtn.setAttribute('aria-pressed', String(isOn));
    this.arHudBanner.hidden = !isOn;

    if (!isOn) return;

    this.arStatusBadge.textContent =
      arGyro.status === 'active'
        ? 'LIVE GYRO'
        : arGyro.status === 'simulated'
          ? 'SIMULATED SENSOR'
          : arGyro.status === 'denied'
            ? 'PERMISSION DENIED'
            : 'REQUESTING';
    this.arStatusBadge.classList.toggle('badge-horizon', arGyro.status === 'simulated');
    this.arStatusText.textContent = arGyro.statusMessage;

    const trimStr =
      arGyro.compassOffsetDeg === 0
        ? ''
        : ` · Trim ${arGyro.compassOffsetDeg > 0 ? '+' : ''}${Math.round(arGyro.compassOffsetDeg)}°`;
    this.arHeadingReadout.textContent = `HDG ${arGyro.azDeg.toFixed(0)}° ${azimuthToCardinal(arGyro.azDeg)} · ALT ${arGyro.altDeg >= 0 ? '+' : ''}${arGyro.altDeg.toFixed(0)}°${trimStr}`;
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
    if (window.innerWidth <= 768 && this.activeDrawer !== null) {
      this.setActiveDrawer(null);
    }
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

    const wasHidden = this.inspectCard.hidden;
    if (wasHidden && window.innerWidth <= 768 && this.activeDrawer !== null) {
      this.setActiveDrawer(null);
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
    const isAircraft = telemetry.kind === 'aircraft';
    this.inspectMagLabel.textContent = isAircraft ? 'ALTITUDE' : 'VISUAL MAG';
    this.inspectRiseLabel.textContent = isAircraft ? 'FLIGHT LEVEL' : 'RISE';
    this.inspectTransitLabel.textContent = isAircraft ? 'HEADING' : 'TRANSIT';
    this.inspectSetLabel.textContent = isAircraft ? 'VERT RATE' : 'SET';

    this.inspectMag.textContent = telemetry.vmagFormatted;
    this.inspectDist.textContent = telemetry.distanceLabel;
    this.inspectSpectral.textContent = telemetry.spectralOrMorphology;
    this.inspectRise.textContent = telemetry.rts.rise;
    this.inspectTransit.textContent = isAircraft
      ? telemetry.rts.transit
      : `${telemetry.rts.transit} (${Math.round(telemetry.rts.transitAltDeg)}°)`;
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

    this.clockReadout.textContent = speedTag ? `${localStr} · ${speedTag}` : localStr;
    this.utcReadout.textContent = `${utcStr} UTC · ${speedTag || 'LIVE'}`;

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
    const azText = `${snapshot.azDeg.toFixed(1)}° ${cardinal}`;
    const altText = `${snapshot.altDeg >= 0 ? '+' : ''}${snapshot.altDeg.toFixed(1)}°`;
    const fovText = `${Math.round(snapshot.fovDeg)}°`;
    this.azReadout.textContent = azText;
    this.altReadout.textContent = altText;
    this.fovReadout.textContent = fovText;
    this.layersAzReadout.textContent = azText;
    this.layersAltReadout.textContent = altText;
    this.layersFovReadout.textContent = fovText;

    this.updateSelectedObject(
      snapshot.selectedObject,
      snapshot.selectedReticle,
      snapshot.isTrackingObject,
    );
    this.updateSatelliteDrawer(
      snapshot.satellites,
      snapshot.selectedObject?.id ?? null,
    );
    const isLiveRadarWindow = Math.abs(snapshot.observedDate.getTime() - Date.now()) <= 120_000;
    this.updateFlightsDrawer(
      snapshot.aircraft,
      snapshot.selectedObject?.id ?? null,
      isLiveRadarWindow,
    );
    this.updateArBanner(snapshot.arGyro);
    if (snapshot.calmMode.enabled) {
      const prevPreset = this.calmAudio.getState().preset;
      const nextAudio = this.calmAudio.syncSkyDaylight(snapshot.sun.altDeg > -2);
      if (nextAudio.preset !== prevPreset) {
        this.syncCalmAudioUi(nextAudio);
      }
    }
    this.syncCalmModeUi(snapshot.calmMode);
    this.renderProjectedLabels(snapshot.labels);
  }

  private syncCalmAudioUi(audioState: CalmAudioState): void {
    this.calmAudioPresetButtons.forEach((btn) => {
      const active = btn.dataset.calmAudio === audioState.preset;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    this.calmAudioMuteBtn.classList.toggle('is-active', audioState.isMuted);
    this.calmAudioMuteBtn.setAttribute('aria-pressed', String(audioState.isMuted));

    if (document.activeElement !== this.calmVolumeSlider) {
      this.calmVolumeSlider.value = String(audioState.volumePercent);
      syncRangeSliderCssVars(this.calmVolumeSlider);
    }
    this.calmVolumeSlider.setAttribute('aria-valuetext', `${audioState.volumePercent}%`);
    this.calmVolumeReadout.textContent = `${audioState.volumePercent}%`;
  }

  private syncCalmModeUi(calmMode: CalmModeSnapshot): void {
    const wasHidden = this.calmHudBanner.hidden;
    if (!calmMode.enabled && wasHidden) {
      return;
    }

    this.calmModeBtn.classList.toggle('is-active', calmMode.enabled);
    this.calmModeBtn.setAttribute('aria-pressed', String(calmMode.enabled));
    this.calmHudBanner.hidden = !calmMode.enabled;
    document.body.classList.toggle('is-calm-mode', calmMode.enabled);
    document.body.classList.toggle('is-calm-zen', calmMode.enabled && calmMode.zenHud);

    if (!calmMode.enabled) return;

    const countText = `${calmMode.meteorsSpotted} ${calmMode.meteorsSpotted === 1 ? 'meteor' : 'meteors'}`;
    if (this.calmMeteorCount.textContent !== countText) {
      this.calmMeteorCount.textContent = countText;
    }

    const statusText = calmMode.lastMeteorLabel
      ? `Latest: ${calmMode.lastMeteorLabel}`
      : 'Hearth & nature sounds';
    if (this.calmStatusText.textContent !== statusText) {
      this.calmStatusText.textContent = statusText;
    }

    this.calmMeteorRateButtons.forEach((btn) => {
      const active = btn.dataset.meteorRate === calmMode.meteorRate;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    this.calmZenBtn.classList.toggle('is-active', calmMode.zenHud);
    this.calmZenBtn.setAttribute('aria-pressed', String(calmMode.zenHud));
  }

  private updateFlightsDrawer(
    acSnap: AircraftSystemSnapshot,
    selectedId: string | null,
    isLiveRadarWindow: boolean,
  ): void {
    if (this.flightsPanel.hidden) return;

    const sourceNames: Record<AircraftSystemSnapshot['source'], string> = {
      'adsb-fi': 'Open ADS-B · adsb.fi',
      'adsb-lol': 'Open ADS-B · adsb.lol',
      opensky: 'OpenSky Network',
      'adsb-cache': 'ADS-B Cached Radar',
      'simulated-corridor': 'Regional Corridor Sim',
    };
    const pauseTag = isLiveRadarWindow ? '' : ' · Paused (Time Machine)';
    this.flightsSourceLabel.textContent = `${sourceNames[acSnap.source]} · ${acSnap.aboveHorizonCount} above horizon${pauseTag}`;
    this.flightsListHeading.textContent = `Live Airborne Traffic (${acSnap.aboveHorizonCount} visible / ${acSnap.totalInRange} in range)`;

    const top = acSnap.aircraft.find((a) => a.isAboveHorizon) ?? acSnap.aircraft[0];
    if (top) {
      this.flightsClosestBadge.textContent = `${top.typeCode || 'ADS-B'} · ${top.flightLevel}`;
      this.flightsClosestName.textContent = top.operator ? `${top.callsign} · ${top.operator}` : top.callsign;
      this.flightsClosestPhase.textContent = top.flightPhase.toUpperCase();
      this.flightsClosestPhase.classList.toggle('badge-horizon', top.isAboveHorizon);
      this.flightsClosestAltAz.textContent = `ALT ${top.altDeg >= 0 ? '+' : ''}${top.altDeg.toFixed(1)}° · AZ ${top.azDeg.toFixed(1)}° ${top.azCardinal}`;
      this.flightsClosestMetrics.textContent = `Slant ${top.slantRangeKm.toFixed(1)} km · ${Math.round(top.groundSpeedKt)} kt · HDG ${Math.round(top.trackDeg)}° ${top.trackCardinal}`;
    } else {
      this.flightsClosestBadge.textContent = 'ADS-B';
      this.flightsClosestName.textContent = 'No airborne traffic in range';
      this.flightsClosestPhase.textContent = 'IDLE';
      this.flightsClosestAltAz.textContent = 'ALT — · AZ —';
      this.flightsClosestMetrics.textContent = 'Slant — km · — kt · HDG —';
    }

    const nowMs = performance.now();
    if (nowMs - this.lastFlightsListRenderMs >= 750) {
      this.lastFlightsListRenderMs = nowMs;
      this.renderFlightsCatalogList(acSnap.aircraft, selectedId);
    }
  }

  private renderFlightsCatalogList(
    aircraft: AircraftTelemetryState[],
    selectedId: string | null,
  ): void {
    const visibleSlice = aircraft.slice(0, 35);
    const activeHexes = new Set<string>();

    for (const ac of visibleSlice) {
      activeHexes.add(ac.hex);
      let row = this.flightsRowPool.get(ac.hex);
      if (!row) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tour-stop-btn';

        const main = document.createElement('span');
        main.className = 'tour-stop-main';
        const titleEl = document.createElement('span');
        titleEl.className = 'tour-stop-title';
        const subEl = document.createElement('span');
        subEl.className = 'tour-stop-sub';
        main.append(titleEl, subEl);

        const meta = document.createElement('span');
        meta.className = 'tour-stop-meta mono';
        const posEl = document.createElement('span');
        const altEl = document.createElement('span');
        meta.append(posEl, altEl);

        btn.append(main, meta);
        const hex = ac.hex;
        const id = ac.id;
        btn.addEventListener('click', () => {
          if (window.innerWidth <= 768) {
            this.setActiveDrawer(null);
          }
          this.engine.setLayers({ aircraft: true });
          this.syncLayerToggleButtons();
          this.engine.selectObject(
            { id, kind: 'aircraft', aircraftHex: hex },
            { flyTo: true, track: true, fovDeg: 40 },
          );
        });
        li.appendChild(btn);
        row = { li, btn, titleEl, subEl, posEl, altEl };
        this.flightsRowPool.set(ac.hex, row);
      }

      row.btn.classList.toggle('is-active', selectedId === ac.id);
      row.titleEl.textContent = ac.typeCode ? `${ac.callsign} · ${ac.typeCode}` : ac.callsign;
      const opText = ac.operator || ac.modelDesc || ac.flightPhase;
      row.subEl.textContent = `${opText} · ${Math.round(ac.groundSpeedKt)} kt · ${ac.slantRangeKm.toFixed(1)} km`;
      row.posEl.textContent = ac.isAboveHorizon
        ? `${ac.altDeg.toFixed(0)}° ${ac.azCardinal}`
        : `Below (${ac.altDeg.toFixed(0)}°)`;
      row.altEl.textContent = ac.flightLevel;

      // Re-append in sorted priority order without recreating nodes
      this.flightsCatalogListEl.appendChild(row.li);
    }

    for (const [hex, row] of this.flightsRowPool.entries()) {
      if (!activeHexes.has(hex)) {
        row.li.remove();
        this.flightsRowPool.delete(hex);
      }
    }
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
