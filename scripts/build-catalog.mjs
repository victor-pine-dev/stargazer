import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT_DIR, 'public/data');

const D3_CELESTIAL_REF = process.env.D3_CELESTIAL_REF || 'master';
const BASE_URL = `https://raw.githubusercontent.com/ofrohn/d3-celestial/${D3_CELESTIAL_REF}/data`;
const MAX_MAGNITUDE = 8.0; // Includes all ~41,411 stars from stars.8.json (< 450 KB gzipped)
const DEG_TO_RAD = Math.PI / 180;

function normalizeRaRad(raDeg) {
  const deg = ((raDeg % 360) + 360) % 360;
  return deg * DEG_TO_RAD;
}

function decToRad(decDeg) {
  return decDeg * DEG_TO_RAD;
}

async function fetchJson(filename) {
  const url = `${BASE_URL}/${filename}`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function convertMultiLineString(coords) {
  return coords.map((polyline) =>
    polyline.map(([raDeg, decDeg]) => [normalizeRaRad(raDeg), decToRad(decDeg)]),
  );
}

function convertPolygonRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map((ring) =>
      ring.map(([raDeg, decDeg]) => [normalizeRaRad(raDeg), decToRad(decDeg)]),
    );
  }
  if (geometry.type === 'MultiPolygon') {
    const rings = [];
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        rings.push(ring.map(([raDeg, decDeg]) => [normalizeRaRad(raDeg), decToRad(decDeg)]));
      }
    }
    return rings;
  }
  return [];
}

function normalizeDsoMorphology(rawType) {
  switch (String(rawType || '').toLowerCase()) {
    case 's':
    case 'e':
    case 'i':
    case 's0':
    case 'sd':
    case 'g':
    case 'gg':
    case 'galaxy':
      return 'galaxy';
    case 'pn':
    case 'planetary_nebula':
      return 'planetary_nebula';
    case 'gc':
    case 'globular_cluster':
      return 'globular_cluster';
    case 'oc':
    case 'pos':
    case 'open_cluster':
      return 'open_cluster';
    default:
      return 'nebula';
  }
}

function parseDsoDimensions(dimStr, fallbackMajor = 5) {
  const clean = String(dimStr || '').trim();
  if (!clean) return [fallbackMajor, fallbackMajor];
  const parts = clean.split(/[x×]/i).map((v) => Number.parseFloat(v));
  const major = Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : fallbackMajor;
  const minor = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : major;
  return [Number(major.toFixed(2)), Number(minor.toFixed(2))];
}

