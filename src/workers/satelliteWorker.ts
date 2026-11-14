import {
  computeSatelliteOrbitArc,
  DEFAULT_SATELLITE_TLES,
  ISS_NORAD_ID,
  predictUpcomingPasses,
  propagateAllSatellites,
  type SatellitePassPrediction,
  type SatelliteSystemSnapshot,
  type SatelliteTleRecord,
  type SatelliteWorkerRequest,
  type SatelliteWorkerResponse,
  type TleSourceKind,
} from '../astro/satellites';
import type { ObserverLocation } from '../services/locationService';

let activeRecords: SatelliteTleRecord[] = DEFAULT_SATELLITE_TLES;
let activeTleSource: TleSourceKind = 'embedded';
let cachedPasses: SatellitePassPrediction[] = [];

function buildSnapshot(
  timestampMs: number,
  location: ObserverLocation,
  selectedNoradId: number | null,
  recomputePasses: boolean,
): SatelliteSystemSnapshot {
  const date = new Date(timestampMs);
  const satellites = propagateAllSatellites(activeRecords, date, location);
  const issRec = activeRecords.find((r) => r.noradId === ISS_NORAD_ID) ?? activeRecords[0];
  const issArc = issRec ? computeSatelliteOrbitArc(issRec, date, location) : [];

  const selectedRec =
    selectedNoradId && selectedNoradId !== ISS_NORAD_ID
      ? activeRecords.find((r) => r.noradId === selectedNoradId)
      : undefined;
  const selectedArc = selectedRec ? computeSatelliteOrbitArc(selectedRec, date, location) : [];

  if (recomputePasses && issRec) {
    cachedPasses = predictUpcomingPasses(issRec, date, location);
  }

  return {
    timestampMs,
    tleSource: activeTleSource,
    satellites,
    issArc,
    selectedArc,
    selectedNoradId,
    issPasses: cachedPasses,
  };
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (ev: MessageEvent<SatelliteWorkerRequest>) => void,
  ) => void;
  postMessage: (message: SatelliteWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'init' || msg.type === 'updateTles') {
    activeRecords = msg.records;
    activeTleSource = msg.tleSource;
    const snapshot = buildSnapshot(msg.timestampMs, msg.location, msg.selectedNoradId, true);
    workerScope.postMessage({ type: 'snapshot', snapshot });
    return;
  }

  if (msg.type === 'propagate') {
    const recompute = Boolean(msg.recomputePasses) || cachedPasses.length === 0;
    const snapshot = buildSnapshot(msg.timestampMs, msg.location, msg.selectedNoradId, recompute);
    workerScope.postMessage({ type: 'snapshot', snapshot });
  }
});
