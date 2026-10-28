import { expect, it } from 'vitest';
import { Vec3 } from 'playcanvas';
import { EARTH_BASE_SCALE, earthClipPlanes, earthTileGeometry, planEarthTiles } from '../src/map/earthTilePlan';
import { EARTH_RADIUS } from '../src/map/navigation3D';
import { parentGroundTile } from '../src/splat/groundTilePlan';

const anchor = { lon: -121, lat: 38 };
const view = { position: new Vec3(0, 150000, 0), forward: new Vec3(0, -1, 0), right: Vec3.RIGHT,
  up: new Vec3(0, 0, -1), fov: 50, aspect: 16 / 9, height: 1080 };

it('separates globe and underlay depth at far zoom where city clipping loses precision', () => {
  const depth24 = (z: number, near: number, far: number) =>
    Math.round((far / (far - near) - far * near / ((far - near) * z)) * 0xffffff);
  let oldCollisions = 0;
  for (const distance of [20000000, 50000000, 100000000, 300000000]) {
    const front = distance - EARTH_RADIUS, underlay = distance - EARTH_RADIUS * EARTH_BASE_SCALE;
    const far = distance * 4;
    if (depth24(front, distance / 100000, far) === depth24(underlay, distance / 100000, far)) oldCollisions++;
    const clip = earthClipPlanes(new Vec3(0, front, 0));
    expect(clip.near).toBeLessThan(front);
    expect(clip.far).toBeGreaterThan(distance + EARTH_RADIUS);
    expect(depth24(underlay, clip.near, far) - depth24(front, clip.near, far)).toBeGreaterThan(1000);
  }
  expect(oldCollisions).toBeGreaterThan(0);
});

it('preserves model-unit scale and does not clip a globe seen close to the horizon', () => {
  const position = new Vec3(150000, 1000, 0);
  const standard = earthClipPlanes(position), scaled = earthClipPlanes(position, .8);
  expect(scaled.near).toBeCloseTo(standard.near * .8, 6);
  expect(scaled.far).toBeCloseTo(standard.far * .8, 6);
  const clearance = position.clone().add(new Vec3(0, EARTH_RADIUS, 0)).length() - EARTH_RADIUS;
  expect(standard.near).toBeLessThan(clearance);
});

it('refines nearby globe imagery and reduces detail as the globe gets smaller', () => {
  const close = planEarthTiles(anchor, view);
  const far = planEarthTiles(anchor, { ...view, position: new Vec3(0, 20000000, 0) });
  const max = (tiles: typeof close) => Math.max(...tiles.map(t => t.z));
  expect(max(close)).toBeGreaterThan(2);
  expect(max(close)).toBeGreaterThan(max(far));
  const largerScreen = planEarthTiles(anchor, { ...view, height: 2160 });
  expect(max(largerScreen)).toBeGreaterThanOrEqual(max(close));
});

it('keeps a complete, bounded sphere cover without overlapping parents and children', () => {
  for (const height of [500000, 5000000, 20000000]) {
    const tiles = planEarthTiles(anchor, { ...view, position: new Vec3(0, height, 0) }, 100);
    expect(tiles.length).toBeLessThanOrEqual(100);
    expect(tiles.reduce((sum, tile) => sum + 1 / 4 ** tile.z, 0)).toBeCloseTo(1, 10);
    for (const tile of tiles) for (const other of tiles) {
      if (tile === other || tile.z > other.z) continue;
      expect(parentGroundTile(other, other.z - tile.z)).not.toEqual({ z: tile.z, x: tile.x, y: tile.y });
    }
  }
});

it('places outward-facing globe triangles above the recessed underlay', () => {
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const { positions, indices } = earthTileGeometry({ z: 2, x, y }, anchor);
    const center = new Vec3(0, EARTH_RADIUS, 0);
    const point = (vertex: number) => new Vec3(...positions.slice(vertex * 3, vertex * 3 + 3)).add(center);
    for (let i = 0; i < 32 * 32 * 6; i += 3) {
      const a = point(indices[i]), b = point(indices[i + 1]), c = point(indices[i + 2]);
      const middle = a.clone().add(b).add(c).mulScalar(1 / 3);
      expect(middle.length()).toBeGreaterThan(EARTH_RADIUS * EARTH_BASE_SCALE);
      const normal = new Vec3().cross(b.clone().sub(a), c.clone().sub(a));
      if (normal.length() > 1) expect(normal.dot(middle)).toBeGreaterThan(0);
    }
  }
});
