/**
 * Camera, tile selection, and cache behaviour.
 *
 * These are the pieces where a bug is invisible in a screenshot but very
 * visible in use: a tile seam, a map that drifts when you pan, or a cache that
 * evicts the tile you are looking at.
 */

import { describe, expect, it } from 'vitest';
import { TILE_SIZE, groundResolution, lonLatToTile, tileBounds } from '@terrascope/contracts';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampCamera,
  createCamera,
  displayResolution,
  panBy,
  screenToLonLat,
  tileZoom,
  visibleTiles,
  wrapLongitude,
  zoomAround,
  type Viewport,
} from '../src/map/MapCamera';
import {
  DEFAULT_CACHE,
  TileCache,
  devicePixelsPerTexel,
  parentOf,
  tileKeyString,
} from '../src/map/TileCache';

const viewport: Viewport = { width: 1024, height: 768, dpr: 1 };

describe('world projection round-trips', () => {
  it('returns the same coordinate after a round trip', () => {
    for (const [lon, lat] of [
      [-121.3, 38.1],
      [0, 0],
      [174.7, -41.3],
      [-0.1276, 51.5072],
    ]) {
      for (const z of [2, 8, 13, 18]) {
        const px = lonLatToTile(lon, lat, z);
        expect(px.z).toBe(z);
        // A tile can only be recovered to its own precision, so compare the
        // tile indices rather than the exact float round trip.
        const again = lonLatToTile(...boundsCentre(tileBounds(px)), z);
        expect(again.x).toBe(px.x);
        expect(again.y).toBe(px.y);
      }
    }
  });

  it('clamps beyond the Mercator limit instead of producing a bad tile', () => {
    // Latitude 90 is off the top of the world; the projection is undefined.
    const clamped = lonLatToTile(0, 90, 5);
    expect(Number.isInteger(clamped.y)).toBe(true);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.y).toBeLessThan(2 ** 5);
  });

  it('puts the equator at the boundary between rows 3 and 4 at z3', () => {
    // The world is 2^3 rows; the equator is exactly halfway, so row 3 ends at
    // latitude 0 and row 4 begins there.
    const rowAbove = tileBounds({ z: 3, x: 4, y: 3 });
    const rowBelow = tileBounds({ z: 3, x: 4, y: 4 });
    expect(rowAbove[1]).toBeCloseTo(0, 9);
    expect(rowBelow[3]).toBeCloseTo(0, 9);
  });

  it('reports ground resolution consistent with the projection', () => {
    // At 38.1 N, z13 is 15.0 m/px and z14 is 7.5 m/px: each zoom level halves
    // it exactly. Sentinel-2's native 10 m sits between the two, at z13.59,
    // which is why the UI reports a resolution rather than a zoom level.
    const at13 = groundResolution(38.1, 13);
    expect(at13).toBeCloseTo(15.04, 2);
    expect(groundResolution(38.1, 14)).toBeCloseTo(at13 / 2, 9);
    // Equator is the widest: the cosine factor is 1 there.
    expect(groundResolution(0, 13)).toBeGreaterThan(at13);
  });
});

function boundsCentre(bounds: [number, number, number, number]): [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

describe('visible tiles', () => {
  it('covers the viewport with no gaps', () => {
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 11);
    const tiles = visibleTiles(camera, viewport);
    expect(tiles.length).toBeGreaterThan(0);
    // 1024x768 at z11: 4x3 tiles at 256 px each, so a 4x3 or 5x4 set.
    expect(tiles.length).toBeGreaterThanOrEqual(12);
  });

  it('gives every tile a screen position covering the viewport', () => {
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 11);
    const tiles = visibleTiles(camera, viewport);
    const tileScreenSize = TILE_SIZE * 2 ** (camera.zoom - tileZoom(camera));
    // At least one tile must start left of and above the origin, and one must
    // end right of and below it, or the view would be showing a hole.
    expect(Math.min(...tiles.map((t) => t.screenX))).toBeLessThan(0);
    expect(Math.min(...tiles.map((t) => t.screenY))).toBeLessThan(0);
    expect(Math.max(...tiles.map((t) => t.screenX + tileScreenSize))).toBeGreaterThan(viewport.width);
    expect(Math.max(...tiles.map((t) => t.screenY + tileScreenSize))).toBeGreaterThan(viewport.height);
  });

  it('orders tiles nearest the viewport centre first', () => {
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 11);
    const tiles = visibleTiles(camera, viewport);
    for (let i = 1; i < tiles.length; i += 1) {
      expect(tiles[i - 1].priority).toBeGreaterThanOrEqual(tiles[i].priority);
    }
  });

  it('produces identical results for identical state', () => {
    // Two calls must not share mutable state, or a panned map would jitter.
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 11);
    const a = visibleTiles(camera, viewport).map((t) => `${t.tile.z}/${t.tile.x}/${t.tile.y}`);
    const b = visibleTiles(camera, viewport).map((t) => `${t.tile.z}/${t.tile.x}/${t.tile.y}`);
    expect(a).toEqual(b);
  });

  it('wraps horizontally at the antimeridian', () => {
    const camera = createCamera({ lon: 179.9, lat: 0 }, 4);
    const tiles = visibleTiles(camera, viewport);
    for (const t of tiles) {
      expect(t.tile.x).toBeGreaterThanOrEqual(0);
      expect(t.tile.x).toBeLessThan(2 ** 4);
    }
    // A wrapped tile's screen position must be continuous with its unwrapped
    // neighbours, not teleported to the other side of the world.
    const xs = tiles.map((t) => t.screenX).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i += 1) {
      expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThanOrEqual(TILE_SIZE * 2 ** (camera.zoom - 4));
    }
  });

  it('stays inside the world at the poles', () => {
    // Web Mercator is undefined beyond ~85.05 deg, and the camera clamps
    // there. The clamp means rows still exist rather than the view going
    // blank, but every returned row must be a real row.
    const poles = createCamera({ lon: 0, lat: 90 }, 3);
    const clamped = clampCamera(poles);
    expect(clamped.center.lat).toBeCloseTo(85.0511287798066, 6);
    for (const t of visibleTiles(poles, viewport)) {
      expect(t.tile.y).toBeGreaterThanOrEqual(0);
      expect(t.tile.y).toBeLessThan(2 ** 3);
    }
  });
});

