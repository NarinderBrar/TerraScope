import { expect, it } from 'vitest';
import { BoundingBox, Mat4, Quat, Vec3 } from 'playcanvas';
import { captureEarthView, captureMapView, EARTH_RADIUS, globeBlend, globePoint, pickGroundFootprint } from '../src/map/navigation3D';
import { map3DReference } from '../src/map/Map3DView';
import { mapViewFrame } from '../src/splat/mapViewFrame';
import { createCamera } from '../src/map/MapCamera';
import { selectionBounds, SKYFALL_SCENES } from '../src/data/splatScenes';
import { Camera } from '../src/splat/supersplat/camera';

const center = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!.center;
const matrix = new Mat4().setTRS(Vec3.ZERO, new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP), Vec3.ONE);
const root = { getWorldTransform: () => matrix };
function fakeCamera(distance: number): Camera {
  return { azim: 0, elevation: -90, mainCamera: { getPosition: () => new Vec3(0, distance, 0), forward: new Vec3(0, -1, 0) },
    camera: { fov: 50, screenToWorld: () => new Vec3(0, 0, 0) } } as unknown as Camera;
}

it('preserves geographic center and zoom in a 2D to 3D to 2D camera round trip', () => {
  const reference = map3DReference(center), viewport = { width: 1024, height: 768, dpr: 1 };
  const bounds = selectionBounds(createCamera(center, 16), viewport, { x: 0, y: 0 }, { x: 1024, y: 768 });
  const frame = mapViewFrame(bounds, reference);
  const camera = fakeCamera(frame.halfHeight / Math.tan(25 * Math.PI / 180));
  const captured = captureMapView(camera, root, reference, 768)!;
  expect(captured.center.lon).toBeCloseTo(center.lon, 7); expect(captured.center.lat).toBeCloseTo(center.lat, 7);
  expect(captured.zoom).toBeCloseTo(16, 5);
});

it.each(SKYFALL_SCENES)('preserves tilt, geographic heading and zoom when entering $id', scene => {
  const orientation = { azimuth: 37, elevation: -42 };
  const viewport = { width: 1024, height: 768, dpr: 1 };
  const bounds = selectionBounds(createCamera(scene.center, 17), viewport, { x: 0, y: 0 }, { x: 1024, y: 768 });
  const frame = mapViewFrame(bounds, scene.georeference, orientation);
  const position = new Vec3(), forward = new Vec3();
  const camera = Object.assign(Object.create(Camera.prototype) as Camera, {
    mainCamera: {
      camera: { fov: 50 }, getPosition: () => position, forward,
      setPosition: (x: number, y: number, z: number) => position.set(x, y, z),
      lookAt: (point: Vec3) => forward.copy(point).sub(position).normalize(),
    },
    focalPoint: new Vec3(), distanceTween: { value: { distance: 1 } },
  });
  camera.frame(new BoundingBox(Vec3.ZERO, new Vec3(100, 100, 100)), frame);
  const captured = captureMapView(camera, root, scene.georeference, viewport.height)!;
  expect(captured.orientation?.azimuth).toBeCloseTo(orientation.azimuth, 6);
  expect(captured.orientation?.elevation).toBe(orientation.elevation);
  expect(captured.center.lon).toBeCloseTo(scene.center.lon, 6);
  expect(captured.center.lat).toBeCloseTo(scene.center.lat, 6);
  expect(captured.zoom).toBeCloseTo(17, 5);
});

it('picks the nearest registered footprint using a 3D ground ray and rejects the horizon', () => {
  const reference = map3DReference(center), camera = fakeCamera(1000);
  expect(pickGroundFootprint(200, 200, camera, root, reference)?.id).toBe('NYC_010');
  camera.camera.screenToWorld = () => new Vec3(1, 1000, 0);
  expect(pickGroundFootprint(200, 200, camera, root, reference)).toBeUndefined();
});

it('uses a continuous Earth blend and preserves geographic anchor in the shared camera frame', () => {
  expect(globeBlend(100000)).toBe(0); expect(globeBlend(1000000)).toBe(1);
  expect(globeBlend(475000)).toBeCloseTo(.5);
  expect(globePoint(center.lon, center.lat, center).length()).toBeLessThan(1e-6);
  const other = globePoint(center.lon + 60, 10, center);
  expect(other.clone().add(new Vec3(0, EARTH_RADIUS, 0)).length()).toBeCloseTo(EARTH_RADIUS, 2);
  const view = captureEarthView(fakeCamera(EARTH_RADIUS * 2), center, 768)!;
  expect(view.center.lon).toBeCloseTo(center.lon, 6); expect(view.center.lat).toBeCloseTo(center.lat, 6);
});
