/** Cache geolocated reference tiles for offline scene registration. Node 22+. */
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const imagery = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
// Author-provided locations are search hints, not model-to-map transforms.
export const SEARCH_AREAS = [
  { id: 'JAX_004', lon: -81.70643392, lat: 30.35782166, source: 'https://superspl.at/scene/4bc1241b' },
  { id: 'NYC_010', lon: -73.98975925, lat: 40.734828, source: 'https://superspl.at/scene/02194cc2' },
  { id: 'JAX_164', lon: -81.66362752, lat: 30.33032475, source: 'https://superspl.at/scene/5ff93d97' },
  { id: 'JAX_175', lon: -81.63696779, lat: 30.32583707, source: 'https://superspl.at/scene/6905e63a' },
  { id: 'JAX_214', lon: -81.6635341, lat: 30.31646456, source: 'https://superspl.at/scene/e3b02d34' },
  { id: 'JAX_260', lon: -81.66350297, lat: 30.3118445, source: 'https://superspl.at/scene/5a2ccc44' },
  // Viewer IDs are from the author's project-page source. Resolve their published
  // coordinates on the host; never replace an unavailable location with a guess.
  { id: 'JAX_168', source: 'https://superspl.at/scene/a19e5552' },
  { id: 'JAX_264', source: 'https://superspl.at/scene/79d72eba' },
  { id: 'NYC_219', source: 'https://superspl.at/scene/17864442' },
  { id: 'NYC_336', lon: -74.01753397, lat: 40.71020129, source: 'https://superspl.at/scene/5aea40f2' },
];
export function selectAreas(args) {
  return (args.length ? [...new Set(args)] : SEARCH_AREAS.map((area) => area.id)).map((id) => {
    const area = SEARCH_AREAS.find((candidate) => candidate.id === id);
    if (!area) throw new Error(`Unknown reference area: ${id}. Supported: ${SEARCH_AREAS.map((area) => area.id).join(', ')}`);
    return area;
  });
}

