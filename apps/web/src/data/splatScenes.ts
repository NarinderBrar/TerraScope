import { modelToGeographic, type SplatGeoreference } from './splatGeoreference';
import { screenToLonLat, type CameraState, type Viewport } from '../map/MapCamera';

export interface GeoBounds { west: number; south: number; east: number; north: number }
export interface ScreenPoint { x: number; y: number }
export interface SplatSceneMeta {
  id: string;
  name: string;
  city: 'JAX' | 'NYC';
  bounds: GeoBounds;
  center: { lon: number; lat: number };
  splatUrl: string;
  georeference: SplatGeoreference;
  upVector: [number, number, number];
}

const splatBase = (import.meta.env.VITE_SPLAT_BASE_URL || `${import.meta.env.BASE_URL}splats`).replace(/\/$/, '');

// Measured against reference aerial imagery; see docs/SPLAT_GEOREGISTRATION.md.
const jaxReference: SplatGeoreference = {
  origin: { lon: -81.66376054127814, lat: 30.34881972282938 },
  modelToMercator: [1.1617442851249093, 0.0004266472952384817, -0.0004266472952384817, 1.1617442851249093],
  groundZ: 14,
};
const nycReference: SplatGeoreference = {
  origin: { lon: -74.01480690018744, lat: 40.71530642139432 },
  modelToMercator: [1.191699539031423, 0.03620725592166198, -0.03620725592166198, 1.191699539031423],
  groundZ: -45,
};
function footprint(reference: SplatGeoreference, minX: number, minY: number, maxX: number, maxY: number): GeoBounds {
  const points = [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]].map(([x, y]) => modelToGeographic(reference, x, y));
  return { west: Math.min(...points.map(p => p.lon)), east: Math.max(...points.map(p => p.lon)),
    south: Math.min(...points.map(p => p.lat)), north: Math.max(...points.map(p => p.lat)) };
}
export const SKYFALL_SCENES: SplatSceneMeta[] = [
  {
    id: 'JAX_068', name: 'Jacksonville · UF Health campus (JAX 068)', city: 'JAX',
    bounds: footprint(jaxReference, -410, -450, 400, 440),
    center: jaxReference.origin, georeference: jaxReference,
    splatUrl: `${splatBase}/JAX_068.sog`, upVector: [0, 0, 1],
  },
  {
    id: 'NYC_004', name: 'New York City · World Financial Center (NYC 004)', city: 'NYC',
    bounds: footprint(nycReference, -505, -485, 330, 375),
    center: nycReference.origin, georeference: nycReference,
    splatUrl: `${splatBase}/NYC_004.sog`, upVector: [0, 0, 1],
  },
];

/** Accept unwrapped longitudes from the Mercator camera, including repeated worlds. */
export function findIntersectingScene(bbox: GeoBounds): SplatSceneMeta | undefined {
  if (!Object.values(bbox).every(Number.isFinite) || bbox.south > bbox.north) return undefined;
  let east = bbox.east;
  if (east < bbox.west) east += Math.ceil((bbox.west - east) / 360) * 360;
  const span = east - bbox.west;
  return SKYFALL_SCENES.find(({ bounds }) => {
    if (bounds.south > bbox.north || bounds.north < bbox.south) return false;
    if (span >= 360) return true;
    const west = bbox.west >= -180 && bbox.west <= 180 ? bbox.west : ((bbox.west + 180) % 360 + 360) % 360 - 180;
    return [0, 360, -360].some((shift) => bounds.west + shift <= west + span && bounds.east + shift >= west);
  });
}

/** CSS pixels, independent of the canvas's backing-store device pixel ratio. */
export function selectionBounds(camera: CameraState, viewport: Viewport, start: ScreenPoint, end: ScreenPoint): GeoBounds {
  const nw = screenToLonLat(camera, viewport, Math.min(start.x, end.x), Math.min(start.y, end.y));
  const se = screenToLonLat(camera, viewport, Math.max(start.x, end.x), Math.max(start.y, end.y));
  return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
}