// Complete Patrick Moore Caldwell Catalog (C1-C109) with J2000 coordinates,
// fallback photometric magnitudes/sizes, morphological classes, and common names.
const CALDWELL_CATALOG = [
  [1, 'NGC 188', '', 'open_cluster', 8.1, 15, 12.108, 85.255],
  [2, 'NGC 40', 'Bow-Tie Nebula', 'planetary_nebula', 10.7, 0.63, 3.254, 72.522],
  [3, 'NGC 4236', '', 'galaxy', 9.6, 21.9, 184.175, 69.463],
  [4, 'NGC 7023', 'Iris Nebula', 'nebula', 6.8, 10, 315.404, 68.163],
  [5, 'IC 342', 'Hidden Galaxy', 'galaxy', 9.1, 21.4, 56.702, 68.096],
  [6, 'NGC 6543', "Cat's Eye Nebula", 'planetary_nebula', 8.1, 0.35, 269.639, 66.633],
  [7, 'NGC 2403', '', 'galaxy', 8.4, 21.9, 114.214, 65.603],
  [8, 'NGC 559', '', 'open_cluster', 9.5, 4.4, 22.383, 63.302],
  [9, 'Sh2-155', 'Cave Nebula', 'nebula', 7.7, 50, 344.2, 62.617],
  [10, 'NGC 663', '', 'open_cluster', 7.1, 16, 26.5, 61.233],
  [11, 'NGC 7635', 'Bubble Nebula', 'nebula', 10.0, 15, 350.192, 61.202],
  [12, 'NGC 6946', 'Fireworks Galaxy', 'galaxy', 8.8, 11.5, 308.718, 60.154],
  [13, 'NGC 457', 'Owl Cluster', 'open_cluster', 6.4, 20, 19.896, 58.287],
  [14, 'NGC 869', 'Double Cluster', 'open_cluster', 3.8, 30, 34.75, 57.128],
  [15, 'NGC 6826', 'Blinking Planetary', 'planetary_nebula', 8.8, 0.45, 296.201, 50.525],
  [16, 'NGC 7243', '', 'open_cluster', 6.4, 21, 333.821, 49.883],
  [17, 'NGC 147', '', 'galaxy', 9.5, 13.2, 8.3, 48.508],
  [18, 'NGC 185', '', 'galaxy', 9.2, 11.7, 9.742, 48.338],
  [19, 'IC 5146', 'Cocoon Nebula', 'nebula', 7.2, 12, 328.375, 47.267],
  [20, 'NGC 7000', 'North America Nebula', 'nebula', 4.0, 120, 314.683, 44.33],
  [21, 'NGC 4449', '', 'galaxy', 9.6, 6.2, 187.046, 44.094],
  [22, 'NGC 7662', 'Blue Snowball Nebula', 'planetary_nebula', 8.3, 0.5, 351.474, 42.535],
  [23, 'NGC 891', 'Silver Sliver Galaxy', 'galaxy', 9.9, 13.5, 35.639, 42.349],
  [24, 'NGC 1275', 'Perseus A', 'galaxy', 11.6, 2.2, 49.951, 41.512],
  [25, 'NGC 2419', 'Intergalactic Wanderer', 'globular_cluster', 10.3, 4.1, 114.535, 38.882],
  [26, 'NGC 4244', 'Silver Needle Galaxy', 'galaxy', 10.4, 16.6, 184.374, 37.807],
  [27, 'NGC 6888', 'Crescent Nebula', 'nebula', 7.4, 18, 303.027, 38.356],
  [28, 'NGC 752', '', 'open_cluster', 5.7, 50, 29.421, 37.785],
  [29, 'NGC 5005', '', 'galaxy', 9.8, 5.8, 197.735, 37.059],
  [30, 'NGC 7331', 'Deer Lick Galaxy', 'galaxy', 9.5, 10.5, 339.267, 34.416],
  [31, 'IC 405', 'Flaming Star Nebula', 'nebula', 6.0, 50, 79.35, 34.38],
  [32, 'NGC 4631', 'Whale Galaxy', 'galaxy', 9.2, 15.5, 190.533, 32.542],
  [33, 'NGC 6992', 'Eastern Veil Nebula', 'nebula', 7.0, 60, 314.1, 31.717],
  [34, 'NGC 6960', 'Western Veil Nebula', 'nebula', 7.0, 70, 311.4, 30.717],
  [35, 'NGC 4889', 'Coma B', 'galaxy', 11.4, 2.9, 195.034, 27.977],
  [36, 'NGC 4559', 'Koi Fish Galaxy', 'galaxy', 10.0, 10.7, 188.99, 27.959],
  [37, 'NGC 6885', '', 'open_cluster', 8.1, 7, 303.008, 26.483],
  [38, 'NGC 4565', 'Needle Galaxy', 'galaxy', 9.6, 15.9, 189.087, 25.988],
  [39, 'NGC 2392', 'Eskimo Nebula', 'planetary_nebula', 9.1, 0.78, 112.295, 20.912],
  [40, 'NGC 3626', '', 'galaxy', 11.0, 2.7, 170.016, 18.357],
  [41, 'Mel 25', 'Hyades', 'open_cluster', 0.5, 330, 66.75, 16.0],
  [42, 'NGC 7006', '', 'globular_cluster', 10.6, 2.8, 315.372, 16.187],
  [43, 'NGC 7814', 'Little Sombrero', 'galaxy', 10.6, 5.5, 0.812, 16.145],
  [44, 'NGC 7479', 'Superman Galaxy', 'galaxy', 10.8, 4.1, 346.236, 12.323],
  [45, 'NGC 5248', '', 'galaxy', 10.3, 6.2, 204.383, 8.885],
  [46, 'NGC 2261', "Hubble's Variable Nebula", 'nebula', 9.0, 2.0, 99.792, 8.742],
  [47, 'NGC 6934', '', 'globular_cluster', 8.9, 5.9, 308.547, 7.404],
  [48, 'NGC 2775', '', 'galaxy', 10.1, 4.3, 137.584, 7.038],
  [49, 'NGC 2238', 'Rosette Nebula', 'nebula', 9.0, 80, 97.62, 5.05],
  [50, 'NGC 2244', 'Satellite Cluster', 'open_cluster', 4.8, 24, 97.979, 4.942],
  [51, 'IC 1613', '', 'galaxy', 9.2, 16.2, 16.199, 2.118],
  [52, 'NGC 4697', '', 'galaxy', 9.2, 7.2, 192.149, -5.801],
  [53, 'NGC 3115', 'Spindle Galaxy', 'galaxy', 8.9, 7.2, 151.308, -7.719],
  [54, 'NGC 2506', '', 'open_cluster', 7.6, 7, 120.008, -10.77],
  [55, 'NGC 7009', 'Saturn Nebula', 'planetary_nebula', 8.0, 0.68, 316.045, -11.363],
  [56, 'NGC 246', 'Skull Nebula', 'planetary_nebula', 10.9, 4.1, 11.764, -11.872],
  [57, 'NGC 6822', "Barnard's Galaxy", 'galaxy', 8.8, 15.5, 296.24, -14.803],
  [58, 'NGC 2360', "Caroline's Cluster", 'open_cluster', 7.2, 12, 109.433, -15.63],
  [59, 'NGC 3242', 'Ghost of Jupiter', 'planetary_nebula', 7.7, 0.67, 156.192, -18.642],
  [60, 'NGC 4038', 'Antennae Galaxies', 'galaxy', 10.3, 5.2, 180.47, -18.867],
  [61, 'NGC 4039', 'Antennae Galaxies B', 'galaxy', 10.6, 3.1, 180.473, -18.886],
  [62, 'NGC 247', '', 'galaxy', 9.2, 21.4, 11.786, -20.76],
  [63, 'NGC 7293', 'Helix Nebula', 'planetary_nebula', 7.3, 16, 337.411, -20.837],
  [64, 'NGC 2362', 'Tau Canis Majoris Cluster', 'open_cluster', 4.1, 8, 109.675, -24.95],
  [65, 'NGC 253', 'Sculptor Galaxy', 'galaxy', 7.1, 27.5, 11.888, -25.288],
  [66, 'NGC 5694', '', 'globular_cluster', 10.2, 3.6, 219.902, -26.539],
  [67, 'NGC 1097', '', 'galaxy', 9.2, 9.3, 41.579, -30.275],
  [68, 'NGC 6729', 'R Coronae Australis Nebula', 'nebula', 9.5, 25, 285.475, -36.953],
  [69, 'NGC 6302', 'Bug Nebula', 'planetary_nebula', 9.6, 1.5, 258.435, -37.103],
  [70, 'NGC 300', '', 'galaxy', 8.1, 21.9, 13.723, -37.684],
  [71, 'NGC 2477', '', 'open_cluster', 5.8, 27, 118.046, -38.53],
  [72, 'NGC 55', 'String of Pearls Galaxy', 'galaxy', 7.9, 32.4, 3.723, -39.197],
  [73, 'NGC 1851', '', 'globular_cluster', 7.1, 11, 78.528, -40.047],
  [74, 'NGC 3132', 'Eight-Burst Nebula', 'planetary_nebula', 9.2, 0.9, 151.757, -40.436],
  [75, 'NGC 6124', '', 'open_cluster', 5.8, 29, 246.396, -40.667],
  [76, 'NGC 6231', 'Northern Jewel Box', 'open_cluster', 2.6, 15, 253.542, -41.825],
  [77, 'NGC 5128', 'Centaurus A', 'galaxy', 6.8, 25.7, 201.365, -43.019],
  [78, 'NGC 6541', '', 'globular_cluster', 6.3, 13.1, 272.01, -43.715],
  [79, 'NGC 3201', '', 'globular_cluster', 6.8, 18.2, 154.403, -46.412],
  [80, 'NGC 5139', 'Omega Centauri', 'globular_cluster', 3.9, 55, 201.697, -47.479],
  [81, 'NGC 6352', '', 'globular_cluster', 8.0, 7.1, 261.371, -48.422],
  [82, 'NGC 6193', '', 'open_cluster', 5.2, 15, 250.333, -48.764],
  [83, 'NGC 4945', '', 'galaxy', 8.8, 20, 196.364, -49.468],
  [84, 'NGC 5286', '', 'globular_cluster', 7.4, 9.1, 206.612, -51.374],
  [85, 'IC 2391', 'Omicron Velorum Cluster', 'open_cluster', 2.5, 50, 130.133, -53.033],
  [86, 'NGC 6397', '', 'globular_cluster', 5.7, 25.7, 265.175, -53.674],
  [87, 'NGC 1261', '', 'globular_cluster', 8.3, 6.9, 48.068, -55.216],
  [88, 'NGC 5823', '', 'open_cluster', 7.9, 10, 226.404, -55.603],
  [89, 'NGC 6087', 'S Normae Cluster', 'open_cluster', 5.4, 12, 244.708, -57.902],
  [90, 'NGC 2867', '', 'planetary_nebula', 9.7, 0.23, 140.356, -58.311],
  [91, 'NGC 3532', 'Wishing Well Cluster', 'open_cluster', 3.0, 55, 166.446, -58.753],
  [92, 'NGC 3372', 'Eta Carinae Nebula', 'nebula', 1.0, 120, 161.265, -59.868],
  [93, 'NGC 6752', 'Great Peacock Globular', 'globular_cluster', 5.4, 20.4, 287.717, -59.985],
  [94, 'NGC 4755', 'Jewel Box', 'open_cluster', 4.2, 10, 193.413, -60.362],
  [95, 'NGC 6025', '', 'open_cluster', 5.1, 12, 240.821, -60.498],
  [96, 'NGC 2516', 'Southern Beehive', 'open_cluster', 3.8, 30, 119.517, -60.867],
  [97, 'NGC 3766', 'Pearl Cluster', 'open_cluster', 5.3, 12, 174.063, -61.615],
  [98, 'NGC 4609', '', 'open_cluster', 6.9, 5, 190.579, -62.995],
  [99, 'Coalsack', 'Coalsack Nebula', 'nebula', 3.5, 400, 193.25, -63.0],
  [100, 'IC 2944', 'Running Chicken Nebula', 'nebula', 4.5, 75, 173.95, -63.367],
  [101, 'NGC 6744', '', 'galaxy', 8.3, 20, 287.442, -63.857],
  [102, 'IC 2602', 'Southern Pleiades', 'open_cluster', 1.9, 50, 160.742, -64.395],
  [103, 'NGC 2070', 'Tarantula Nebula', 'nebula', 8.0, 40, 84.677, -69.101],
  [104, 'NGC 362', '', 'globular_cluster', 6.4, 12.9, 15.809, -70.849],
  [105, 'NGC 4833', '', 'globular_cluster', 7.0, 13.5, 194.891, -70.876],
  [106, 'NGC 104', '47 Tucanae', 'globular_cluster', 4.0, 30.9, 6.024, -72.081],
  [107, 'NGC 6101', '', 'globular_cluster', 9.2, 10.7, 246.45, -72.202],
  [108, 'NGC 4372', '', 'globular_cluster', 7.2, 18.6, 186.439, -72.659],
  [109, 'NGC 3195', '', 'planetary_nebula', 11.6, 0.7, 152.337, -80.858],
];

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const [starsGeo, starNamesRaw, constMetaGeo, constLinesGeo, constBoundsGeo, messierGeo, dsos14Geo, dsosBrightGeo] = await Promise.all([
    fetchJson('stars.8.json'),
    fetchJson('starnames.json'),
    fetchJson('constellations.json'),
    fetchJson('constellations.lines.json'),
    fetchJson('constellations.bounds.json'),
    fetchJson('messier.json'),
    fetchJson('dsos.14.json'),
    fetchJson('dsos.bright.json'),
  ]);

  // 1. Build sorted binary star pack (Float32 little-endian, 5 floats = 20 bytes per star)
  // Layout: [RA_rad, Dec_rad, Vmag, BV_color, HIP_id]
  const parsedStars = [];
  for (const feature of starsGeo.features) {
    const mag = Number(feature.properties?.mag);
    if (!Number.isFinite(mag) || mag > MAX_MAGNITUDE) continue;

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const raRad = normalizeRaRad(Number(coords[0]));
    const decRad = decToRad(Number(coords[1]));
    const rawBv = feature.properties?.bv;
    const bv = rawBv !== '' && rawBv !== null && rawBv !== undefined && Number.isFinite(Number(rawBv))
      ? Number(rawBv)
      : 0.65;
    const hip = Number(feature.id) || 0;

    parsedStars.push({ raRad, decRad, mag, bv, hip });
  }

  if (parsedStars.length < 30000) {
    throw new Error(`Refusing to write catalog: expected >= 30000 stars, got ${parsedStars.length}`);
  }

  // Sort brightest-first so GPU draw order and LOD truncation always prioritize bright stars
  parsedStars.sort((a, b) => a.mag - b.mag);

  const floatsPerStar = 5;
  const starBuffer = new ArrayBuffer(parsedStars.length * floatsPerStar * 4);
  const view = new DataView(starBuffer);
  const starLookupByHip = new Map();

  for (let i = 0; i < parsedStars.length; i++) {
    const s = parsedStars[i];
    const byteOffset = i * floatsPerStar * 4;
    view.setFloat32(byteOffset + 0, s.raRad, true);
    view.setFloat32(byteOffset + 4, s.decRad, true);
    view.setFloat32(byteOffset + 8, s.mag, true);
    view.setFloat32(byteOffset + 12, s.bv, true);
    view.setFloat32(byteOffset + 16, s.hip, true);
    if (s.hip > 0) {
      starLookupByHip.set(s.hip, s);
    }
  }

  const starsUint8 = new Uint8Array(starBuffer);
  const starsGzSize = gzipSync(starsUint8).byteLength;

  // 2. Build star names index for IAU proper names + bright navigational stars (Vmag <= 4.0)
  const starNamesIndex = {};
  for (const [hipKey, s] of starLookupByHip.entries()) {
    const meta = starNamesRaw[String(hipKey)];
    const properName = meta?.name ? String(meta.name).trim() : '';
    const bayer = meta?.bayer ? String(meta.bayer).trim() : '';
    const flam = meta?.flam ? String(meta.flam).trim() : '';
    const constellation = meta?.c ? String(meta.c).trim() : '';

    if (properName.length > 0 || s.mag <= 4.0) {
      starNamesIndex[String(hipKey)] = {
        hip: hipKey,
        name: properName,
        bayer,
        flam,
        const: constellation,
        mag: Number(s.mag.toFixed(2)),
        bv: Number(s.bv.toFixed(3)),
        raRad: Number(s.raRad.toFixed(6)),
        decRad: Number(s.decRad.toFixed(6)),
      };
    }
  }

  // 3. Build 88 IAU Constellations dataset (merging split Serpens Caput / Cauda under 'Ser')
  const constMap = new Map();

  for (let i = 0; i < constMetaGeo.features.length; i++) {
    const metaFeature = constMetaGeo.features[i];
    const linesFeature = constLinesGeo.features[i];
    const boundsFeature = constBoundsGeo.features[i];

    const id = String(metaFeature.id);
    if (linesFeature?.id !== id || boundsFeature?.id !== id) {
      throw new Error(`Constellation feature index mismatch at ${i}: ${id}`);
    }

    const props = metaFeature.properties ?? {};
    const labelCoords = metaFeature.geometry?.coordinates ?? [0, 0];
    const lines = convertMultiLineString(linesFeature.geometry?.coordinates ?? []);
    const bounds = convertPolygonRings(boundsFeature.geometry);

    if (constMap.has(id)) {
      const existing = constMap.get(id);
      existing.name = id === 'Ser' ? 'Serpens' : existing.name;
      existing.lines.push(...lines);
      existing.bounds.push(...bounds);
    } else {
      constMap.set(id, {
        id,
        name: String(props.en || props.name || id),
        genitive: String(props.gen || ''),
        rank: Number(props.rank) || 3,
        labelRaRad: Number(normalizeRaRad(Number(labelCoords[0])).toFixed(6)),
        labelDecRad: Number(decToRad(Number(labelCoords[1])).toFixed(6)),
        lines,
        bounds,
      });
    }
  }

  const constellations = Array.from(constMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (constellations.length !== 88) {
    throw new Error(`Refusing to write catalog: expected 88 constellations, got ${constellations.length}`);
  }

  // 4. Build Deep Sky Objects (Messier M1-M110 + Caldwell C1-C109 = 219 objects) -> public/data/dso.json
  const dsoLookup = new Map();
  for (const feature of [...(dsos14Geo.features ?? []), ...(dsosBrightGeo.features ?? [])]) {
    for (const rawKey of [feature.id, feature.properties?.desig]) {
      const norm = String(rawKey || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (norm) {
        dsoLookup.set(norm, feature);
      }
    }
  }

  const dsoRecords = [];

  for (const feature of messierGeo.features ?? []) {
    const id = String(feature.id || feature.properties?.name || '').trim();
    const props = feature.properties ?? {};
    const coords = feature.geometry?.coordinates ?? [0, 0];
    const catalogNumber = Number.parseInt(id.replace(/^M/i, ''), 10) || 0;
    const rawType = String(props.type || '');
    const mag = Number.isFinite(Number(props.mag)) && Number(props.mag) < 99 ? Number(props.mag) : 8.5;
    const [sizeArcmin, minorArcmin] = parseDsoDimensions(props.dim, 2);
    const ngc = String(props.desig || '').trim();
    const altName = String(props.alt || '').trim();

    dsoRecords.push({
      id,
      catalog: 'Messier',
      catalogNumber,
      ngc: ngc || id,
      name: altName || ngc || id,
      type: normalizeDsoMorphology(rawType),
      rawType,
      mag: Number(mag.toFixed(2)),
      sizeArcmin,
      minorArcmin,
      raRad: Number(normalizeRaRad(Number(coords[0])).toFixed(6)),
      decRad: Number(decToRad(Number(coords[1])).toFixed(6)),
    });
  }

  for (const [caldwellNumber, ngc, commonName, fallbackType, fallbackMag, fallbackSize, fallbackRaDeg, fallbackDecDeg] of CALDWELL_CATALOG) {
    const id = `C${caldwellNumber}`;
    const match = dsoLookup.get(ngc.toUpperCase().replace(/\s+/g, ' ').trim());
    const props = match?.properties ?? {};
    const coords = match?.geometry?.coordinates;

    const rawMag = Number(props.mag);
    const mag = Number.isFinite(rawMag) && rawMag < 99 ? rawMag : fallbackMag;
    const [sizeArcmin, minorArcmin] = parseDsoDimensions(props.dim, fallbackSize);
    const rawType = String(props.type || fallbackType);
    const raDeg = Array.isArray(coords) && Number.isFinite(Number(coords[0])) ? Number(coords[0]) : fallbackRaDeg;
    const decDeg = Array.isArray(coords) && Number.isFinite(Number(coords[1])) ? Number(coords[1]) : fallbackDecDeg;

    dsoRecords.push({
      id,
      catalog: 'Caldwell',
      catalogNumber: caldwellNumber,
      ngc,
      name: commonName || ngc,
      type: normalizeDsoMorphology(props.type ? rawType : fallbackType),
      rawType,
      mag: Number(mag.toFixed(2)),
      sizeArcmin,
      minorArcmin,
      raRad: Number(normalizeRaRad(raDeg).toFixed(6)),
      decRad: Number(decToRad(decDeg).toFixed(6)),
    });
  }

  if (dsoRecords.length < 200) {
    throw new Error(`Refusing to write catalog: expected >= 200 DSOs, got ${dsoRecords.length}`);
  }

  dsoRecords.sort((a, b) => a.mag - b.mag);

  await Promise.all([
    writeFile(resolve(OUTPUT_DIR, 'stars.bin'), starsUint8),
    writeFile(resolve(OUTPUT_DIR, 'star-names.json'), JSON.stringify(starNamesIndex)),
    writeFile(resolve(OUTPUT_DIR, 'constellations.json'), JSON.stringify(constellations)),
    writeFile(resolve(OUTPUT_DIR, 'dso.json'), JSON.stringify(dsoRecords)),
  ]);

  console.log(`Generated ${parsedStars.length} stars -> public/data/stars.bin (${(starsUint8.byteLength / 1024).toFixed(1)} KB raw, ${(starsGzSize / 1024).toFixed(1)} KB gzipped)`);
  console.log(`Generated ${Object.keys(starNamesIndex).length} named/bright stars -> public/data/star-names.json`);
  console.log(`Generated ${constellations.length} IAU constellations -> public/data/constellations.json`);
  console.log(`Generated ${dsoRecords.length} Deep Sky Objects (Messier + Caldwell) -> public/data/dso.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
