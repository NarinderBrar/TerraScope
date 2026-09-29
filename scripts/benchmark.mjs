const base = (process.env.TERRASCOPE_API_BASE ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const query = {
  bbox: [-121.5, 38.0, -121.2, 38.2],
  start: '2024-06-01T00:00:00Z',
  end: '2024-07-31T23:59:59Z',
  maxCloudCover: 30,
  limit: 10,
};

const timed = async (name, fn) => {
  const started = performance.now();
  const value = await fn();
  return { name, ms: performance.now() - started, value };
};

const searched = await timed('search', async () => {
  const response = await fetch(`${base}/api/scenes/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
  });
  if (!response.ok) throw new Error(`search failed: ${response.status} ${await response.text()}`);
  return response.json();
});
const scene = searched.value.scenes[0];
if (!scene) throw new Error('fixed query returned no supported scenes');
const z = 13;
const lon = (query.bbox[0] + query.bbox[2]) / 2;
const lat = (query.bbox[1] + query.bbox[3]) / 2;
const n = 2 ** z;
const x = Math.floor(((lon + 180) / 360) * n);
const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
const tileUrl = `${base}/api/tiles/${encodeURIComponent(scene.collection)}/${encodeURIComponent(scene.id)}/${z}/${x}/${y}?profile=rgbn&qualityMask=true`;
const fetchTile = () => timed('tile', async () => {
  const response = await fetch(tileUrl);
  if (!response.ok) throw new Error(`tile failed: ${response.status} ${await response.text()}`);
  const bytes = (await response.arrayBuffer()).byteLength;
  return { bytes, cache: response.headers.get('x-terrascope-cache') ?? 'origin' };
});
const cold = await fetchTile();
const warm = await fetchTile();
console.log(JSON.stringify({
  revision: process.env.TERRASCOPE_REVISION ?? 'working-tree',
  scene: { id: scene.id, datetime: scene.datetime },
  tile: { z, x, y },
  searchMs: Number(searched.ms.toFixed(2)),
  coldTileMs: Number(cold.ms.toFixed(2)), warmTileMs: Number(warm.ms.toFixed(2)),
  bytes: cold.value.bytes, coldCache: cold.value.cache, warmCache: warm.value.cache,
}, null, 2));
