import { describe, expect, it } from 'vitest';
import { SKYFALL_SCENES, findIntersectingScene, selectionBounds } from '../src/data/splatScenes';
import { createCamera, screenToLonLat } from '../src/map/MapCamera';

describe('Skyfall scene discovery', () => {
  it.each(SKYFALL_SCENES)('discovers $id from its footprint and center', (scene) => {
    expect(findIntersectingScene(scene.bounds)?.id).toBe(scene.id);
    expect(findIntersectingScene({ west: scene.center.lon, east: scene.center.lon, south: scene.center.lat, north: scene.center.lat })?.id).toBe(scene.id);
  });
  it('includes touching boundaries and rejects nearby unrelated areas', () => {
    const b = SKYFALL_SCENES[0].bounds;
    expect(findIntersectingScene({ west: b.east, east: b.east + 0.001, south: b.south, north: b.north })?.id).toBe('JAX_068');
    expect(findIntersectingScene({ west: -81.64, east: -81.63, south: 30.32, north: 30.33 })).toBeUndefined();
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
