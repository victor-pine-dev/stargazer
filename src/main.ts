import './style.css';
import { loadCelestialCatalog } from './data/catalogLoader';
import { SkyEngine } from './render/skyRenderer';
import {
  detectGpsLocation,
  loadObserverLocation,
  saveObserverLocation,
} from './services/locationService';
import { HudController } from './ui/hudController';

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('sky-canvas') as HTMLCanvasElement | null;
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingDetail = document.getElementById('loading-detail');

  if (!canvas) {
    throw new Error('Missing #sky-canvas element.');
  }

  const initialLocation = loadObserverLocation();

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
      onTelemetry: (snapshot) => {
        hud?.updateTelemetry(snapshot);
      },
      onSelectObject: (telemetry) => {
        hud?.updateSelectedObject(telemetry);
      },
    });

    hud = new HudController(engine, initialLocation);

    // Reveal the live sky canvas immediately
    loadingOverlay?.classList.add('is-hidden');

    // Attempt non-blocking GPS auto-detection if the user hasn't picked a manual site yet
    if (initialLocation.source !== 'custom' && 'geolocation' in navigator) {
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
