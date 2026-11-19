export interface ParsedSkyUrlState {
  lat?: number;
  lon?: number;
  elev?: number;
  name?: string;
  timestampMs?: number;
  azDeg?: number;
  altDeg?: number;
  fovDeg?: number;
  bortleClass?: number;
  target?: string;
}

export interface SkyShareableState {
  lat: number;
  lon: number;
  timestampMs: number;
  azDeg: number;
  altDeg: number;
  fovDeg: number;
  bortleClass: number;
  target?: string;
}

function parseFiniteInRange(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < min || num > max) return undefined;
  return num;
}

/**
 * Safely parses shareable observatory deep-link query parameters with strict bounds validation.
 */
export function parseSkyUrlParams(search: string): ParsedSkyUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const result: ParsedSkyUrlState = {};

  const lat = parseFiniteInRange(params.get('lat'), -90, 90);
  const lon = parseFiniteInRange(params.get('lon'), -180, 180);
  if (lat !== undefined && lon !== undefined) {
    result.lat = lat;
    result.lon = lon;
  }

  const elev = parseFiniteInRange(params.get('elev'), -500, 9000);
  if (elev !== undefined) {
    result.elev = Math.round(elev);
  }

  const rawName = params.get('name');
  if (rawName && rawName.trim().length > 0) {
    result.name = rawName.trim().slice(0, 64);
  }

  const rawTime = params.get('t');
  if (rawTime && rawTime.trim().length > 0) {
    const trimmed = rawTime.trim();
    const asNumber = Number(trimmed);
    const parsedMs = Number.isFinite(asNumber) && /^\d+$/.test(trimmed)
      ? asNumber
      : Date.parse(trimmed);
    if (Number.isFinite(parsedMs) && parsedMs > -8.64e15 && parsedMs < 8.64e15) {
      result.timestampMs = parsedMs;
    }
  }

  const az = parseFiniteInRange(params.get('az'), 0, 360);
  if (az !== undefined) {
    result.azDeg = az === 360 ? 0 : az;
  }

  const alt = parseFiniteInRange(params.get('alt'), -80, 89.5);
  if (alt !== undefined) {
    result.altDeg = alt;
  }

  const fov = parseFiniteInRange(params.get('fov'), 10, 120);
  if (fov !== undefined) {
    result.fovDeg = fov;
  }

  const bortle = parseFiniteInRange(params.get('bortle'), 1, 9);
  if (bortle !== undefined) {
    result.bortleClass = Math.round(bortle);
  }

  const rawTarget = params.get('target');
  if (rawTarget && rawTarget.trim().length > 0) {
    result.target = rawTarget.trim().slice(0, 64);
  }

  return result;
}

/**
 * Serializes the current observer, sky clock, camera look, Bortle class, and optional target into a shareable URL.
 */
export function buildSkyShareUrl(baseHref: string, state: SkyShareableState): string {
  const url = new URL(baseHref);
  url.search = '';
  url.searchParams.set('lat', state.lat.toFixed(4));
  url.searchParams.set('lon', state.lon.toFixed(4));
  url.searchParams.set('t', new Date(state.timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  url.searchParams.set('az', state.azDeg.toFixed(1));
  url.searchParams.set('alt', state.altDeg.toFixed(1));
  url.searchParams.set('fov', String(Math.round(state.fovDeg)));
  url.searchParams.set('bortle', String(Math.max(1, Math.min(9, Math.round(state.bortleClass)))));
  if (state.target && state.target.trim().length > 0) {
    url.searchParams.set('target', state.target.trim().slice(0, 64));
  }
  return url.toString();
}