export function parseAuthorLocation(area, html) {
  const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].find(([tag]) => /\brel=["']canonical["']/i.test(tag))?.[0];
  const canonicalUrl = canonical?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!html.includes(area.id) && canonicalUrl !== area.source) throw new Error(`${area.id}: author page does not identify this scene`);
  const text = html.replace(/\\u002c/gi, ',').replace(/\\+t/g, ' ').replace(/&(?:nbsp|#160);/g, ' ').replace(/<[^>]*>/g, ' ');
  const candidates = new Map();
  for (const match of text.matchAll(/(?:^|[^\d.])(-?\d{1,2}\.\d{4,})(?:\s*,\s*|\s+)(-?\d{1,3}\.\d{4,})(?=$|[^\d.])/g)) {
    const lat = Number(match[1]), lon = Number(match[2]);
    // Sanity checks reject unrelated page data; these ranges do not supply a location.
    const inCity = area.id.startsWith('JAX_') ? lat > 30 && lat < 31 && lon > -82 && lon < -81
      : lat > 40 && lat < 41 && lon > -75 && lon < -73;
    if (inCity) candidates.set(`${lat.toFixed(8)},${lon.toFixed(8)}`, { ...area, lon, lat });
  }
  if (candidates.size !== 1) throw new Error(`${area.id}: expected one unique author coordinate pair, found ${candidates.size}; inspect the cached author-location.html`);
  return [...candidates.values()][0];
}

export async function resolveReferenceArea(area, { directory, fetchImpl = fetch }) {
  if (Number.isFinite(area.lon) && Number.isFinite(area.lat)) return area;
  const output = join(directory, area.id);
  await mkdir(output, { recursive: true });
  const snapshot = join(output, 'author-location.html');
  let html;
  if (await exists(snapshot)) html = await readFile(snapshot, 'utf8');
  else {
    const response = await fetchImpl(area.source, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${area.id}: author page returned HTTP ${response.status}`);
    html = await response.text();
    await writeFile(snapshot, html);
  }
  return parseAuthorLocation(area, html);
}

export function planReference(area) {
  if (!Number.isFinite(area.lon) || !Number.isFinite(area.lat)) throw new Error(`${area.id}: resolve the author location before planning imagery`);
  const z = 18, n = 2 ** z, tileSize = 256, radiusMetres = 700;
  const latitude = area.lat * Math.PI / 180;
  const px = (area.lon + 180) / 360 * n * tileSize;
  const py = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * n * tileSize;
  const groundMetresPerPixel = 40075016.68557849 * Math.cos(latitude) / (n * tileSize);
  const radius = radiusMetres / groundMetresPerPixel;
  const x0 = Math.floor((px - radius) / tileSize), x1 = Math.floor((px + radius) / tileSize);
  const y0 = Math.floor((py - radius) / tileSize), y1 = Math.floor((py + radius) / tileSize);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    tiles.push({ x, y, file: `${z}-${x}-${y}.jpg`, left: (x - x0) * tileSize, top: (y - y0) * tileSize,
      url: `${imagery}/tile/${z}/${y}/${x}` });
  }
  return { scene: area.id, reference: imagery, searchHint: area, radiusMetres,
    tileOrigin: { z, x0, y0 }, width: (x1 - x0 + 1) * tileSize, height: (y1 - y0 + 1) * tileSize, tiles };
}

const exists = (path) => access(path).then(() => true, () => false);
// World Imagery serves JPEG tiles. Reject HTML/errors before caching them.
export function isJpeg(data) { return data.length > 100 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff; }

export async function captureReference(plan, { directory, fetchImpl = fetch }) {
  const output = join(directory, plan.scene);
  await mkdir(output, { recursive: true });
  const index = join(output, 'reference.json');
  // Only a fully revalidated tile set may carry a completed reference index.
  await rm(index, { force: true });
  const pending = [...plan.tiles];
  let completed = 0;
  const worker = async () => {
    while (pending.length) {
      const tile = pending.shift();
      const target = join(output, tile.file);
      if (!await exists(target) || !isJpeg(await readFile(target))) {
        const response = await fetchImpl(tile.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`${plan.scene}: tile ${tile.x}/${tile.y} returned HTTP ${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (!isJpeg(data)) throw new Error(`${plan.scene}: tile ${tile.x}/${tile.y} is not a valid JPEG response`);
        const part = `${target}.part`;
        try { await writeFile(part, data); await rename(part, target); }
        finally { await rm(part, { force: true }); }
      }
      completed++;
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, worker));
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed) throw failed.reason;
  const part = `${index}.part`;
  try {
    await writeFile(part, `${JSON.stringify({ ...plan, capturedAt: new Date().toISOString() }, null, 2)}\n`);
    await rename(part, index);
  } finally { await rm(part, { force: true }); }
  console.log(`${plan.scene}: cached ${completed} tiles in ${output}`);
}

async function main() {
  const areas = selectAreas(process.argv.slice(2));
  const cache = resolve(process.env.SKYFALL_CACHE_DIR ?? join(tmpdir(), 'terrascope-skyfall'));
  const directory = resolve(process.env.SKYFALL_REFERENCE_DIR ?? join(cache, 'reference'));
  const failures = [];
  for (const area of areas) {
    try {
      const resolved = await resolveReferenceArea(area, { directory });
      await captureReference(planReference(resolved), { directory });
    } catch (error) {
      console.error(`${area.id}: ${error.message}`, error.cause?.message ?? '');
      failures.push(area.id);
    }
  }
  if (failures.length) throw new Error(`Reference preparation incomplete for: ${failures.join(', ')}. Completed scenes are cached; retry after resolving the errors above.`);
  console.log('Reference imagery cached. Scene alignment still requires measurement and validation before enabling the models.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message, error.cause?.message ?? ''); process.exitCode = 1; });
}
