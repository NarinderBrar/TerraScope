export interface SogChannel { files: string[]; mins?: number[]; maxs?: number[]; codebook?: number[] }
export interface SogChunkMeta {
  version: 2;
  count: number;
  means: SogChannel & { mins: number[]; maxs: number[] };
  scales: SogChannel;
  quats: SogChannel;
  sh0: SogChannel;
  shN?: SogChannel;
}
export type SogTextureName = 'means_l' | 'means_u' | 'quats' | 'scales' | 'sh0' | 'sh_centroids' | 'sh_labels';
export interface DecodedSogChunk {
  meta: SogChunkMeta;
  images: { name: SogTextureName; bitmap: ImageBitmap }[];
  centers: Float32Array<ArrayBuffer>;
}
export interface SplatStreamStatus { loaded: number; pending: number; failed: number; bestLod: number | null }
export const MAX_CHUNK_SPLATS = 131072;

export function sogTextureFiles(meta: SogChunkMeta): { name: SogTextureName; file: string }[] {
  if (meta.version !== 2 || !Number.isSafeInteger(meta.count) || meta.count < 1 || meta.count > MAX_CHUNK_SPLATS) throw new Error('Invalid or oversized SOG chunk');
  if (meta.means?.mins?.length !== 3 || meta.means?.maxs?.length !== 3
    || [...meta.means.mins, ...meta.means.maxs].some((value) => !Number.isFinite(value))) throw new Error('Invalid chunk position bounds');
  const files: { name: SogTextureName; file: string }[] = [
    { name: 'means_l', file: meta.means.files[0] }, { name: 'means_u', file: meta.means.files[1] },
    { name: 'quats', file: meta.quats.files[0] }, { name: 'scales', file: meta.scales.files[0] }, { name: 'sh0', file: meta.sh0.files[0] },
  ];
  if (meta.shN) files.push({ name: 'sh_centroids', file: meta.shN.files[0] }, { name: 'sh_labels', file: meta.shN.files[1] });
  for (const { file } of files) if (!file || !/^[\w.-]+\.webp$/.test(file) || file.includes('..')) throw new Error('Invalid SOG texture filename');
  return files;
}

/** The engine's SOG-v2 position decoder, run exclusively inside the loading worker. */
export function decodeSogCenters(meta: SogChunkMeta, lower: Uint8ClampedArray | Uint8Array, upper: Uint8ClampedArray | Uint8Array): Float32Array<ArrayBuffer> {
  if (lower.length < meta.count * 4 || upper.length < meta.count * 4) throw new Error('Incomplete SOG positions');
  const result = new Float32Array(meta.count * 3);
  for (let i = 0; i < meta.count; i++) {
    if (lower[i * 4 + 3] !== 255 || upper[i * 4 + 3] !== 255) throw new Error('Position textures must be opaque');
    for (let axis = 0; axis < 3; axis++) {
      const t = ((upper[i * 4 + axis] << 8) + lower[i * 4 + axis]) / 65535;
      const log = meta.means.mins[axis] * (1 - t) + meta.means.maxs[axis] * t;
      result[i * 3 + axis] = Math.sign(log) * Math.expm1(Math.abs(log));
    }
  }
  return result;
}
export function closeDecodedChunk(chunk: DecodedSogChunk): void { chunk.images.forEach(({ bitmap }) => bitmap.close()); }
