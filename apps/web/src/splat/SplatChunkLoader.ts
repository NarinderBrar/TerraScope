import {
  ADDRESS_CLAMP_TO_EDGE, FILTER_NEAREST, GSplatSogData, GSplatSogResource, PIXELFORMAT_RGBA8, Texture, type GraphicsDevice,
} from 'playcanvas';
import { SplatWorkerClient } from './SplatWorkerClient';
import { closeDecodedChunk, type DecodedSogChunk, type SplatStreamStatus } from './sogChunk';

/** Yield between small texture preparations, leaving input and coarse frames responsive. */
export function yieldForSplatUpload(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 0);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function createSogResource(device: GraphicsDevice, url: string, chunk: DecodedSogChunk, signal: AbortSignal): Promise<GSplatSogResource> {
  const data = new GSplatSogData();
  data.meta = chunk.meta;
  data.numSplats = chunk.meta.count;
  data.url = url;
  const assigned = new Set<ImageBitmap>();
  try {
    for (const { name, bitmap } of chunk.images) {
      await yieldForSplatUpload(signal);
      const texture = new Texture(device, { name: `${url}/${name}`, width: bitmap.width, height: bitmap.height,
        format: PIXELFORMAT_RGBA8, mipmaps: false, flipY: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE });
      data[name] = texture;
      // The engine accepts transferred ImageBitmaps; its public declaration
      // still lists only DOM image sources.
      texture.setSource(bitmap as unknown as Parameters<Texture['setSource']>[0]);
      assigned.add(bitmap);
      texture.setReleaseSourceAfterUpload();
    }
    signal.throwIfAborted();
    data.shBands = GSplatSogData.calcBands(data.sh_centroids?.width);
    data.prepareCodebook();
    // Centres came from the worker; avoid GPU readback and the large main-thread packing loop.
    const resource = new GSplatSogResource(device, data, { prepareCenters: false });
    resource.centers = chunk.centers;
    return resource;
  } catch (error) {
    data.destroy();
    // data owns assigned textures; unassigned transfers still need closing.
    for (const { bitmap } of chunk.images) if (!assigned.has(bitmap)) bitmap.close();
    throw error;
  }
}

/** Adapter for the engine's native, distance-prioritised spatial LOD loader. */
export class SplatChunkLoader {
  private queue = new Map<string, number>();
  private active = new Map<string, AbortController>();
  private resources = new Map<string, GSplatSogResource>();
  private failures = new Map<string, number>();
  private previousStatus = '';
  private closed = false;
  private firstResolve!: () => void;
  private firstReject!: (error: unknown) => void;
  readonly firstReady = new Promise<void>((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject; });
  constructor(private device: GraphicsDevice, private levels: Map<string, number>, private changed: (status: SplatStreamStatus) => void,
    private client = new SplatWorkerClient(), private create = createSogResource) {
    // A close can precede the session attaching its readiness await.
    void this.firstReady.catch(() => {});
  }
  load(url: string, priority = 0): void {
    if (this.closed || this.resources.has(url) || (this.failures.get(url) ?? 0) >= 3) return;
    const active = this.active.get(url);
    if (active) {
      // The camera can return before cancellation of an old request settles.
      if (active.signal.aborted) this.queue.set(url, priority);
      return;
    }
    this.queue.set(url, priority);
    this.pump();
  }
  dequeue(url: string): boolean { return this.queue.delete(url); }
  getResource(url: string): GSplatSogResource | undefined { return this.resources.get(url); }
  unload(url: string): void {
    this.queue.delete(url);
    this.active.get(url)?.abort();
    this.resources.get(url)?.destroy();
    this.resources.delete(url);
    this.failures.delete(url);
    this.report();
  }
  retry(): void {
    for (const url of this.failures.keys()) if (!this.resources.has(url) && !this.active.has(url)) this.queue.set(url, 0);
    this.failures.clear();
    this.pump();
  }
  private report(): void {
    const levels = [...this.resources.keys()].map((url) => (this.levels.get(url) ?? 2) + 1);
    const state = { loaded: this.resources.size, pending: this.active.size + this.queue.size,
      failed: [...this.failures.values()].filter((count) => count >= 3).length, bestLod: levels.length ? Math.min(...levels) : null };
    const key = `${state.loaded}/${state.pending}/${state.failed}/${state.bestLod}`;
    // Native requests are revisited every frame; avoid driving React at frame rate.
    if (key !== this.previousStatus) { this.previousStatus = key; this.changed(state); }
  }
  private pump(): void {
    if (this.closed) return;
    while (this.active.size < 2 && this.queue.size) {
      const next = [...this.queue].filter(([url]) => !this.active.has(url)).sort((a, b) => b[1] - a[1])[0];
      if (!next) break;
      const [url] = next;
      this.queue.delete(url);
      const controller = new AbortController();
      this.active.set(url, controller);
      void this.client.load(url, controller.signal).then(async (chunk) => {
        if (this.closed || controller.signal.aborted) { closeDecodedChunk(chunk); return; }
        const resource = await this.create(this.device, url, chunk, controller.signal);
        if (this.closed || controller.signal.aborted) { resource.destroy(); return; }
        this.resources.set(url, resource);
        this.failures.delete(url);
        this.firstResolve();
      }).catch((error: unknown) => {
        if (controller.signal.aborted || this.closed) return;
        const attempts = (this.failures.get(url) ?? 0) + 1;
        this.failures.set(url, attempts);
        if (attempts < 3) this.queue.set(url, -1);
        else if (!this.resources.size && this.active.size === 1 && !this.queue.size) this.firstReject(error);
      }).finally(() => {
        this.active.delete(url);
        if (!this.closed) { this.pump(); this.report(); }
      });
    }
    this.report();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    this.client.destroy();
    for (const resource of this.resources.values()) resource.destroy();
    this.resources.clear();
    this.queue.clear();
    this.firstReject(new DOMException('Splat loading cancelled', 'AbortError'));
  }
}
