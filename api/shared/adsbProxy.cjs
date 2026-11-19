'use strict';

const METERS_TO_FEET = 3.280839895013123;
const MPS_TO_KNOTS = 1.9438444924406048;
const MPS_TO_FPM = 196.8503937007874;
const NM_TO_KM = 1.852;
const DEFAULT_TIMEOUT_MS = 2400;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_AIRCRAFT = 160;
const CACHE_TTL_MS = 6000;
const MAX_CACHE_ENTRIES = 64;
const GEO_BUCKET_DEG = 0.05;

const responseCache = new Map();
const inFlightRequests = new Map();

function buildGeoBucketKey(lat, lon, radiusNm) {
  const qLat = clamp(Math.round(lat / GEO_BUCKET_DEG) * GEO_BUCKET_DEG, -90, 90);
  const qLon = clamp(Math.round(lon / GEO_BUCKET_DEG) * GEO_BUCKET_DEG, -180, 180);
  const qRad = Math.min(150, Math.max(10, Math.ceil(radiusNm / 10) * 10));
  return {
    key: `${qLat.toFixed(2)},${qLon.toFixed(2)},${qRad}`,
    qLat,
    qLon,
    qRad,
  };
}

function clearAdsbProxyCache() {
  responseCache.clear();
  inFlightRequests.clear();
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function parseQueryParams(latInput, lonInput, radiusInput) {
  const lat = Number(latInput);
  const lon = Number(lonInput);
  const rawRadius = radiusInput === undefined || radiusInput === '' ? 65 : Number(radiusInput);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'Invalid latitude; expected [-90, 90].' };
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'Invalid longitude; expected [-180, 180].' };
  }
  const radius = Number.isFinite(rawRadius) ? clamp(Math.round(rawRadius), 10, 150) : 65;
  return { lat, lon, radius };
}

function normalizeReadsbList(items, fetchedAtMs) {
  if (!Array.isArray(items)) return [];
  const out = [];

  for (const ac of items) {
    if (!ac || typeof ac !== 'object') continue;
    const latDeg = Number(ac.lat);
    const lonDeg = Number(ac.lon);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;
    if (ac.alt_baro === 'ground') continue;

    const altBaroFt = Number(ac.alt_baro);
    const altGeomFt = Number(ac.alt_geom);
    const effectiveAltFt = Number.isFinite(altGeomFt) ? altGeomFt : altBaroFt;
    if (!Number.isFinite(effectiveAltFt) || effectiveAltFt < 150) continue;

    const hex = typeof ac.hex === 'string' ? ac.hex.trim().toLowerCase() : '';
    if (!hex) continue;

    const seenPosSec = Number(ac.seen_pos);
    const posTimestampMs =
      Number.isFinite(seenPosSec) && seenPosSec >= 0 && seenPosSec <= 30
        ? Math.round(fetchedAtMs - seenPosSec * 1000)
        : fetchedAtMs;

    const vRate = Number.isFinite(Number(ac.baro_rate))
      ? Number(ac.baro_rate)
      : Number.isFinite(Number(ac.geom_rate))
        ? Number(ac.geom_rate)
        : 0;

    out.push({
      hex,
      callsign: typeof ac.flight === 'string' ? ac.flight.trim().toUpperCase() : '',
      registration: typeof ac.r === 'string' ? ac.r.trim().toUpperCase() : '',
      typeCode: typeof ac.t === 'string' ? ac.t.trim().toUpperCase() : '',
      modelDesc: typeof ac.desc === 'string' ? ac.desc.trim() : '',
      operator: typeof ac.ownOp === 'string' ? ac.ownOp.trim() : '',
      latDeg,
      lonDeg,
      altBaroFt: Number.isFinite(altBaroFt) ? Math.round(altBaroFt) : Math.round(effectiveAltFt),
      altGeomFt: Number.isFinite(altGeomFt) ? Math.round(altGeomFt) : Math.round(effectiveAltFt),
      groundSpeedKt: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : 0,
      trackDeg: Number.isFinite(Number(ac.track)) ? ((Number(ac.track) % 360) + 360) % 360 : 0,
      verticalRateFpm: Math.round(vRate),
      squawk: typeof ac.squawk === 'string' ? ac.squawk.trim() : '',
      category: typeof ac.category === 'string' ? ac.category.trim() : '',
      fetchedAtMs: posTimestampMs,
    });
    if (out.length >= MAX_RETURNED_AIRCRAFT) break;
  }

  return out;
}

