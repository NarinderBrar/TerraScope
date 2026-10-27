// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Entity, NullGraphicsDevice, Vec3 } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { Camera } from '../src/splat/supersplat/camera';
import { createGroundMap } from '../src/splat/GroundMapLayer';
import { groundTileImages } from '../src/splat/GroundTileImages';
import { createOrbitEarth } from '../src/map/OrbitEarth';
import { SKYFALL_SCENES } from '../src/data/splatScenes';

vi.mock('../src/splat/GroundTileImages', () => ({ groundTileImages: { get: vi.fn() } }));
const apps: PCApp[] = [];
function createApp() {
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  app.graphicsDevice.resizeCanvas(1024, 768);
  apps.push(app);
  return app;
}
afterEach(() => {
  for (const app of apps.reverse()) app.destroy();
  apps.length = 0;
  vi.restoreAllMocks(); vi.clearAllMocks();
});
const settle = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };

it('keeps cameras and Earth primitives on their owning app while another viewer is active', () => {
  const owner = createApp(), other = createApp();
  const camera = new Camera(owner, owner.graphicsDevice.canvas as HTMLCanvasElement);
  const earth = createOrbitEarth(owner, { lon: -74, lat: 40.7 });
  try {
    const base = owner.root.findByName('Earth background') as Entity;
    expect(camera.mainCamera.camera!.system.app).toBe(owner);
    expect(base.render!.system.app).toBe(owner);
    expect(other.root.findComponents('camera')).toHaveLength(0);
    // A primitive's buffers must be allocated by the renderer which draws it.
    expect(base.render!.meshInstances[0].mesh!.vertexBuffer!.device).toBe(owner.graphicsDevice);
  } finally { earth.dispose(); camera.destroy(); }
});

it('attaches late ground tiles to their owner after a second viewer starts and is destroyed', async () => {
  let complete!: (image: HTMLCanvasElement) => void;
  const loading = new Promise<HTMLCanvasElement>(resolve => { complete = resolve; });
  vi.mocked(groundTileImages.get).mockReturnValue(loading);
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const owner = createApp();
  const reference = SKYFALL_SCENES[0].georeference;
  const root = new Entity('Registered ground', owner); owner.root.addChild(root);
  const position = new Vec3(0, 0, reference.groundZ + 1000);
  const camera = { mainCamera: { getPosition: () => position, forward: new Vec3(0, 0, -1), right: Vec3.RIGHT, up: Vec3.UP },
    camera: { fov: 50, nearClip: .1, farClip: 100000 } } as unknown as Camera;
  const layer = createGroundMap(owner, root, reference, camera, vi.fn());
  createApp(); // Changes PlayCanvas's global current app while tiles are pending.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  complete(canvas);
  await settle();
  const assertOwnership = () => {
    const renderers = root.findComponents('render');
    expect(renderers.length).toBeGreaterThan(0);
    for (const render of renderers) expect(render.system.app).toBe(owner);
  };
  try {
    assertOwnership();
    apps.pop()!.destroy(); // The global current app is now null.
    position.x += 25000; now += 200;
    layer.update();
    await settle();
    assertOwnership();
  } finally { layer.dispose(); }
});
