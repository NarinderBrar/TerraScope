import { afterEach, expect, it, vi } from 'vitest';
import { BLEND_NONE, BLEND_NORMAL, Mat4, Vec3, type StandardMaterial } from 'playcanvas';
import { createGroundMap } from '../src/splat/GroundMapLayer';
import { fetchWorldImageryTile } from '../src/map/worldImagery';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import type { PCApp } from '../src/splat/supersplat/pc-app';
import type { Camera } from '../src/splat/supersplat/camera';
import type { Entity } from 'playcanvas';

const resources = vi.hoisted(() => ({ textures: [] as { destroy: ReturnType<typeof vi.fn> }[], meshes: [] as { destroy: ReturnType<typeof vi.fn> }[], visibleMaterials: [] as StandardMaterial[] }));
vi.mock('../src/map/worldImagery', () => ({ fetchWorldImageryTile: vi.fn(), WORLD_IMAGERY_MAX_ZOOM: 20 }));
vi.mock('playcanvas', async (importOriginal) => {
  const original = await importOriginal<typeof import('playcanvas')>();
  class Texture {
    name: string;
    destroy = vi.fn();
    setSource = vi.fn();
    constructor(_: unknown, options: { name: string }) { this.name = options.name; resources.textures.push(this); }
  }
  class Mesh {
    destroy = vi.fn(); setPositions = vi.fn(); setNormals = vi.fn(); setUvs = vi.fn(); setIndices = vi.fn(); update = vi.fn();
    constructor() { resources.meshes.push(this); }
  }
  class Entity {
    enabled = true;
    addComponent = vi.fn(); addChild = vi.fn(); destroy = vi.fn();
    getWorldTransform() { return new original.Mat4(); }
  }
  return { ...original, Texture, Mesh, Entity, MeshInstance: class {
    constructor(public mesh: unknown, public material: StandardMaterial) { resources.visibleMaterials.push(material); }
  } };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resources.textures.length = resources.meshes.length = resources.visibleMaterials.length = 0; });
const settle = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };

it('streams new imagery with the camera, resumes after hiding, and destroys GPU residency on exit', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const drawImage = vi.fn();
  const close = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage }), width: 0, height: 0 }) });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close })));
  vi.mocked(fetchWorldImageryTile).mockResolvedValue({ blob: new Blob(['image']), left: 0, top: 0, size: 256 });
  const reference = SKYFALL_SCENES[0].georeference;
  const position = new Vec3(0, 0, reference.groundZ + 1000);
  const app = { graphicsDevice: { width: 1024, height: 768, maxAnisotropy: 4 }, once: (_: string, cb: () => void) => cb() } as unknown as PCApp;
  const modelRoot = { getWorldTransform: () => new Mat4(), addChild: vi.fn() } as unknown as Entity;
  const camera = { mainCamera: { getPosition: () => position, forward: new Vec3(0, 0, -1), right: Vec3.RIGHT, up: Vec3.UP },
    camera: { fov: 50, nearClip: .1, farClip: 100000 } } as unknown as Camera;
  const onStatus = vi.fn();
  const layer = createGroundMap(app, modelRoot, reference, camera, onStatus);
  await settle();
  expect(onStatus).toHaveBeenCalledWith('ready');
  expect(drawImage).toHaveBeenCalled();
  expect(resources.meshes.length).toBeGreaterThan(1);
  const groundMaterial = resources.visibleMaterials[0];
  // Keep map tiles behind splats at every camera angle. Only the globe
  // crossfade needs transparency; returning to the city restores opaque sorting.
  expect(groundMaterial.blendType).toBe(BLEND_NONE);
  expect(groundMaterial.transparent).toBe(false);
  expect(groundMaterial.depthWrite).toBe(false);
  layer.setOpacity!(.5);
  expect(groundMaterial.blendType).toBe(BLEND_NORMAL);
  expect(groundMaterial.opacity).toBe(.5);
  layer.setOpacity!(1);
  expect(groundMaterial.blendType).toBe(BLEND_NONE);
  expect(groundMaterial.transparent).toBe(false);
  const before = vi.mocked(fetchWorldImageryTile).mock.calls.length;
  layer.setVisible(false);
  position.x = 25000;
  now += 200;
  layer.update();
  await settle();
  expect(fetchWorldImageryTile).toHaveBeenCalledTimes(before);
  layer.setVisible(true);
  await settle();
  expect(vi.mocked(fetchWorldImageryTile).mock.calls.length).toBeGreaterThan(before);
  expect(resources.textures.length).toBeLessThanOrEqual(256);
  layer.dispose();
  layer.dispose();
  for (const texture of resources.textures) expect(texture.destroy).toHaveBeenCalledOnce();
  for (const mesh of resources.meshes) expect(mesh.destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(drawImage.mock.calls.length);
  const fetches = vi.mocked(fetchWorldImageryTile).mock.calls.length;
  const decodes = drawImage.mock.calls.length;
  // A new viewer/device rebuilds textures from shared images without downloading
  // or decoding the same geographic tiles after the old layer is disposed.
  const nextLayer = createGroundMap(app, modelRoot, reference, camera, vi.fn());
  await settle();
  expect(vi.mocked(fetchWorldImageryTile)).toHaveBeenCalledTimes(fetches);
  expect(drawImage).toHaveBeenCalledTimes(decodes);
  nextLayer.dispose();
});
