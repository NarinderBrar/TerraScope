import { describe, expect, it } from 'vitest';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { modelToGeographic } from '../src/data/splatGeoreference';
import { groundTileCorners, groundTileUvs, parentGroundTile, planGroundTiles, type GroundCameraView } from '../src/splat/groundTilePlan';
import { lonLatToWorldPx } from '@terrascope/contracts';

const reference = SKYFALL_SCENES[0].georeference;
const view: GroundCameraView = {
  position: [0, 0, reference.groundZ + 1000], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
  fov: 50, aspect: 1.5, height: 900, near: .1, far: 30000,
};
function covered(tiles: ReturnType<typeof planGroundTiles>, point: readonly [number, number]): boolean {
  const geo = modelToGeographic(reference, ...point);
  return tiles.some((tile) => {
    const px = lonLatToWorldPx(geo, tile.z);
    return px.px >= tile.x * 256 - 1e-5 && px.px <= (tile.x + 1) * 256 + 1e-5
      && px.py >= tile.y * 256 - 1e-5 && px.py <= (tile.y + 1) * 256 + 1e-5;
  });
}

describe('camera driven ground imagery', () => {
  it('covers the full top-down camera view without overlapping leaves', () => {
    const tiles = planGroundTiles(reference, view);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(128);
    const halfHeight = 1000 * Math.tan(25 * Math.PI / 180);
    for (let x = -.99; x <= 1; x += .2) for (let y = -.99; y <= 1; y += .2) {
      expect(covered(tiles, [x * halfHeight * view.aspect, y * halfHeight])).toBe(true);
    }
    for (const tile of tiles) for (const other of tiles) {
      if (tile === other || tile.z > other.z) continue;
      expect(parentGroundTile(other, other.z - tile.z)).not.toEqual({ z: tile.z, x: tile.x, y: tile.y });
    }
  });
  it('streams beyond the original scene and chooses finer imagery when closer', () => {
    const original = planGroundTiles(reference, view);
    const moved = planGroundTiles(reference, { ...view, position: [25000, 15000, view.position[2]] });
    expect(covered(moved, [25000, 15000])).toBe(true);
    expect(covered(original, [25000, 15000])).toBe(false);
    const close = planGroundTiles(reference, { ...view, position: [0, 0, reference.groundZ + 50] });
    const distant = planGroundTiles(reference, { ...view, position: [0, 0, reference.groundZ + 50000], far: 200000 });
    expect(Math.max(...close.map((t) => t.z))).toBe(20);
    expect(Math.max(...distant.map((t) => t.z))).toBeLessThan(Math.min(...original.map((t) => t.z)));
  });
  it('uses different levels near the camera and toward the horizon under a hard budget', () => {
    const forward = [0, .98, -.2].map((v) => v / Math.hypot(.98, .2)) as [number, number, number];
    const tiles = planGroundTiles(reference, { ...view, forward, up: [0, -forward[2], forward[1]], far: 100000 }, 80);
    expect(tiles.length).toBeLessThanOrEqual(80);
    expect(Math.max(...tiles.map((t) => t.z)) - Math.min(...tiles.map((t) => t.z))).toBeGreaterThan(3);
    // Actual ray-ground intersections across the screen must have a selected tile.
    for (const sx of [-.9, 0, .9]) for (const sy of [-.9, -.5, 0]) {
      const ty = Math.tan(25 * Math.PI / 180) * sy;
      const ray = [sx * Math.tan(25 * Math.PI / 180) * view.aspect, forward[1] + ty * -forward[2], forward[2] + ty * forward[1]];
      const distance = -1000 / ray[2];
      expect(covered(tiles, [ray[0] * distance, ray[1] * distance])).toBe(true);
    }
  });
  it('culls ground when looking upward or beyond the far plane', () => {
    expect(planGroundTiles(reference, { ...view, forward: [0, 0, 1] })).toEqual([]);
    expect(planGroundTiles(reference, { ...view, far: 10 })).toEqual([]);
  });
  it.each(SKYFALL_SCENES)('places changing detail levels in the measured frame for $id', (scene) => {
    for (const z of [5, 15, 20]) {
      const px = lonLatToWorldPx(scene.georeference.origin, z);
      const tile = { z, x: Math.floor(px.px / 256), y: Math.floor(px.py / 256) };
      const corners = groundTileCorners(scene.georeference, tile);
      const first = modelToGeographic(scene.georeference, corners[0][0], corners[0][1]);
      const actual = lonLatToWorldPx(first, z);
      expect(actual.px).toBeCloseTo(tile.x * 256, 5);
      expect(actual.py).toBeCloseTo(tile.y * 256, 5);
      expect(corners.every((p) => p[2] === scene.georeference.groundZ)).toBe(true);
    }
  });
  it('crops ancestor textures precisely, including repeated worlds', () => {
    expect(groundTileUvs({ z: 3, x: 3, y: 5 }, { z: 1, x: 0, y: 1 })).toEqual([.75, .25, 1, .25, 1, .5, .75, .5]);
    expect(groundTileUvs({ z: 3, x: -1, y: 5 }, { z: 1, x: -1, y: 1 })).toEqual([.75, .25, 1, .25, 1, .5, .75, .5]);
  });
});
