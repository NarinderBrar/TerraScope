import { afterEach, expect, it, vi } from 'vitest';
import { GSplatSogData, NullGraphicsDevice } from 'playcanvas';
import { readFileSync } from 'node:fs';
import { createSogResource } from '../src/splat/SplatChunkLoader';
import { sogTextureFiles, type DecodedSogChunk } from '../src/splat/sogChunk';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('creates a native resource from transferred centres without GPU readback or centre packing', async () => {
  class Bitmap { width = 256; height = 256; close = vi.fn(); }
  vi.stubGlobal('ImageBitmap', Bitmap);
  const device = new NullGraphicsDevice({ width: 64, height: 64 });
  const meta = JSON.parse(readFileSync(new URL('../public/splats/streamed/JAX_004/2_0/meta.json', import.meta.url), 'utf8'));
  const chunk: DecodedSogChunk = { meta, images: sogTextureFiles(meta).map(({ name }) => ({ name, bitmap: new Bitmap() as unknown as ImageBitmap })), centers: new Float32Array(meta.count * 3) };
  const readback = vi.spyOn(GSplatSogData.prototype, 'prepareGpuData');
  const packing = vi.spyOn(GSplatSogData.prototype, 'getCenters');
  const resource = await createSogResource(device, 'https://models.test/2_0/meta.json', chunk, new AbortController().signal);
  expect(readback).not.toHaveBeenCalled();
  expect(packing).not.toHaveBeenCalled();
  expect(resource.centers).toBe(chunk.centers);
  expect(resource.gsplatData.numSplats).toBe(meta.count);
  expect((resource.gsplatData as GSplatSogData).means_l?.getSource()).toBe(chunk.images[0].bitmap);
  expect(Number.isFinite(resource.aabb.center.x)).toBe(true);
  resource.destroy();
  expect(chunk.images.every(({ bitmap }) => vi.mocked(bitmap.close).mock.calls.length === 1)).toBe(true);
  device.destroy();
});
