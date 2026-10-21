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
  georeference: SplatGeoreference;
  splatUrl: string;
  lodUrl: string;
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
const jaxResidentialReference: SplatGeoreference = {
  origin: { lon: -81.70644458901064, lat: 30.35783436434288 },
  modelToMercator: [1.161701296917393, 0.0006820066865091224, -0.0006820066865091224, 1.161701296917393],
  groundZ: 21,
};
const nycUnionSquareReference: SplatGeoreference = {
  origin: { lon: -73.98974566853668, lat: 40.734882608346474 },
  modelToMercator: [1.311177022955157, 0.00033279549121545843, -0.00033279549121545843, 1.311177022955157],
  groundZ: -40,
};
const jaxCityHallReference: SplatGeoreference = {
  "origin": {
    "lon": -81.66363205832123,
    "lat": 30.33034057541861
  },
  "modelToMercator": [
    1.158496424393592,
    -0.002649375659901217,
    0.002649375659901217,
    1.158496424393592
  ],
  "groundZ": 20
};
const jaxStadiumReference: SplatGeoreference = {
  "origin": {
    "lon": -81.63697442528762,
    "lat": 30.32585049705744
  },
  "modelToMercator": [
    1.1600485785347157,
    -0.0048606252811765486,
    0.0048606252811765486,
    1.1600485785347157
  ],
  "groundZ": 18
};
const jaxOfficeReference: SplatGeoreference = {
  "origin": {
    "lon": -81.66353977279648,
    "lat": 30.316464193938103
  },
  "modelToMercator": [
    1.1577293122496932,
    0.00013860233794552864,
    -0.00013860233794552864,
    1.1577293122496932
  ],
  "groundZ": 15
};
const jaxLakeSideReference: SplatGeoreference = {
  "origin": {
    "lon": -81.66351402694275,
    "lat": 30.31184122505363
  },
  "modelToMercator": [
    1.1619452363225427,
    0.0008714327971019938,
    -0.0008714327971019938,
    1.1619452363225427
  ],
  "groundZ": 8
};
const jaxVillaReference: SplatGeoreference = {
  origin: { lon: -81.6529787723244, lat: 30.330379623025866 },
  modelToMercator: [1.1601508824140814, 0.0012359839098766904, -0.0012359839098766904, 1.1601508824140814],
  groundZ: 18,
};
const jaxFactoryReference: SplatGeoreference = {
  origin: { lon: -81.6528551421137, lat: 30.31190308097151 },
  modelToMercator: [1.1614559668618911, 0.0005283167613157935, -0.0005283167613157935, 1.1614559668618911],
  groundZ: 19,
};
const nycEast12thReference: SplatGeoreference = {
  origin: { lon: -73.98689061630894, lat: 40.731919915172575 },
  modelToMercator: [1.3240495290904157, -0.01046910527263944, 0.01046910527263944, 1.3240495290904157],
  groundZ: -38,
};
const nycAlbanyReference: SplatGeoreference = {
  origin: { lon: -74.01752231045515, lat: 40.71024829908964 },
  modelToMercator: [1.3249109340308445, 0.002195367553402994, -0.002195367553402994, 1.3249109340308445],
  groundZ: -43,
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
    splatUrl: `${splatBase}/JAX_068.sog`, lodUrl: `${splatBase}/streamed/JAX_068/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'NYC_004', name: 'New York City · World Financial Center (NYC 004)', city: 'NYC',
    bounds: footprint(nycReference, -505, -485, 330, 375),
    center: nycReference.origin, georeference: nycReference,
    splatUrl: `${splatBase}/NYC_004.sog`, lodUrl: `${splatBase}/streamed/NYC_004/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_004', name: 'Jacksonville · Residential (JAX 004)', city: 'JAX',
    bounds: footprint(jaxResidentialReference, -390, -420, 385, 430),
    center: jaxResidentialReference.origin, georeference: jaxResidentialReference,
    splatUrl: `${splatBase}/JAX_004.sog`, lodUrl: `${splatBase}/streamed/JAX_004/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'NYC_010', name: 'New York City · Union Square (NYC 010)', city: 'NYC',
    bounds: footprint(nycUnionSquareReference, -425, -420, 415, 405),
    center: nycUnionSquareReference.origin, georeference: nycUnionSquareReference,
    splatUrl: `${splatBase}/NYC_010.sog`, lodUrl: `${splatBase}/streamed/NYC_010/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_164', name: 'Jacksonville · City Hall (JAX 164)', city: 'JAX',
    bounds: footprint(jaxCityHallReference, -385, -390, 375, 395),
    center: jaxCityHallReference.origin, georeference: jaxCityHallReference,
    splatUrl: `${splatBase}/JAX_164.sog`, lodUrl: `${splatBase}/streamed/JAX_164/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_175', name: 'Jacksonville · Stadium (JAX 175)', city: 'JAX',
    bounds: footprint(jaxStadiumReference, -370, -390, 370, 395),
    center: jaxStadiumReference.origin, georeference: jaxStadiumReference,
    splatUrl: `${splatBase}/JAX_175.sog`, lodUrl: `${splatBase}/streamed/JAX_175/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_214', name: 'Jacksonville · Office Building (JAX 214)', city: 'JAX',
    bounds: footprint(jaxOfficeReference, -380, -385, 375, 390),
    center: jaxOfficeReference.origin, georeference: jaxOfficeReference,
    splatUrl: `${splatBase}/JAX_214.sog`, lodUrl: `${splatBase}/streamed/JAX_214/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_260', name: 'Jacksonville · Lake Side (JAX 260)', city: 'JAX',
    bounds: footprint(jaxLakeSideReference, -355, -355, 355, 345),
    center: jaxLakeSideReference.origin, georeference: jaxLakeSideReference,
    splatUrl: `${splatBase}/JAX_260.sog`, lodUrl: `${splatBase}/streamed/JAX_260/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_168', name: 'Jacksonville · Villa (JAX 168)', city: 'JAX',
    bounds: footprint(jaxVillaReference, -370, -390, 375, 380),
    center: jaxVillaReference.origin, georeference: jaxVillaReference,
    splatUrl: `${splatBase}/JAX_168.sog`, lodUrl: `${splatBase}/streamed/JAX_168/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'JAX_264', name: 'Jacksonville · Factory (JAX 264)', city: 'JAX',
    bounds: footprint(jaxFactoryReference, -360, -385, 370, 395),
    center: jaxFactoryReference.origin, georeference: jaxFactoryReference,
    splatUrl: `${splatBase}/JAX_264.sog`, lodUrl: `${splatBase}/streamed/JAX_264/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'NYC_219', name: 'New York City · E 12th St. (NYC 219)', city: 'NYC',
    bounds: footprint(nycEast12thReference, -260, -280, 270, 290),
    center: nycEast12thReference.origin, georeference: nycEast12thReference,
    splatUrl: `${splatBase}/NYC_219.sog`, lodUrl: `${splatBase}/streamed/NYC_219/lod-meta.json`, upVector: [0, 0, 1],
  },
  {
    id: 'NYC_336', name: 'New York City · Albany St. (NYC 336)', city: 'NYC',
    bounds: footprint(nycAlbanyReference, -60, -300, 290, 300),
    center: nycAlbanyReference.origin, georeference: nycAlbanyReference,
    splatUrl: `${splatBase}/NYC_336.sog`, lodUrl: `${splatBase}/streamed/NYC_336/lod-meta.json`, upVector: [0, 0, 1],
  },
];

