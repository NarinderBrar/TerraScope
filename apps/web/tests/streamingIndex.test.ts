// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { Entity, http, NullGraphicsDevice } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { fetchStreamingIndex, loadStreamingIndex, type StreamedSplatResource } from '../src/splat/streamingIndex';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('loads an absolute-URL octree through the native parser and accepts it in a unified component', async () => {
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const index = JSON.parse(readFileSync('public/splats/streamed/JAX_004/lod-meta.json', 'utf8'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), json: async () => structuredClone(index) }));
  vi.stubGlobal('Blob', NodeBlob);
  let nativeJson: Promise<string>;
  const create = vi.fn((blob: Blob | MediaSource) => { nativeJson = (blob as unknown as NodeBlob).text(); return 'blob:streamed-index'; });
  const revoke = vi.fn();
  // Preserve URL's constructor: the index and chunk paths must remain real URLs.
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke; });
  vi.spyOn(http, 'get').mockImplementation((_url, _options, callback) => {
    void nativeJson.then((json) => callback(null, JSON.parse(json)));
    return {} as XMLHttpRequest;
  });
  try {
    const url = 'https://models.test/splats/streamed/JAX_004/lod-meta.json';
    const signal = new AbortController().signal;
    const prepared = fetchStreamingIndex(url, signal);
    const asset = await loadStreamingIndex(app, 'JAX_004', url, signal, prepared);
    expect(fetch).toHaveBeenCalledOnce();
    const resource = asset.resource as unknown as StreamedSplatResource;
    expect(resource.octree.files).toHaveLength(index.filenames.length);
    expect(resource.octree.files.every((file) => file.url.startsWith('https://models.test/splats/streamed/JAX_004/'))).toBe(true);
    expect(new Set(resource.octree.files.map((file) => file.lodLevel))).toEqual(new Set([0, 1, 2]));
    expect(revoke).toHaveBeenCalledWith('blob:streamed-index');
    const entity = new Entity('Registered model');
    app.root.addChild(entity);
    entity.addComponent('gsplat', { asset, unified: true, lodRangeMin: 0, lodRangeMax: 2 });
    expect(entity.gsplat?.resource).toBe(asset.resource);
    entity.destroy();
    app.assets.remove(asset); asset.unload();
  } finally { app.destroy(); }
});

it('cancels safely if app teardown precedes the index abort listener and unloads late resources', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), json: async () => ({
    lodLevels: 3, filenames: ['2_0/meta.json'], tree: { bound: { min: [0, 0, 0], max: [1, 1, 1] } },
  }) }));
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = () => 'blob:cancelled-index';
    static override revokeObjectURL = vi.fn();
  });
  const assets = { add: vi.fn(), remove: vi.fn(), load: vi.fn() };
  const app = { assets: assets as typeof assets | null };
  const controller = new AbortController();
  // Session disposal is registered first and destroys the native registry.
  controller.signal.addEventListener('abort', () => { app.assets = null; });
  const loading = loadStreamingIndex(app as unknown as PCApp, 'cancelled', 'https://models.test/lod-meta.json', controller.signal);
  const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(assets.load).toHaveBeenCalledOnce());
  const asset = assets.load.mock.calls[0][0];
  controller.abort();
  await rejected;
  const destroy = vi.fn();
  asset.resource = { destroy };
  asset.fire('load', asset);
  expect(destroy).toHaveBeenCalledOnce();
});
