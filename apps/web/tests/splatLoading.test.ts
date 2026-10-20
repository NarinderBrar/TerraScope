import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSplatBlob } from '../src/splat/file-handler';

afterEach(() => vi.unstubAllGlobals());
describe('city asset loading', () => {
  it('reports download progress and preserves binary bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-length': '4' } })));
    const progress = vi.fn();
    const blob = await fetchSplatBlob('/model.sog', new AbortController().signal, progress);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([80, 75, 3, 4]);
    expect(progress).toHaveBeenLastCalledWith(expect.stringContaining('Downloading'), 1);
  });
  it.each([
    new Response('missing', { status: 404 }),
    new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html' } }),
  ])('rejects missing models before binary decoding', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchSplatBlob('/missing.sog', new AbortController().signal, vi.fn())).rejects.toThrow('City model is unavailable');
  });
  it('passes the cancellation signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn((_url, { signal }) => Promise.reject(signal.reason));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSplatBlob('/model.sog', controller.signal, vi.fn())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith('/model.sog', { signal: controller.signal });
  });
});
