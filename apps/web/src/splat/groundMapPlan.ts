import { lonLatToWorldPx, worldPxToLonLat, TILE_SIZE } from '@terrascope/contracts';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';
import { geographicToModel } from '../data/splatGeoreference';
import { WORLD_IMAGERY_MAX_ZOOM } from '../map/worldImagery';

export interface GroundMapTile { z: number; x: number; y: number; left: number; top: number }
export interface GroundMapPlan {
  width: number;
  height: number;
  tiles: GroundMapTile[];
  /** NW, NE, SE, SW; model space is Z-up; horizontal orientation follows scene registration. */
  corners: [number, number, number][];
}

/** Tile bounds control coverage only; the fixed georeference controls placement. */
export function planGroundMap(scene: Pick<SplatSceneMeta, 'bounds' | 'georeference'>, maxTextureSize = 4096, viewBounds?: GeoBounds): GroundMapPlan {
  const { georeference } = scene;
  const bounds = viewBounds ? {
    west: Math.min(scene.bounds.west, viewBounds.west), east: Math.max(scene.bounds.east, viewBounds.east),
    south: Math.min(scene.bounds.south, viewBounds.south), north: Math.max(scene.bounds.north, viewBounds.north),
  } : scene.bounds;
  const padding = viewBounds ? 0.1 : 1;
  // Detailed aerial tiles: select the highest level that fits the actual GPU
  // texture limit (including the complete tile border), capped at 64 MiB RGBA.
  const budget = Math.max(256, Math.min(4096, Math.floor(maxTextureSize / TILE_SIZE) * TILE_SIZE));
  let z = WORLD_IMAGERY_MAX_ZOOM;
  const extent = (level: number): { x0: number; x1: number; y0: number; y1: number; n: number } => {
    const nw = lonLatToWorldPx({ lon: bounds.west, lat: bounds.north }, level);
    const se = lonLatToWorldPx({ lon: bounds.east, lat: bounds.south }, level);
    const spanX = Math.max(1, se.px - nw.px);
    const spanY = Math.max(1, se.py - nw.py);
    const n = 2 ** level;
    return {
      x0: Math.floor((nw.px - spanX * padding) / TILE_SIZE),
      x1: Math.floor((se.px + spanX * padding) / TILE_SIZE),
      y0: Math.max(0, Math.floor((nw.py - spanY * padding) / TILE_SIZE)),
      y1: Math.min(n - 1, Math.floor((se.py + spanY * padding) / TILE_SIZE)), n,
    };
  };
  let area = extent(z);
  while (z > 0 && Math.max(area.x1 - area.x0 + 1, area.y1 - area.y0 + 1) * TILE_SIZE > budget) {
    area = extent(--z);
  }
  const { x0, x1, y0, y1, n } = area;
  const width = (x1 - x0 + 1) * TILE_SIZE;
  const height = (y1 - y0 + 1) * TILE_SIZE;
  const tiles: GroundMapTile[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    tiles.push({ z, x: ((x % n) + n) % n, y, left: (x - x0) * TILE_SIZE, top: (y - y0) * TILE_SIZE });
  }
  const point = (px: number, py: number): [number, number, number] => {
    const geo = worldPxToLonLat(px, py, z);
    const [x, y] = geographicToModel(georeference, geo.lon, geo.lat);
    return [x, y, georeference.groundZ];
  };
  return {
    width, height, tiles,
    corners: [point(x0 * TILE_SIZE, y0 * TILE_SIZE), point((x1 + 1) * TILE_SIZE, y0 * TILE_SIZE), point((x1 + 1) * TILE_SIZE, (y1 + 1) * TILE_SIZE), point(x0 * TILE_SIZE, (y1 + 1) * TILE_SIZE)],
  };
}
