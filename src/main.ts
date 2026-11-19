/// <reference types="vite/client" />
import './style.css';
import { loadCelestialCatalog } from './data/catalogLoader';
import { SkyEngine } from './render/skyRenderer';
import {
  detectGpsLocation,
  loadObserverLocation,
  saveObserverLocation,
  type ObserverLocation,
} from './services/locationService';
import { parseSkyUrlParams } from './services/urlState';
import { HudController } from './ui/hudController';

const BORTLE_STORAGE_KEY = 'stargazer.bortleClass.v1';

function resolveSavedBortleClass(): number {
  try {
    const raw = Number(localStorage.getItem(BORTLE_STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= 1 && raw <= 9) {
      return Math.round(raw);
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
  return 4;
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('sky-canvas') as HTMLCanvasElement | null;
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingDetail = document.getElementById('loading-detail');
  const contextReloadBtn = document.getElementById('context-reload-btn') as HTMLButtonElement | null;

  contextReloadBtn?.addEventListener('click', () => {
    window.location.reload();
  });

  if (!canvas) {
    throw new Error('Missing #sky-canvas element.');
  }

  const urlState = parseSkyUrlParams(window.location.search);
  const hasUrlLocation = urlState.lat !== undefined && urlState.lon !== undefined;
  const initialLocation: ObserverLocation = hasUrlLocation
    ? {
        name: urlState.name ?? 'Shared Site',
        region: 'Shared Coordinates',
        latitude: urlState.lat!,
        longitude: urlState.lon!,
        elevation: urlState.elev ?? 10,
        source: 'custom',
      }
    : loadObserverLocation();

  const initialBortleClass = urlState.bortleClass ?? resolveSavedBortleClass();

  try {
    if (loadingDetail) {
      loadingDetail.textContent = 'Downloading binary Hipparcos catalog & 88 IAU constellations…';
    }
    const catalog = await loadCelestialCatalog();

    if (loadingDetail) {
      loadingDetail.textContent = 'Compiling WebGPU / WebGL2 spectral sky shaders…';
    }

    let hud: HudController | null = null;

    const engine = await SkyEngine.create({
      canvas,
      catalog,
      initialLocation,
      initialBortleClass,
      onTelemetry: (snapshot) => {
        hud?.updateTelemetry(snapshot);
      },
      onSelectObject: (telemetry) => {
        hud?.updateSelectedObject(telemetry);
      },
      onContextLost: (reason) => {
        if (loadingDetail) {
          loadingDetail.textContent = `${reason} Reload the page to restore GPU rendering.`;
        }
        if (contextReloadBtn) {
          contextReloadBtn.hidden = false;
        }
        loadingOverlay?.classList.remove('is-hidden');
      },
    });

    if (urlState.timestampMs !== undefined) {
      engine.setObservedDate(new Date(urlState.timestampMs), 'custom');
    }
    if (urlState.azDeg !== undefined || urlState.altDeg !== undefined) {
      engine.lookAt(urlState.azDeg ?? 180, urlState.altDeg ?? 32);
    }
    if (urlState.fovDeg !== undefined) {
      engine.setFov(urlState.fovDeg);
    }

    hud = new HudController(engine, initialLocation);

    if (urlState.target) {
      const hits = engine.searchObjects(urlState.target, 'all');
      const topHit = hits[0];
      if (topHit) {
        engine.selectObject(topHit.ref, {
          flyTo: urlState.azDeg === undefined && urlState.altDeg === undefined,
          track: false,
          fovDeg: urlState.fovDeg,
        });
      }
    }

    window.addEventListener('pagehide', () => {
      hud?.dispose();
      engine.dispose();
    });

    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      });
    }

    // Reveal the live sky canvas immediately
    loadingOverlay?.classList.add('is-hidden');

    // Attempt non-blocking GPS auto-detection if the user hasn't picked a manual or shared site yet
    if (!hasUrlLocation && initialLocation.source !== 'custom' && 'geolocation' in navigator) {
      detectGpsLocation(6000)
        .then((gpsLoc) => {
          saveObserverLocation(gpsLoc);
          hud?.applyLocation(gpsLoc);
        })
        .catch(() => {
          // Graceful fallback: remain on saved/default location without interrupting observation
        });
    }
  } catch (err) {
    console.error('Stargazer initialization error:', err);
    if (loadingDetail) {
      loadingDetail.textContent =
        err instanceof Error
          ? `Initialization failed: ${err.message}`
          : 'Unable to initialize WebGPU/WebGL2 graphics context.';
    }
  }
}

void bootstrap();
