export interface ObserverLocation {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  elevation: number;
  source: 'gps' | 'preset' | 'custom';
}

const STORAGE_KEY = 'stargazer.observer.location.v1';

export const PRESET_LOCATIONS: ObserverLocation[] = [
  // Dark-Sky Observatories
  { name: 'Mauna Kea Observatory', region: 'Hawaii, USA (Dark Sky)', latitude: 19.8207, longitude: -155.4681, elevation: 4205, source: 'preset' },
  { name: 'Paranal Observatory (Atacama)', region: 'Antofagasta, Chile (Dark Sky)', latitude: -24.6272, longitude: -70.4042, elevation: 2635, source: 'preset' },
  { name: 'Roque de los Muchachos', region: 'La Palma, Spain (Dark Sky)', latitude: 28.7636, longitude: -17.8947, elevation: 2396, source: 'preset' },
  { name: 'Kitt Peak National Observatory', region: 'Arizona, USA (Dark Sky)', latitude: 31.9583, longitude: -111.5967, elevation: 2096, source: 'preset' },
  { name: 'Aoraki Mackenzie Dark Sky', region: 'Lake Tekapo, New Zealand (Dark Sky)', latitude: -43.9867, longitude: 170.4644, elevation: 1029, source: 'preset' },
  { name: 'NamibRand Nature Reserve', region: 'Hardap, Namibia (Dark Sky)', latitude: -24.9417, longitude: 15.9489, elevation: 1100, source: 'preset' },
  { name: 'Sutherland (SAAO)', region: 'Northern Cape, South Africa (Dark Sky)', latitude: -32.3783, longitude: 20.8105, elevation: 1798, source: 'preset' },
  { name: 'Cherry Springs State Park', region: 'Pennsylvania, USA (Dark Sky)', latitude: 41.6626, longitude: -77.8235, elevation: 701, source: 'preset' },

  // Major Global Cities
  { name: 'New York', region: 'New York, USA', latitude: 40.7128, longitude: -74.006, elevation: 10, source: 'preset' },
  { name: 'San Francisco', region: 'California, USA', latitude: 37.7749, longitude: -122.4194, elevation: 16, source: 'preset' },
  { name: 'Los Angeles', region: 'California, USA', latitude: 34.0522, longitude: -118.2437, elevation: 89, source: 'preset' },
  { name: 'Chicago', region: 'Illinois, USA', latitude: 41.8781, longitude: -87.6298, elevation: 182, source: 'preset' },
  { name: 'Austin', region: 'Texas, USA', latitude: 30.2672, longitude: -97.7431, elevation: 149, source: 'preset' },
  { name: 'Seattle', region: 'Washington, USA', latitude: 47.6062, longitude: -122.3321, elevation: 56, source: 'preset' },
  { name: 'Denver', region: 'Colorado, USA', latitude: 39.7392, longitude: -104.9903, elevation: 1609, source: 'preset' },
  { name: 'Toronto', region: 'Ontario, Canada', latitude: 43.6532, longitude: -79.3832, elevation: 76, source: 'preset' },
  { name: 'Vancouver', region: 'British Columbia, Canada', latitude: 49.2827, longitude: -123.1207, elevation: 2, source: 'preset' },
  { name: 'Mexico City', region: 'CDMX, Mexico', latitude: 19.4326, longitude: -99.1332, elevation: 2240, source: 'preset' },
  { name: 'São Paulo', region: 'Brazil', latitude: -23.5505, longitude: -46.6333, elevation: 760, source: 'preset' },
  { name: 'Buenos Aires', region: 'Argentina', latitude: -34.6037, longitude: -58.3816, elevation: 25, source: 'preset' },
  { name: 'Santiago', region: 'Chile', latitude: -33.4489, longitude: -70.6693, elevation: 570, source: 'preset' },
  { name: 'London', region: 'United Kingdom', latitude: 51.5074, longitude: -0.1278, elevation: 11, source: 'preset' },
  { name: 'Greenwich Royal Observatory', region: 'London, UK', latitude: 51.4769, longitude: -0.0005, elevation: 46, source: 'preset' },
  { name: 'Paris', region: 'France', latitude: 48.8566, longitude: 2.3522, elevation: 35, source: 'preset' },
  { name: 'Berlin', region: 'Germany', latitude: 52.52, longitude: 13.405, elevation: 34, source: 'preset' },
  { name: 'Madrid', region: 'Spain', latitude: 40.4168, longitude: -3.7038, elevation: 667, source: 'preset' },
  { name: 'Rome', region: 'Italy', latitude: 41.9028, longitude: 12.4964, elevation: 21, source: 'preset' },
  { name: 'Zurich', region: 'Switzerland', latitude: 47.3769, longitude: 8.5417, elevation: 408, source: 'preset' },
  { name: 'Reykjavik', region: 'Iceland', latitude: 64.1466, longitude: -21.9426, elevation: 14, source: 'preset' },
  { name: 'Tromsø', region: 'Norway (Arctic Circle)', latitude: 69.6492, longitude: 18.9553, elevation: 12, source: 'preset' },
  { name: 'Athens', region: 'Greece', latitude: 37.9838, longitude: 23.7275, elevation: 70, source: 'preset' },
  { name: 'Cairo', region: 'Egypt', latitude: 30.0444, longitude: 31.2357, elevation: 23, source: 'preset' },
  { name: 'Nairobi', region: 'Kenya (Equatorial)', latitude: -1.2921, longitude: 36.8219, elevation: 1795, source: 'preset' },
  { name: 'Cape Town', region: 'South Africa', latitude: -33.9249, longitude: 18.4241, elevation: 25, source: 'preset' },
  { name: 'Dubai', region: 'UAE', latitude: 25.2048, longitude: 55.2708, elevation: 5, source: 'preset' },
  { name: 'Mumbai', region: 'India', latitude: 19.076, longitude: 72.8777, elevation: 14, source: 'preset' },
  { name: 'Bengaluru', region: 'India', latitude: 12.9716, longitude: 77.5946, elevation: 920, source: 'preset' },
  { name: 'Singapore', region: 'Singapore (Equatorial)', latitude: 1.3521, longitude: 103.8198, elevation: 15, source: 'preset' },
  { name: 'Tokyo', region: 'Japan', latitude: 35.6762, longitude: 139.6503, elevation: 40, source: 'preset' },
  { name: 'Seoul', region: 'South Korea', latitude: 37.5665, longitude: 126.978, elevation: 38, source: 'preset' },
  { name: 'Beijing', region: 'China', latitude: 39.9042, longitude: 116.4074, elevation: 43, source: 'preset' },
  { name: 'Sydney', region: 'Australia', latitude: -33.8688, longitude: 151.2093, elevation: 19, source: 'preset' },
  { name: 'Melbourne', region: 'Australia', latitude: -37.8136, longitude: 144.9631, elevation: 31, source: 'preset' },
  { name: 'Auckland', region: 'New Zealand', latitude: -36.8485, longitude: 174.7633, elevation: 26, source: 'preset' },
];

