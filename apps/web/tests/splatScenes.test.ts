import { describe, expect, it } from 'vitest';
import { SKYFALL_SCENES, findIntersectingScene, findIntersectingScenes, selectionBounds } from '../src/data/splatScenes';
import catalog from '../src/data/skyfallCatalog.json';
import manifest from '../public/splats/manifest.json';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCamera, screenToLonLat } from '../src/map/MapCamera';

describe('Skyfall scene discovery', () => {
  it('offers all twelve integrated scenes through geographic discovery', () => {
    expect(SKYFALL_SCENES.map((scene) => scene.id)).toEqual(['JAX_068', 'NYC_004', 'JAX_004', 'NYC_010', 'JAX_164', 'JAX_175', 'JAX_214', 'JAX_260', 'JAX_168', 'JAX_264', 'NYC_219', 'NYC_336']);
  });
  it.each(SKYFALL_SCENES)('has the real prepared asset and matching manifest for $id', (model) => {
    const entry = manifest.assets.find((asset) => asset.id === model.id)!;
    expect(entry).toBeDefined();
    const data = readFileSync(new URL(`../public/splats/${entry.file}`, import.meta.url));
    expect(data.byteLength).toBe(entry.bytes);
    expect(createHash('sha256').update(data).digest('hex')).toBe(entry.sha256);
    expect(entry.splats).toBeGreaterThan(1_000_000);
    expect(entry.sogVersion).toBe(2);
  });
  it('lists every matching scene when a viewport covers both registered locations', () => {
    const bounds = { west: -82, east: -73, south: 30, north: 41 };
    expect(findIntersectingScenes(bounds).map((scene) => scene.id)).toEqual(SKYFALL_SCENES.map((scene) => scene.id));
    expect(findIntersectingScenes({ ...bounds, west: bounds.west + 360, east: bounds.east + 360 })).toEqual(findIntersectingScenes(bounds));
  });
  it('matches every registered scene to the published catalog', () => {
    expect(catalog).toHaveLength(12);
    expect(new Set(catalog.map((scene) => scene.id)).size).toBe(catalog.length);
    for (const scene of SKYFALL_SCENES) {
      expect(catalog.find((candidate) => candidate.id === scene.id)).toEqual({ id: scene.id, city: scene.city, name: scene.name });
    }
    expect(findIntersectingScenes({ west: -180, east: 180, south: -85, north: 85 })).toEqual(SKYFALL_SCENES);
  });
  it('keeps both adjacent riverfront scenes selectable in their overlapping coverage', () => {
    const office = SKYFALL_SCENES.find((scene) => scene.id === 'JAX_214')!;
    const lake = SKYFALL_SCENES.find((scene) => scene.id === 'JAX_260')!;
    const overlap = {
      west: Math.max(office.bounds.west, lake.bounds.west), east: Math.min(office.bounds.east, lake.bounds.east),
      south: Math.max(office.bounds.south, lake.bounds.south), north: Math.min(office.bounds.north, lake.bounds.north),
    };
    expect(overlap.south).toBeLessThan(overlap.north);
    expect(findIntersectingScenes(overlap).map((scene) => scene.id)).toEqual(['JAX_214', 'JAX_260']);
  });
  it.each(SKYFALL_SCENES)('discovers $id from its footprint and center', (scene) => {
    expect(findIntersectingScenes(scene.bounds).map((candidate) => candidate.id)).toContain(scene.id);
    expect(findIntersectingScenes({ west: scene.center.lon, east: scene.center.lon, south: scene.center.lat, north: scene.center.lat })).toContainEqual(scene);
  });
  it('includes touching boundaries and rejects nearby unrelated areas', () => {
    const b = SKYFALL_SCENES[0].bounds;
    expect(findIntersectingScene({ west: b.east, east: b.east + 0.001, south: b.south, north: b.north })?.id).toBe('JAX_068');
    expect(findIntersectingScene({ west: -81.62, east: -81.61, south: 30.32, north: 30.33 })).toBeUndefined();
    expect(findIntersectingScene({ west: 170, east: -170, south: 25, north: 45 })).toBeUndefined();
  });
  it('handles repeated Mercator worlds and views wider than a world', () => {
    expect(findIntersectingScene({ west: 278.33, east: 278.36, south: 30.34, north: 30.36 })?.id).toBe('JAX_068');
    expect(findIntersectingScene({ west: -200, east: 200, south: 30, north: 31 })?.id).toBe('JAX_068');
  });
  it('rejects invalid coordinates', () => {
    expect(findIntersectingScene({ west: NaN, east: 0, south: 0, north: 1 })).toBeUndefined();
    expect(findIntersectingScene({ west: -90, east: -70, south: 45, north: 20 })).toBeUndefined();
  });
});

describe('drag-to-mark coordinates', () => {
  const camera = createCamera(SKYFALL_SCENES[1].center, 14);
  const viewport = { width: 1200, height: 800, dpr: 2 };
  it('normalizes reverse drags and uses CSS pixels at high DPR', () => {
    const start = { x: 450, y: 300 };
    const end = { x: 750, y: 500 };
    const bounds = selectionBounds(camera, viewport, start, end);
    expect(selectionBounds(camera, viewport, end, start)).toEqual(bounds);
    expect(selectionBounds(camera, { ...viewport, dpr: 1 }, start, end)).toEqual(bounds);
    const nw = screenToLonLat(camera, viewport, start.x, start.y);
    expect(bounds.west).toBeCloseTo(nw.lon, 10);
    expect(bounds.north).toBeCloseTo(nw.lat, 10);
    expect(findIntersectingScene(bounds)?.id).toBe('NYC_004');
  });
});
