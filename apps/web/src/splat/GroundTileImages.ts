import { fetchWorldImageryTile } from '../map/worldImagery';

async function decodeTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
  const image = await fetchWorldImageryTile(z, x, y, signal, new Map());
  if (!image) return null;
  const bitmap = await createImageBitmap(image.blob);
  try {
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d')!.drawImage(bitmap, image.left, image.top, image.size, image.size, 0, 0, 256, 256);
    return canvas;
  } finally { bitmap.close(); }
}

/** Share decoded imagery across viewers; GPU textures remain owned by their device. */
export class GroundTileImages {
  private loaded = new Map<string, HTMLCanvasElement>();
  private pending = new Map<string, {
    controller: AbortController; promise: Promise<HTMLCanvasElement | null>; users: number;
  }>();

  // At most 64 MiB of decoded RGBA imagery, independent of GPU residency.
  constructor(private capacity = 256, private decode = decodeTile) {}

  async get(z: number, x: number, y: number, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
    signal.throwIfAborted();
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    const cached = this.loaded.get(key);
    if (cached) {
      this.loaded.delete(key);
      this.loaded.set(key, cached);
      return cached;
    }
    let request = this.pending.get(key);
    if (!request || request.controller.signal.aborted) {
      const controller = new AbortController();
      const entry = { controller, users: 0, promise: Promise.resolve<HTMLCanvasElement | null>(null) };
      entry.promise = this.decode(z, x, y, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
        .then(canvas => {
          if (canvas && !controller.signal.aborted) {
            this.loaded.set(key, canvas);
            while (this.loaded.size > this.capacity) this.loaded.delete(this.loaded.keys().next().value!);
          }
          return canvas;
        }).finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
      this.pending.set(key, entry);
      request = entry;
    }
    const shared = request;
    shared.users++;
    return new Promise<HTMLCanvasElement | null>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        if (--shared.users === 0 && this.pending.get(key) === shared) shared.controller.abort();
        callback();
      };
      const abort = () => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      shared.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal.aborted) abort();
    });
  }
}

export const groundTileImages = new GroundTileImages();
