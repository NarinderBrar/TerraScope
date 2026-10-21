import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function setup(failTexture = false) {
  const meta = JSON.parse(readFileSync(new URL('../public/splats/streamed/JAX_004/2_0/meta.json', import.meta.url), 'utf8'));
  const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  const fetcher = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('meta.json')) return { ok: true, headers: new Headers(), json: async () => meta };
    return { ok: !(failTexture && String(url).endsWith('quats.webp')), status: 503, headers: new Headers(), blob: async () => new Blob() };
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const bitmap = { width: 512, height: 512, close: vi.fn() }; bitmaps.push(bitmap); return bitmap;
  }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage() {}, getImageData: () => {
      const data = new Uint8ClampedArray(this.width * this.height * 4);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { data };
    } }; }
  });
  let finish!: (value: any) => void;
  const result = new Promise<any>((resolve) => { finish = resolve; });
  const postMessage = vi.fn((message, options) => { finish({ message, options }); });
  const scope = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, postMessage };
  vi.stubGlobal('self', scope);
  await import('../src/splat/splat.worker');
  scope.onmessage!({ data: { id: 1, type: 'load', url: 'https://models.test/2_0/meta.json' } } as MessageEvent);
  return { result, bitmaps, fetcher, meta };
}

it('executes the worker entry, decodes positions and transfers all image and buffer ownership', async () => {
  const { result, bitmaps, fetcher, meta } = await setup();
  const { message, options } = await result;
  expect(message.type).toBe('loaded');
  expect(message.chunk.centers).toHaveLength(meta.count * 3);
  expect(message.chunk.centers[0]).toBeCloseTo(Math.sign(meta.means.mins[0]) * Math.expm1(Math.abs(meta.means.mins[0])), 3);
  expect(options.transfer).toEqual([message.chunk.centers.buffer, ...message.chunk.images.map(({ bitmap }: any) => bitmap)]);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(vi.mocked(createImageBitmap)).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 0)).toBe(true);
});

it('closes decoded textures and reports a partial chunk failure without publishing corrupt data', async () => {
  const { result, bitmaps } = await setup(true);
  const { message } = await result;
  expect(message).toEqual({ id: 1, type: 'error', message: 'Splat texture unavailable (503)' });
  expect(bitmaps).toHaveLength(6);
  expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
});
