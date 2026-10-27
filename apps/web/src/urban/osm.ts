import { geographicToModel } from '../data/splatGeoreference';
import type { SplatSceneMeta } from '../data/splatScenes';
import type { UrbanData, UrbanFeature } from './types';

interface Element {
  type: string; id: number; lat?: number; lon?: number;
  geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>;
}
const cache = new Map<string, UrbanData>();
export function parseOsm(elements: Element[], scene: SplatSceneMeta): UrbanData {
  const features: UrbanFeature[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const kind: UrbanFeature['kind'] | undefined = t.building ? 'building'
      : t.natural === 'tree' ? 'tree' : t.highway === 'bus_stop' || t.public_transport === 'platform' ? 'bus-stop'
      : t.highway === 'crossing' ? 'crossing' : t.highway === 'traffic_signals' ? 'signal'
      : e.type === 'way' && t.highway ? 'road' : undefined;
    if (!kind) continue;
    const geo = e.geometry ?? (e.lon !== undefined && e.lat !== undefined ? [{ lon: e.lon, lat: e.lat }] : []);
    if (!geo.length || (kind === 'road' && geo.length < 2) || (kind === 'building' && geo.length < 4)) continue;
    const taggedHeight = /^\d+(\.\d+)?(\s*m)?$/.test(t.height ?? '') ? parseFloat(t.height) : NaN;
    const levels = Number(t['building:levels']);
    features.push({ id: `${e.type}/${e.id}`, kind, name: t.name || t.ref || `${kind} ${e.id}`,
      points: geo.map(p => geographicToModel(scene.georeference, p.lon, p.lat)), tags: t,
      height: Number.isFinite(taggedHeight) && taggedHeight > 0 ? taggedHeight
        : kind === 'building' ? (levels > 0 ? levels * 3 : 9) : kind === 'tree' ? 8 : 0,
      heightAssumed: !(Number.isFinite(taggedHeight) && taggedHeight > 0),
    });
  }
  return { features, sceneId: scene.id, fetchedAt: new Date().toISOString() };
}

export async function loadUrbanData(scene: SplatSceneMeta, signal: AbortSignal): Promise<UrbanData> {
  const cached = cache.get(scene.id);
  if (cached) return cached;
  const b = scene.bounds, bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const query = `[out:json][timeout:35];(way["highway"](${bbox});way["building"](${bbox});node["natural"="tree"](${bbox});node["highway"~"bus_stop|crossing|traffic_signals"](${bbox});nwr["public_transport"="platform"](${bbox}););out geom;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', body: new URLSearchParams({ data: query }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
  });
  if (!response.ok) throw new Error(`OpenStreetMap request failed (${response.status}). Retry shortly.`);
  const json = await response.json() as { elements?: Element[]; remark?: string };
  if (json.remark) throw new Error(`OpenStreetMap returned incomplete data: ${json.remark}`);
  if (!Array.isArray(json.elements)) throw new Error('OpenStreetMap returned invalid data.');
  const result = parseOsm(json.elements, scene);
  if (!result.features.length) throw new Error('No mapped urban features were returned for this footprint.');
  cache.set(scene.id, result);
  return result;
}
