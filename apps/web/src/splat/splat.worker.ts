import { decodeSogCenters, sogTextureFiles, type SogChunkMeta } from './sogChunk';

const jobs = new Map<number, AbortController>();
self.onmessage = ({ data }: MessageEvent<{ id: number; type: 'load' | 'cancel'; url?: string }>) => {
  if (data.type === 'cancel') { jobs.get(data.id)?.abort(); return; }
  const controller = new AbortController();
  jobs.set(data.id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
  void (async () => {
    const response = await fetch(data.url!, { signal });
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Splat chunk unavailable (${response.status})`);
    const meta = await response.json() as SogChunkMeta;
    const files = sogTextureFiles(meta);
    const images: { name: ReturnType<typeof sogTextureFiles>[number]['name']; bitmap: ImageBitmap }[] = [];
    try {
      const results = await Promise.allSettled(files.map(async ({ name, file }) => {
        const response = await fetch(new URL(file, data.url), { signal });
        if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Splat texture unavailable (${response.status})`);
        const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        images.push({ name, bitmap });
        signal.throwIfAborted();
      }));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const pixels = (name: 'means_l' | 'means_u') => {
        const bitmap = images.find((image) => image.name === name)!.bitmap;
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const centers = decodeSogCenters(meta, pixels('means_l'), pixels('means_u'));
      signal.throwIfAborted();
      self.postMessage({ id: data.id, type: 'loaded', chunk: { meta, images, centers } }, { transfer: [centers.buffer, ...images.map(({ bitmap }) => bitmap)] });
    } catch (error) { images.forEach(({ bitmap }) => bitmap.close()); throw error; }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) self.postMessage({ id: data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }).finally(() => jobs.delete(data.id));
};
