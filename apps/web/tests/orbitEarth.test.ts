// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { BLEND_NONE, BLEND_NORMAL, CULLFACE_BACK, Entity, NullGraphicsDevice, Vec3, type StandardMaterial } from 'playcanvas';
import { Camera } from '../src/splat/supersplat/camera';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { createOrbitEarth } from '../src/map/OrbitEarth';
import { EARTH_RADIUS } from '../src/map/navigation3D';
import { groundTileImages } from '../src/splat/GroundTileImages';

vi.mock('../src/splat/GroundTileImages', () => ({ groundTileImages: { get: vi.fn(async () => null) } }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('creates the Earth in the same tangent frame and fades it without making another camera', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const camera = new Entity('Existing camera'); camera.addComponent('camera'); app.root.addChild(camera);
  const earth = createOrbitEarth(app, { lon: -74, lat: 40.7 });
  try {
    expect(fetch).not.toHaveBeenCalled();
    const globe = app.root.findByName('Earth satellite surface') as Entity;
    expect(globe.enabled).toBe(false);
    const base = app.root.findByName('Earth background') as Entity;
    expect(base.getPosition().y).toBeCloseTo(-EARTH_RADIUS, 0);
    earth.update(.5);
    expect(globe.enabled).toBe(true);
    expect((base.render!.material as StandardMaterial).opacity).toBe(.5);
    expect(app.root.findComponents('camera')).toHaveLength(1);
    earth.update(0); expect(globe.enabled).toBe(false);
  } finally { earth.dispose(); app.destroy(); }
});

it('refits globe depth on stationary frames and restores city clipping when zooming back in', () => {
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const camera = new Camera(app, canvas);
  camera.focalPoint.set(0, -EARTH_RADIUS, 0);
  camera.sceneRadius = 1000;
  camera.setAzimElev(0, -90);
  camera.maxDistance = 500000;
  camera.setDistance(50000000 * camera.fovFactor / camera.sceneRadius);
  const earth = createOrbitEarth(app, { lon: -121, lat: 38 }, undefined, camera);
  try {
    earth.update(1);
    expect(camera.camera.nearClip).toBeGreaterThan(1000000);
    const near = camera.camera.nearClip;
    camera.updateClipping(); // Simulate another update of the city camera.
    earth.update(1); // Tile planning is throttled, but clipping must not be.
    expect(camera.camera.nearClip).toBe(near);
    camera.setFocalPoint(new Vec3(0, 0, 0));
    camera.setDistance(1000 * camera.fovFactor / camera.sceneRadius);
    earth.update(0);
    expect(camera.camera.nearClip).toBe(.1);
  } finally { earth.dispose(); camera.destroy(); app.destroy(); }
});

it('renders a single opaque, front-facing patch per tile when the globe is fully visible', async () => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  vi.mocked(groundTileImages.get).mockResolvedValue(canvas);
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const earth = createOrbitEarth(app, { lon: -121, lat: 38 });
  try {
    earth.update(1);
    for (let i = 0; i < 500; i++) await Promise.resolve();
    const globe = app.root.findByName('Earth satellite surface') as Entity;
    const tiles = globe.children.filter(child => child.name !== 'Earth background') as Entity[];
    expect(tiles).toHaveLength(16);
    for (const tile of tiles) {
      const material = tile.render!.meshInstances[0].material as StandardMaterial;
      expect(material.blendType).toBe(BLEND_NONE);
      expect(material.cull).toBe(CULLFACE_BACK);
      expect(material.depthWrite).toBe(true);
    }
    const fetches = vi.mocked(groundTileImages.get).mock.calls.length;
    earth.update(.5); earth.update(1);
    expect(groundTileImages.get).toHaveBeenCalledTimes(fetches);
    earth.update(.5);
    expect((tiles[0].render!.meshInstances[0].material as StandardMaterial).blendType).toBe(BLEND_NORMAL);
  } finally { earth.dispose(); earth.dispose(); app.destroy(); }
});
