import { afterEach, describe, expect, it, vi } from 'vitest';
import { RasterClient } from '../src/data/RasterClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RasterClient request scheduling', () => {
  it('removes an aborted queued tile without starting a fetch', async () => {
    let finishFirst!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      finishFirst = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RasterClient('/raster', 1);
    const first = client.tile({
      collection: 'sentinel-2-l2a',
      itemId: 'first',
      profile: 'rgbn',
      z: 10,
      x: 1,
      y: 2,
    });
    const controller = new AbortController();
    const queued = client.tile(
      {
        collection: 'sentinel-2-l2a',
        itemId: 'second',
        profile: 'rgbn',
        z: 10,
        x: 2,
        y: 2,
      },
      { signal: controller.signal },
    );

    expect(client.inFlightCount).toBe(1);
    expect(client.pendingCount).toBe(1);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.pendingCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishFirst(new Response('upstream failed', { status: 502 }));
    await expect(first).rejects.toMatchObject({ status: 502 });
  });
});
