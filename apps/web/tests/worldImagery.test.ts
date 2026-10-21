import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWorldImageryTile, worldImageryUrl, type ImageryTileCache } from '../src/map/worldImagery';

afterEach(() => vi.unstubAllGlobals());

describe('Esri ground imagery at fine zoom levels', () => {
  it('crops missing detail from the right parent quadrant and shares cached ancestors', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/tile/20/')) return new Response(null, { status: 404 });
      if (url.includes('/tile/19/')) return new Response('blank', { headers: { 'blank-tile': 'true' } });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const cache: ImageryTileCache = new Map();
    const signal = new AbortController().signal;
    const first = await fetchWorldImageryTile(20, 421, 790, signal, cache);
    expect(first).toMatchObject({ left: 64, top: 128, size: 64 });
    expect([...new Uint8Array(await first!.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      worldImageryUrl(20, 421, 790), worldImageryUrl(19, 210, 395), worldImageryUrl(18, 105, 197),
    ]);
    const neighbor = await fetchWorldImageryTile(20, 420, 790, signal, cache);
    expect(neighbor).toMatchObject({ left: 0, top: 128, size: 64 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('bounds missing-tile requests instead of descending indefinitely', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWorldImageryTile(20, 421, 790, new AbortController().signal, new Map())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not fetch parents after cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWorldImageryTile(20, 421, 790, controller.signal, new Map())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