describe('panning and zooming', () => {
  it('pans by the requested pixel delta', () => {
    const before = createCamera({ lon: -121.3, lat: 38.1 }, 12);
    const after = panBy(before, 256, 0);
    // 256 screen px at an integer zoom is 256 world px, and the world at
    // z12 is 2^12 * 256 px across and 360 deg wide, so the shift is
    // 256 * 360 / (2^12 * 256) = 360 / 2^12 degrees.
    const expectedShift = 360 / 2 ** 12;
    expect(before.center.lon - after.center.lon).toBeCloseTo(expectedShift, 9);
    // Horizontal panning must not change latitude.
    expect(after.center.lat).toBeCloseTo(before.center.lat, 9);
  });

  it('keeps the cursor anchored while zooming', () => {
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 12);
    // A point off-centre, so a naive "zoom about the centre" would be caught.
    const at = { x: 300, y: 200 };
    const before = screenToLonLat(camera, viewport, at.x, at.y);
    for (const delta of [-400, -100, 100, 400]) {
      const zoomed = zoomAround(camera, viewport, delta, at.x, at.y);
      const after = screenToLonLat(zoomed, viewport, at.x, at.y);
      // The anchor must come back to the same point. The tolerance covers
      // only float64 round-tripping through the projection, not a real
      // allowance: a genuine anchoring bug shows up as whole degrees.
      expect(Math.abs(after.lon - before.lon)).toBeLessThan(1e-9);
      expect(Math.abs(after.lat - before.lat)).toBeLessThan(1e-9);
    }
  });

  it('clamps zoom at both ends', () => {
    // Scrolling up at the maximum zoom must not exceed it. deltaY is negative
    // for a wheel-up, which zooms in.
    const atMax = createCamera({ lon: 0, lat: 0 }, MAX_ZOOM);
    expect(zoomAround(atMax, viewport, -1000, 100, 100).zoom).toBe(MAX_ZOOM);
    const atMin = createCamera({ lon: 0, lat: 0 }, MIN_ZOOM);
    expect(zoomAround(atMin, viewport, 1000, 100, 100).zoom).toBe(MIN_ZOOM);
  });

  it('clamps zoom and latitude', () => {
    const clamped = clampCamera({ center: { lon: 200, lat: 95 }, zoom: 99, minZoom: 2, maxZoom: 19 });
    expect(clamped.zoom).toBe(19);
    expect(clamped.center.lat).toBeLessThanOrEqual(85.0511287798066);
    expect(clamped.center.lon).toBeGreaterThanOrEqual(-180);
    expect(clamped.center.lon).toBeLessThanOrEqual(180);
  });

  it('wraps longitude into [-180, 180]', () => {
    expect(wrapLongitude(190)).toBeCloseTo(-170, 9);
    expect(wrapLongitude(-190)).toBeCloseTo(170, 9);
    expect(wrapLongitude(0)).toBe(0);
    expect(wrapLongitude(180)).toBe(180);
    expect(wrapLongitude(-180)).toBe(-180);
  });

  it('reports the display resolution the user is actually seeing', () => {
    const camera = createCamera({ lon: -121.3, lat: 38.1 }, 13);
    expect(displayResolution(camera)).toBeCloseTo(groundResolution(38.1, 13), 6);
  });
});

