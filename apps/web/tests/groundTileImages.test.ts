import { expect, it, vi } from 'vitest';
import { GroundTileImages } from '../src/splat/GroundTileImages';

const image = {} as HTMLCanvasElement;
const signal = () => new AbortController().signal;

it('reuses decoded imagery across viewers and wrapped map coordinates', async () => {
  const decode = vi.fn(async () => image);
  const cache = new GroundTileImages(2, decode);
  expect(await cache.get(2, -1, 1, signal())).toBe(image);
  expect(await cache.get(2, 3, 1, signal())).toBe(image);
  expect(decode).toHaveBeenCalledOnce();
});

it('shares pending work without one viewer cancellation aborting the other', async () => {
  let complete!: (value: HTMLCanvasElement) => void;
  let sharedSignal!: AbortSignal;
  const decode = vi.fn((_z, _x, _y, signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<HTMLCanvasElement>(resolve => { complete = resolve; });
  });
  const cache = new GroundTileImages(2, decode), first = new AbortController();
  const a = cache.get(2, 1, 1, first.signal), b = cache.get(2, 1, 1, signal());
  const cancelled = expect(a).rejects.toBeDefined();
  first.abort();
  await cancelled;
  expect(sharedSignal.aborted).toBe(false);
  complete(image);
  expect(await b).toBe(image);
  expect(await cache.get(2, 1, 1, signal())).toBe(image);
  expect(decode).toHaveBeenCalledOnce();
});

it('aborts unneeded work and lets a subsequent viewer retry it', async () => {
  const decode = vi.fn((_z, _x, _y, signal: AbortSignal) => new Promise<HTMLCanvasElement>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const cache = new GroundTileImages(2, decode), controller = new AbortController();
  const loading = cache.get(2, 1, 1, controller.signal);
  const cancelled = expect(loading).rejects.toBeDefined();
  controller.abort();
  await cancelled;
  decode.mockResolvedValueOnce(image);
  expect(await cache.get(2, 1, 1, signal())).toBe(image);
  expect(decode).toHaveBeenCalledTimes(2);
});

it('bounds decoded memory with LRU eviction and does not cache failures', async () => {
  const decode = vi.fn(async () => image as HTMLCanvasElement | null);
  const cache = new GroundTileImages(2, decode);
  await cache.get(3, 0, 0, signal());
  await cache.get(3, 1, 0, signal());
  await cache.get(3, 0, 0, signal());
  await cache.get(3, 2, 0, signal());
  await cache.get(3, 0, 0, signal());
  expect(decode).toHaveBeenCalledTimes(3);
  await cache.get(3, 1, 0, signal());
  expect(decode).toHaveBeenCalledTimes(4);
  decode.mockRejectedValueOnce(new Error('Network failed'));
  await expect(cache.get(3, 4, 0, signal())).rejects.toThrow('Network failed');
  decode.mockResolvedValueOnce(null);
  expect(await cache.get(3, 4, 0, signal())).toBeNull();
  expect(await cache.get(3, 4, 0, signal())).toBe(image);
});