function normalizeOpenSkyPayload(payload, fetchedAtMs) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.states)) {
    return [];
  }
  const out = [];

  for (const row of payload.states) {
    if (!Array.isArray(row) || row.length < 14) continue;
    const onGround = Boolean(row[8]);
    if (onGround) continue;

    const lonDeg = Number(row[5]);
    const latDeg = Number(row[6]);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;

    const baroAltM = row[7] === null || row[7] === undefined ? NaN : Number(row[7]);
    const geoAltM = row[13] === null || row[13] === undefined ? NaN : Number(row[13]);
    const altBaroFt = Number.isFinite(baroAltM) ? baroAltM * METERS_TO_FEET : NaN;
    const altGeomFt = Number.isFinite(geoAltM) ? geoAltM * METERS_TO_FEET : NaN;
    const effectiveAltFt = Number.isFinite(altGeomFt) ? altGeomFt : altBaroFt;
    if (!Number.isFinite(effectiveAltFt) || effectiveAltFt < 150) continue;

    const hex = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
    if (!hex) continue;

    const timePosSec = Number(row[3]);
    const posTimestampMs =
      Number.isFinite(timePosSec) && timePosSec > 0
        ? Math.min(fetchedAtMs, Math.round(timePosSec * 1000))
        : fetchedAtMs;

    const velMps = Number(row[9]);
    const track = Number(row[10]);
    const vRateMps = Number(row[11]);

    out.push({
      hex,
      callsign: typeof row[1] === 'string' ? row[1].trim().toUpperCase() : '',
      registration: '',
      typeCode: '',
      modelDesc: '',
      operator: typeof row[2] === 'string' ? row[2].trim() : '',
      latDeg,
      lonDeg,
      altBaroFt: Number.isFinite(altBaroFt) ? Math.round(altBaroFt) : Math.round(effectiveAltFt),
      altGeomFt: Number.isFinite(altGeomFt) ? Math.round(altGeomFt) : Math.round(effectiveAltFt),
      groundSpeedKt: Number.isFinite(velMps) ? velMps * MPS_TO_KNOTS : 0,
      trackDeg: Number.isFinite(track) ? ((track % 360) + 360) % 360 : 0,
      verticalRateFpm: Number.isFinite(vRateMps) ? Math.round(vRateMps * MPS_TO_FPM) : 0,
      squawk: typeof row[14] === 'string' ? row[14].trim() : '',
      category: '',
      fetchedAtMs: posTimestampMs,
    });
    if (out.length >= MAX_RETURNED_AIRCRAFT) break;
  }

  return out;
}

async function fetchJsonWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Stargazer-Sky-Observatory/1.0',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentLength = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error('Payload too large');
    }
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES || text.length > MAX_RESPONSE_BYTES) {
        throw new Error('Payload too large');
      }
      return JSON.parse(text);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamAdsb(lat, lon, radiusNm) {
  const fetchedAtMs = Date.now();
  const latStr = lat.toFixed(4);
  const lonStr = lon.toFixed(4);
  const radiusInt = Math.round(radiusNm);
  const errors = [];

  // 1. Primary: opendata.adsb.fi (rich metadata: registration, type, model, operator)
  try {
    const data = await fetchJsonWithTimeout(
      `https://opendata.adsb.fi/api/v2/lat/${latStr}/lon/${lonStr}/dist/${radiusInt}`,
    );
    const list = data && Array.isArray(data.aircraft) ? data.aircraft : data?.ac;
    if (Array.isArray(list)) {
      return {
        source: 'adsb.fi',
        fetchedAtMs,
        aircraft: normalizeReadsbList(list, fetchedAtMs),
      };
    }
    throw new Error('Malformed adsb.fi payload');
  } catch (err) {
    errors.push(`adsb.fi: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Secondary: api.adsb.lol (unfiltered community readsb network)
  try {
    const data = await fetchJsonWithTimeout(
      `https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusInt}`,
    );
    const list = data && Array.isArray(data.ac) ? data.ac : data?.aircraft;
    if (Array.isArray(list)) {
      return {
        source: 'adsb.lol',
        fetchedAtMs,
        aircraft: normalizeReadsbList(list, fetchedAtMs),
      };
    }
    throw new Error('Malformed adsb.lol payload');
  } catch (err) {
    errors.push(`adsb.lol: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Tertiary: OpenSky Network bounding box
  try {
    const radiusKm = radiusInt * NM_TO_KM;
    const latDelta = radiusKm / 111.32;
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const lonDelta = radiusKm / (111.32 * cosLat);
    const lamin = clamp(lat - latDelta, -90, 90).toFixed(4);
    const lamax = clamp(lat + latDelta, -90, 90).toFixed(4);
    const lomin = clamp(lon - lonDelta, -180, 180).toFixed(4);
    const lomax = clamp(lon + lonDelta, -180, 180).toFixed(4);

    const data = await fetchJsonWithTimeout(
      `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`,
    );
    if (data && Array.isArray(data.states)) {
      return {
        source: 'opensky',
        fetchedAtMs,
        aircraft: normalizeOpenSkyPayload(data, fetchedAtMs),
      };
    }
    throw new Error('Malformed OpenSky payload');
  } catch (err) {
    errors.push(`opensky: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new Error(`All open ADS-B providers failed (${errors.join('; ')})`);
}

async function fetchNormalizedAdsb(lat, lon, radiusNm) {
  const { key, qLat, qLon, qRad } = buildGeoBucketKey(lat, lon, radiusNm);
  const nowMs = Date.now();
  const cached = responseCache.get(key);
  if (cached && nowMs - cached.cachedAtMs < CACHE_TTL_MS) {
    return cached.payload;
  }
  if (cached) {
    responseCache.delete(key);
  }

  const inFlight = inFlightRequests.get(key);
  if (inFlight) {
    return inFlight;
  }

  const pending = fetchUpstreamAdsb(qLat, qLon, qRad)
    .then((payload) => {
      if (responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey !== undefined) {
          responseCache.delete(oldestKey);
        }
      }
      responseCache.set(key, { cachedAtMs: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, pending);
  return pending;
}

module.exports = {
  parseQueryParams,
  normalizeReadsbList,
  normalizeOpenSkyPayload,
  fetchNormalizedAdsb,
  buildGeoBucketKey,
  clearAdsbProxyCache,
};