/** Accept unwrapped longitudes from the Mercator camera, including repeated worlds. */
export function findIntersectingScenes(bbox: GeoBounds): SplatSceneMeta[] {
  if (!Object.values(bbox).every(Number.isFinite) || bbox.south > bbox.north) return [];
  let east = bbox.east;
  if (east < bbox.west) east += Math.ceil((bbox.west - east) / 360) * 360;
  const span = east - bbox.west;
  return SKYFALL_SCENES.filter(({ bounds }) => {
    if (bounds.south > bbox.north || bounds.north < bbox.south) return false;
    if (span >= 360) return true;
    const west = bbox.west >= -180 && bbox.west <= 180 ? bbox.west : ((bbox.west + 180) % 360 + 360) % 360 - 180;
    return [0, 360, -360].some((shift) => bounds.west + shift <= west + span && bounds.east + shift >= west);
  });
}

/** Compatibility helper for callers that only need the first matching scene. */
export function findIntersectingScene(bbox: GeoBounds): SplatSceneMeta | undefined {
  return findIntersectingScenes(bbox)[0];
}

/** CSS pixels, independent of the canvas's backing-store device pixel ratio. */
export function selectionBounds(camera: CameraState, viewport: Viewport, start: ScreenPoint, end: ScreenPoint): GeoBounds {
  const nw = screenToLonLat(camera, viewport, Math.min(start.x, end.x), Math.min(start.y, end.y));
  const se = screenToLonLat(camera, viewport, Math.max(start.x, end.x), Math.max(start.y, end.y));
  return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
}
