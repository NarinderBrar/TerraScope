// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { BoundingBox, Entity, NullGraphicsDevice, Quat, Vec3 } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { Camera } from '../src/splat/supersplat/camera';
import { createOrbitEarth } from '../src/map/OrbitEarth';
import { createSurfaceNavigation, maximumSurfaceTilt, referenceAtFocus } from '../src/map/SurfaceNavigation';
import { map3DReference } from '../src/map/Map3DView';
import { EARTH_RADIUS, globePoint } from '../src/map/navigation3D';
import { geographicToModel, modelToGeographic } from '../src/data/splatGeoreference';
import { SKYFALL_SCENES } from '../src/data/splatScenes';

const release: (() => void)[] = [];
afterEach(() => { while (release.length) release.pop()!(); vi.restoreAllMocks(); });
function setup(range = 1000) {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1024, 768);
  Object.defineProperties(canvas, { clientWidth: { value: 1024 }, clientHeight: { value: 768 } });
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  app.graphicsDevice.resizeCanvas(1024, 768);
  const camera = new Camera(app, canvas); camera.camera.aspectRatio = 1024 / 768;
  camera.frame(new BoundingBox(Vec3.ZERO, new Vec3(100, 100, 100)), {
    focalPoint: [0, 0, 0], halfHeight: 100, azimuth: 0, elevation: -90,
  });
  camera.maxDistance = 500000000 / camera.sceneRadius; camera.minDistance = .1 / camera.sceneRadius; camera.zoomFloor = 0;
  const focus = { lon: -121, lat: 38 }, original = map3DReference(focus);
  const ground = new Entity('Ground frame', app);
  ground.setLocalRotation(new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP)); app.root.addChild(ground);
  const earth = createOrbitEarth(app, focus);
  camera.setDistance(range * camera.fovFactor / camera.sceneRadius);
  if (range > 12800000) camera.setFocalPoint(new Vec3(0, -EARTH_RADIUS, 0));
  let active = original;
  const nav = createSurfaceNavigation(camera, original, focus, ground, earth, 1, (point, reference) => {
    active = reference; earth.setFocus(point);
  });
  release.push(() => { nav.dispose(); earth.dispose(); camera.destroy(); app.destroy(); });
  return { camera, nav, earth, original, get active() { return active; } };
}

it('pans over the surface without translating the camera pivot or the Earth center', () => {
  const { camera, nav, earth } = setup(50000000);
  const pivot = camera.focalPoint.clone();
  const center = earth.getWorldTransform().transformPoint(new Vec3(0, -EARTH_RADIUS, 0));
  const before = nav.focus;
  for (let i = 0; i < 20; i++) camera.surfaceControls!.pan(550, 390, 20, 5);
  expect(nav.focus.lon).not.toBeCloseTo(before.lon, 5);
  expect(camera.focalPoint.distance(pivot)).toBeLessThan(1e-8);
  const after = earth.getWorldTransform().transformPoint(new Vec3(0, -EARTH_RADIUS, 0));
  expect(after.distance(center)).toBeLessThan(2);
  const point = earth.getWorldTransform().transformPoint(globePoint(nav.focus.lon, nav.focus.lat, before));
  expect(point.length()).toBeLessThan(2);
});

it('pans the near ground frame geographically while retaining its zero local pivot', () => {
  const state = setup();
  state.camera.surfaceControls!.pan(612, 384, 100, 0);
  expect(state.nav.focus.lon).toBeLessThan(state.original.origin.lon);
  expect(state.nav.focus.lat).toBeCloseTo(state.original.origin.lat, 5);
  expect(state.camera.focalPoint.length()).toBe(0);
  expect(geographicToModel(state.active, state.nav.focus.lon, state.nav.focus.lat)).toEqual([0, 0]);
});

it('orbits a fixed surface anchor with 85° close tilt and strongly damped far tilt', () => {
  const { camera, nav } = setup();
  const focus = nav.focus;
  camera.surfaceControls!.orbit(100, -1000);
  expect(camera.elevation).toBe(-5);
  expect(camera.azim).toBe(-20);
  expect(nav.focus).toEqual(focus);
  camera.setDistance(50000000 * camera.fovFactor / camera.sceneRadius);
  expect(camera.elevation).toBeLessThanOrEqual(-89);
  camera.setAzimElev(camera.azim, -90);
  camera.surfaceControls!.orbit(0, -100);
  expect(camera.elevation + 90).toBeLessThanOrEqual(.5);
  expect(nav.focus).toEqual(focus);
  expect(maximumSurfaceTilt(1000)).toBe(85);
  expect(maximumSurfaceTilt(50000000)).toBe(1);
});

it('restores its initial geographic anchor and tilt when reset', () => {
  const { camera, nav, original } = setup();
  camera.surfaceControls!.pan(612, 384, 100, 0);
  camera.surfaceControls!.orbit(100, -200);
  camera.reset();
  expect(nav.focus.lon).toBeCloseTo(original.origin.lon, 8);
  expect(nav.focus.lat).toBeCloseTo(original.origin.lat, 8);
  expect(camera.azim).toBe(0); expect(camera.elevation).toBe(-90);
});

it.each(SKYFALL_SCENES)('retains metric scale and rotation when moving the frame for $id', scene => {
  const ref = scene.georeference, point = { lon: ref.origin.lon + .001, lat: ref.origin.lat + .001 };
  const shifted = referenceAtFocus(ref, point);
  const metric = (r: typeof ref) => {
    const [a, b, c, d] = r.modelToMercator;
    return Math.sqrt(Math.abs(a * d - b * c)) * Math.cos(r.origin.lat * Math.PI / 180);
  };
  expect(metric(shifted)).toBeCloseTo(metric(ref), 8);
  expect(Math.atan2(shifted.modelToMercator[1], shifted.modelToMercator[0]))
    .toBeCloseTo(Math.atan2(ref.modelToMercator[1], ref.modelToMercator[0]), 8);
  expect(shifted.groundZ).toBe(ref.groundZ);
  const source = [125, -80];
  const geo = modelToGeographic(ref, source[0], source[1]);
  const actual = geographicToModel(shifted, geo.lon, geo.lat);
  const offset = geographicToModel(shifted, ref.origin.lon, ref.origin.lat);
  const scale = Math.cos(point.lat * Math.PI / 180) / Math.cos(ref.origin.lat * Math.PI / 180);
  expect(actual[0]).toBeCloseTo(offset[0] + source[0] * scale, 5);
  expect(actual[1]).toBeCloseTo(offset[1] + source[1] * scale, 5);
});
