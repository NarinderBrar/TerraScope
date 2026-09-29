/**
 * XYZ tile scheme and Web Mercator.
 *
 * Tile size is 256 px, the standard slippy-map convention. All functions take
 * and return doubles; the single-precision conversion happens at the GPU
 * boundary, relative to the camera origin, in `MapCamera`.
 */

/** Standard slippy-map tile edge, in pixels. */
export const TILE_SIZE = 256;

/** Web Mercator is undefined at the poles; this is the usual cutoff. */
export const MAX_LATITUDE = 85.0511287798066;

export interface LonLat {
  lon: number;
  lat: number;
}

export interface WorldPx {
  px: number;
  py: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Ground resolution in metres per pixel at a given latitude and zoom. */
export function groundResolution(lat: number, zoom: number): number {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** World pixel position of a coordinate at an integer zoom. */
export function lonLatToWorldPx(coordinate: LonLat, z: number): WorldPx;
export function lonLatToWorldPx(lon: number, lat: number, z: number): WorldPx;
export function lonLatToWorldPx(
  a: number | LonLat,
  b?: number,
  z = 0,
): WorldPx {
  const lon = typeof a === 'number' ? a : a.lon;
  const lat = typeof a === 'number' ? (b as number) : a.lat;
  const zoom = typeof a === 'number' ? z : (b as number);
  const n = 2 ** zoom;
  const scale = n * TILE_SIZE;
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    px: ((lon + 180) / 360) * scale,
    py: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function worldPxToLonLat(px: number, py: number, z: number): LonLat {
  const n = 2 ** z;
  const lon = (px / (n * TILE_SIZE)) * 360 - 180;
  const nPi = 2 * Math.PI;
  const angle = 0.5 - py / (n * TILE_SIZE);
  const lat = 90 - (360 * Math.atan(Math.exp(-angle * nPi))) / Math.PI;
  return { lon, lat };
}

/** Geographic bounds of a tile: [west, south, east, north]. */
export function tileBounds(tile: TileCoord): [number, number, number, number] {
  const n = 2 ** tile.z;
  const west = (tile.x / n) * 360 - 180;
  const east = ((tile.x + 1) / n) * 360 - 180;
  const north = tile2lat(tile.y, n);
  const south = tile2lat(tile.y + 1, n);
  return [west, south, east, north];
}

function tile2lat(y: number, n: number): number {
  const r = Math.PI - (2 * Math.PI * y) / n;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(r) - Math.exp(-r)));
}

/** Tile containing a coordinate at an integer zoom. */
export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return {
    z,
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    // Lat 90 is off the top of the world; clamp to the first row.
    y: Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n))),
  };
}

/** Stable cache key. `x` is wrapped; `y` is not, because rows do not repeat. */
export function tileKey(collection: string, itemId: string, profile: string, tile: TileCoord): string {
  const n = 2 ** tile.z;
  const x = ((tile.x % n) + n) % n;
  return `${collection}/${itemId}/${profile}/${tile.z}/${x}/${tile.y}`;
}
