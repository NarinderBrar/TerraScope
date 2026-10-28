// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { darkVectorUrl, decodeVectorTile, fetchDarkVectorTile, renderVectorTile, vectorPaint } from '../src/map/darkVectorTiles';

const uint = (value: number): number[] => {
  const result: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); result.push(byte + (value ? 128 : 0)); } while (value);
  return result;
};
const block = (tag: number, bytes: number[]): number[] => [tag, ...uint(bytes.length), ...bytes];
const text = (value: string): number[] => [...new TextEncoder().encode(value)];
// Geometry has negative deltas, two polygon rings, and an unknown 64-bit feature ID.
const fixture = new Uint8Array(block(26, [
  ...block(10, text('Water area')), 40, ...uint(4096),
  ...block(18, [8, 255, 255, 255, 255, 255, 255, 255, 255, 127, 24, 3,
    ...block(34, [9, 20, 20, 26, 40, 0, 0, 40, 39, 0, 15, 9, 10, 29, 18, 0, 20, 20, 0, 15])]),
  ...block(26, text('ignored-key')),
]));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function canvasContext() {
  const context = { fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), fillRect: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as GPUCanvasContext);
  return context;
}
it('decodes MVT coordinates, ring closure and holes without losing north/south orientation', () => {
  const layers = decodeVectorTile(fixture);
  expect(layers).toHaveLength(1); expect(layers[0].extent).toBe(4096);
  expect(layers[0].features[0].paths).toEqual([
    [[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]],
    [[15, 15], [15, 25], [25, 25], [15, 15]],
  ]);
  const ctx = canvasContext();
  renderVectorTile(layers);
  expect(ctx.moveTo).toHaveBeenCalledWith(10, 10);
  expect(ctx.lineTo).toHaveBeenCalledWith(30, 30);
  expect(ctx.fill).toHaveBeenCalledWith('evenodd');
  expect(ctx.fillStyle).toBe('#081b28');
});
it('rejects truncated fields and illegal geometry commands rather than rendering corrupt coordinates', () => {
  expect(() => decodeVectorTile(new Uint8Array([26, 127]))).toThrow('Truncated');
  expect(() => decodeVectorTile(new Uint8Array([26, 2, 10, 2]))).toThrow('Truncated');
  const invalid = new Uint8Array(block(26, [...block(18, [24, 2, ...block(34, [11, 0, 0])])]));
  expect(() => decodeVectorTile(invalid)).toThrow('geometry');
  expect(decodeVectorTile(new Uint8Array())).toEqual([]); // Valid empty/ocean tile.
});
it('draws dark roads, water, parks and buildings in geographic layer order', () => {
  expect(vectorPaint('Road')?.stroke).toBe('#536275');
  expect(vectorPaint('Building')?.order).toBeLessThan(vectorPaint('Road')!.order);
  expect(vectorPaint('Land')?.order).toBeLessThan(vectorPaint('Water area')!.order);
  expect(vectorPaint('Vegetation')?.fill).toBe('#10201e');
  expect(vectorPaint('Road label')).toBeNull();
});
it('overzooms vector geometry with exact child cropping and falls back to the correct geographic parent', async () => {
  const context = canvasContext();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response(fixture)));
  const image = await fetchDarkVectorTile(18, 12345, 67890, new AbortController().signal);
  expect(image?.width).toBe(512);
  expect(fetch).toHaveBeenNthCalledWith(1, darkVectorUrl(16, Math.floor(12345 / 4), Math.floor(67890 / 4)), expect.anything());
  expect(fetch).toHaveBeenNthCalledWith(2, darkVectorUrl(15, Math.floor(12345 / 8), Math.floor(67890 / 8)), expect.anything());
  expect(context.translate).toHaveBeenCalledWith(-(12345 % 8) * 512, -(67890 % 8) * 512);
  expect(context.scale).toHaveBeenCalledWith(1, 1);
});
it('does not fetch or render tiles after abort', async () => {
  const controller = new AbortController(); controller.abort();
  vi.stubGlobal('fetch', vi.fn());
  await expect(fetchDarkVectorTile(14, 10, 20, controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