export const DEFAULT_LOCATION: ObserverLocation = PRESET_LOCATIONS.find(
  (loc) => loc.name === 'New York',
) ?? PRESET_LOCATIONS[0];

/**
 * Loads persisted observer location from localStorage, falling back to New York.
 */
export function loadObserverLocation(): ObserverLocation {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LOCATION;
    const parsed = JSON.parse(raw) as Partial<ObserverLocation>;
    if (
      typeof parsed.latitude === 'number' &&
      typeof parsed.longitude === 'number' &&
      Number.isFinite(parsed.latitude) &&
      Number.isFinite(parsed.longitude)
    ) {
      return {
        name: parsed.name || 'Saved Site',
        region: parsed.region || 'Custom Coordinates',
        latitude: Math.max(-90, Math.min(90, parsed.latitude)),
        longitude: Math.max(-180, Math.min(180, parsed.longitude)),
        elevation: Number.isFinite(parsed.elevation) ? Number(parsed.elevation) : 0,
        source: parsed.source === 'gps' || parsed.source === 'preset' ? parsed.source : 'custom',
      };
    }
  } catch {
    // Ignore storage read errors in restricted contexts
  }
  return DEFAULT_LOCATION;
}

/**
 * Persists observer location to localStorage.
 */
export function saveObserverLocation(location: ObserverLocation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Ignore storage write errors in private/restricted contexts
  }
}

/**
 * Computes approximate great-circle angular distance (degrees) between two lat/lon pairs.
 */
function haversineDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * (180 / Math.PI);
}

/**
 * Finds the nearest curated city/observatory within ~1.5 degrees for a friendly GPS label.
 */
function matchNearestKnownSite(lat: number, lon: number): { name: string; region: string } {
  let best: ObserverLocation | null = null;
  let bestDist = Infinity;

  for (const loc of PRESET_LOCATIONS) {
    const dist = haversineDeg(lat, lon, loc.latitude, loc.longitude);
    if (dist < bestDist) {
      bestDist = dist;
      best = loc;
    }
  }

  if (best && bestDist <= 1.2) {
    return {
      name: `${best.name} (GPS)`,
      region: best.region,
    };
  }

  const latHem = lat >= 0 ? 'N' : 'S';
  const lonHem = lon >= 0 ? 'E' : 'W';
  return {
    name: `GPS ${Math.abs(lat).toFixed(2)}°${latHem}, ${Math.abs(lon).toFixed(2)}°${lonHem}`,
    region: 'Live Geolocation',
  };
}

/**
 * Detects observer coordinates via navigator.geolocation with graceful error messaging.
 */
export function detectGpsLocation(timeoutMs = 8000): Promise<ObserverLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('Geolocation API is unavailable in this browser.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = Number(position.coords.latitude.toFixed(4));
        const longitude = Number(position.coords.longitude.toFixed(4));
        const elevation = Number.isFinite(position.coords.altitude) && position.coords.altitude !== null
          ? Math.round(position.coords.altitude)
          : 0;
        const label = matchNearestKnownSite(latitude, longitude);
        resolve({
          name: label.name,
          region: label.region,
          latitude,
          longitude,
          elevation,
          source: 'gps',
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error('Location permission denied — pick a city or enter coordinates.'));
        } else if (err.code === err.TIMEOUT) {
          reject(new Error('GPS fix timed out — pick a city or enter coordinates.'));
        } else {
          reject(new Error('Unable to determine GPS position — pick a city or enter coordinates.'));
        }
      },
      {
        enableHighAccuracy: false,
        timeout: timeoutMs,
        maximumAge: 300_000,
      },
    );
  });
}

/**
 * Filters curated cities and observatories by name or region substring.
 */
export function searchPresetLocations(query: string): ObserverLocation[] {
  const q = query.trim().toLowerCase();
  if (!q) return PRESET_LOCATIONS;
  return PRESET_LOCATIONS.filter(
    (loc) => loc.name.toLowerCase().includes(q) || loc.region.toLowerCase().includes(q),
  );
}
