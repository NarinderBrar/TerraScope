import { describe, expect, it } from 'vitest';
import { Mat4, Vec3, Vec4 } from 'playcanvas';
import { SKYFALL_SCENES, selectionBounds } from '../src/data/splatScenes';
import { geographicToModel } from '../src/data/splatGeoreference';
import { createCamera } from '../src/map/MapCamera';
import { mapViewFrame } from '../src/splat/mapViewFrame';
import { planGroundMap } from '../src/splat/groundMapPlan';

describe('map to 3D view continuity', () => {
  it.each(SKYFALL_SCENES)('projects all four map edges identically for $id', (scene) => {
    const viewport = { width: 1500, height: 850, dpr: 2 };
    // Deliberately offset from the model center: entering 3D must not recenter.
    const map = createCamera({ lon: scene.center.lon + .003, lat: scene.center.lat - .002 }, 13.7);
    const bounds = selectionBounds(map, viewport, { x: 0, y: 0 }, { x: viewport.width, y: viewport.height });
    const frame = mapViewFrame(bounds, scene.georeference);
    const az = -frame.azimuth * Math.PI / 180;
    const target = new Vec3(...frame.focalPoint);
    const fov = 50;
    const altitude = frame.halfHeight / Math.tan(fov * Math.PI / 360);
    const projection = new Mat4().setPerspective(fov, viewport.width / viewport.height, .1, 100000);
    const view = new Mat4().setLookAt(target.clone().add(new Vec3(0, altitude, 0)), target,
      new Vec3(Math.sin(az), 0, -Math.cos(az))).invert();
    const corners = [[bounds.west, bounds.north, -1, 1], [bounds.east, bounds.north, 1, 1],
      [bounds.east, bounds.south, 1, -1], [bounds.west, bounds.south, -1, -1]];
    for (const [lon, lat, expectedX, expectedY] of corners) {
      const [x, y] = geographicToModel(scene.georeference, lon, lat);
      const p = view.transformPoint(new Vec3(x, scene.georeference.groundZ, -y));
      const clip = projection.transformVec4(new Vec4(p.x, p.y, p.z, 1));
      expect(clip.x / clip.w).toBeCloseTo(expectedX, 5);
      expect(clip.y / clip.w).toBeCloseTo(expectedY, 5);
    }
    const ground = planGroundMap(scene, 4096, bounds);
    const min = ground.tiles[0];
    expect(ground.width).toBeLessThanOrEqual(4096);
    expect(ground.height).toBeLessThanOrEqual(4096);
    expect(min.z).toBeGreaterThan(0);
    // A model-sized ground plane must not leave the entering map viewport uncovered.
    const nw = geographicToModel(scene.georeference, bounds.west, bounds.north);
    const se = geographicToModel(scene.georeference, bounds.east, bounds.south);
    expect(ground.corners[0][0]).toBeLessThan(nw[0]);
    expect(ground.corners[2][0]).toBeGreaterThan(se[0]);
  });
});

it('perspective makes a closer object appear larger instead of keeping parallel scale', () => {
  const projection = new Mat4().setPerspective(50, 1, .1, 10000);
  const near = projection.transformVec4(new Vec4(10, 0, -100, 1));
  const far = projection.transformVec4(new Vec4(10, 0, -200, 1));
  expect(near.x / near.w).toBeCloseTo(2 * far.x / far.w, 6);
});
