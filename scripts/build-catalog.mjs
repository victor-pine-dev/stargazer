import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(ROOT_DIR, 'public/data');

const BASE_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data';
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

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const [starsGeo, starNamesRaw, constMetaGeo, constLinesGeo, constBoundsGeo] = await Promise.all([
    fetchJson('stars.8.json'),
    fetchJson('starnames.json'),
    fetchJson('constellations.json'),
    fetchJson('constellations.lines.json'),
    fetchJson('constellations.bounds.json'),
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

  const starsBinPath = resolve(OUTPUT_DIR, 'stars.bin');
  const starsUint8 = new Uint8Array(starBuffer);
  await writeFile(starsBinPath, starsUint8);
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

  const starNamesPath = resolve(OUTPUT_DIR, 'star-names.json');
  await writeFile(starNamesPath, JSON.stringify(starNamesIndex));

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
  const constellationsPath = resolve(OUTPUT_DIR, 'constellations.json');
  await writeFile(constellationsPath, JSON.stringify(constellations));

  console.log(`Generated ${parsedStars.length} stars -> public/data/stars.bin (${(starsUint8.byteLength / 1024).toFixed(1)} KB raw, ${(starsGzSize / 1024).toFixed(1)} KB gzipped)`);
  console.log(`Generated ${Object.keys(starNamesIndex).length} named/bright stars -> public/data/star-names.json`);
  console.log(`Generated ${constellations.length} IAU constellations -> public/data/constellations.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