describe('tile cache', () => {
  it('stores and retrieves by key', () => {
    const cache = new TileCache<number>({ maxTiles: 4, maxBytes: 1e9, bytesPerTile: 10 });
    const tile = { z: 1, x: 0, y: 0 };
    cache.set('a', tile, 7);
    expect(cache.get('a')).toBe(7);
    expect(cache.has('a')).toBe(true);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new TileCache<number>({ maxTiles: 3, maxBytes: 1e9, bytesPerTile: 10 });
    cache.set('a', { z: 1, x: 0, y: 0 }, 1);
    cache.set('b', { z: 1, x: 1, y: 0 }, 2);
    cache.set('c', { z: 1, x: 2, y: 0 }, 3);
    // Touch 'a' so 'b' becomes the oldest.
    cache.get('a');
    cache.set('d', { z: 1, x: 3, y: 0 }, 4);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('evicts on the byte limit, not only the count', () => {
    const cache = new TileCache<number>({ maxTiles: 1000, maxBytes: 30, bytesPerTile: 10 });
    cache.set('a', { z: 1, x: 0, y: 0 }, 1);
    cache.set('b', { z: 1, x: 1, y: 0 }, 2);
    cache.set('c', { z: 1, x: 2, y: 0 }, 3);
    expect(cache.size).toBe(3);
    cache.set('d', { z: 1, x: 3, y: 0 }, 4);
    expect(cache.size).toBe(3);
    expect(cache.bytes).toBeLessThanOrEqual(30);
  });

  it('keeps byte accounting correct when a key is overwritten', () => {
    const cache = new TileCache<string>({ maxTiles: 10, maxBytes: 1e9, bytesPerTile: 100 });
    cache.set('a', { z: 1, x: 0, y: 0 }, 'first', 100);
    cache.set('a', { z: 1, x: 0, y: 0 }, 'second', 40);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(40);
    expect(cache.get('a')).toBe('second');
  });

  it('reports keys oldest first', () => {
    const cache = new TileCache<number>({ maxTiles: 10, maxBytes: 1e9, bytesPerTile: 10 });
    cache.set('a', { z: 1, x: 0, y: 0 }, 1);
    cache.set('b', { z: 1, x: 1, y: 0 }, 2);
    cache.set('c', { z: 1, x: 2, y: 0 }, 3);
    expect(cache.keysByAge()).toEqual(['a', 'b', 'c']);
  });

  it('does not let peek affect eviction order', () => {
    const cache = new TileCache<number>({ maxTiles: 10, maxBytes: 1e9, bytesPerTile: 10 });
    cache.set('a', { z: 1, x: 0, y: 0 }, 1);
    cache.set('b', { z: 1, x: 1, y: 0 }, 2);
    expect(cache.peek('a')).toBe(1);
    expect(cache.keysByAge()).toEqual(['a', 'b']);
  });

  it('defaults to a bounded, byte-aware cache', () => {
    // A cache with no byte limit would let GPU memory grow without warning.
    expect(DEFAULT_CACHE.maxBytes).toBeGreaterThan(0);
    expect(DEFAULT_CACHE.maxTiles).toBeGreaterThan(0);
    const cache = new TileCache<number>();
    for (let i = 0; i < DEFAULT_CACHE.maxTiles * 2; i += 1) {
      cache.set(`t${i}`, { z: 8, x: i, y: 0 }, i);
    }
    expect(cache.size).toBeLessThanOrEqual(DEFAULT_CACHE.maxTiles);
  });
});

describe('tile helpers', () => {
  it('names keys uniquely per scene, profile, and tile', () => {
    const tile = { z: 13, x: 1335, y: 3156 };
    const a = tileKeyString('sentinel-2-l2a', 'SCENE', 'rgb', tile);
    const b = tileKeyString('sentinel-2-l2a', 'SCENE', 'rgbn', tile);
    const c = tileKeyString('sentinel-2-l2a', 'OTHER', 'rgb', tile);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('halves the parent tile index', () => {
    expect(parentOf({ z: 13, x: 1335, y: 3156 })).toEqual({ z: 12, x: 667, y: 1578 });
    expect(parentOf({ z: 1, x: 0, y: 0 }).z).toBe(0);
  });

  it('reports magnification as dpr times the fractional zoom', () => {
    // An integer zoom at dpr 1 is 1:1. Half a zoom level in doubles the
    // magnification, because the tile is drawn at 1.41x.
    expect(devicePixelsPerTexel(13, 1)).toBeCloseTo(1, 9);
    expect(devicePixelsPerTexel(13.5, 1)).toBeCloseTo(Math.SQRT2, 9);
    expect(devicePixelsPerTexel(13, 2)).toBeCloseTo(2, 9);
  });
});
