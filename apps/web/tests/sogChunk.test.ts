import { describe, expect, it } from 'vitest';
import { decodeSogCenters, sogTextureFiles, type SogChunkMeta } from '../src/splat/sogChunk';

const meta: SogChunkMeta = { version: 2, count: 2,
  means: { mins: [-2, -1, 0], maxs: [2, 1, 3], files: ['means_l.webp', 'means_u.webp'] },
  scales: { files: ['scales.webp'], codebook: [] }, quats: { files: ['quats.webp'] }, sh0: { files: ['sh0.webp'], codebook: [] } };

describe('worker SOG position decoding', () => {
  it('matches the engine log-space decoder, including negative registered coordinates', () => {
    const low = new Uint8Array([0, 255, 0, 255, 255, 0, 255, 255]);
    const high = new Uint8Array([0, 255, 0, 255, 255, 0, 255, 255]);
    const points = decodeSogCenters(meta, low, high);
    const expected = [-Math.expm1(2), Math.expm1(1), 0, Math.expm1(2), -Math.expm1(1), Math.expm1(3)];
    expected.forEach((value, index) => expect(points[index]).toBeCloseTo(value, 5));
    expect(points.buffer.byteLength).toBe(2 * 3 * 4);
  });
  it('rejects incomplete or premultiplied position textures instead of shifting the model', () => {
    expect(() => decodeSogCenters(meta, new Uint8Array(4), new Uint8Array(8))).toThrow('Incomplete');
    expect(() => decodeSogCenters(meta, new Uint8Array(8), new Uint8Array(8))).toThrow('opaque');
  });
  it('bounds chunk size and validates all texture filenames before fetching', () => {
    expect(sogTextureFiles(meta).map((file) => file.name)).toEqual(['means_l', 'means_u', 'quats', 'scales', 'sh0']);
    expect(() => sogTextureFiles({ ...meta, count: 131073 })).toThrow('oversized');
    expect(() => sogTextureFiles({ ...meta, sh0: { files: ['../other.webp'] } })).toThrow('filename');
    expect(() => sogTextureFiles({ ...meta, means: { ...meta.means, mins: [NaN, 0, 0] } })).toThrow('bounds');
  });
});
