import { Asset, type BoundingBox } from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';
import type { SplatChunkLoader } from './SplatChunkLoader';
export interface StreamedSplatResource {
  aabb: BoundingBox;
  octree: { files: { url: string; lodLevel: number }[]; assetLoader: { destroy(): void } | SplatChunkLoader | null };
}

/** Fetch independently of GPU initialization so these startup costs overlap. */
export async function fetchStreamingIndex(url: string, signal: AbortSignal) {
  const absolute = new URL(url, window.location.href).href;
  const response = await fetch(absolute, { signal });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`3D tile index is unavailable (${response.status}).`);
  const meta = await response.json();
  if (meta.lodLevels !== 3 || !Array.isArray(meta.filenames) || !meta.filenames.length || !meta.tree?.bound) throw new Error('Invalid 3D tile index.');
  meta.filenames = meta.filenames.map((file: string) => new URL(file, absolute).href);
  if (meta.environment) throw new Error('Unexpected splat environment in registered city tiles.');
  signal.throwIfAborted();
  return meta;
}

/** Let the native parser construct the resource, preserving engine class identity. */
export async function loadStreamingIndex(app: PCApp, id: string, url: string, signal: AbortSignal,
  prepared?: ReturnType<typeof fetchStreamingIndex>): Promise<Asset> {
  const meta = await (prepared ?? fetchStreamingIndex(url, signal));
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  const asset = new Asset(id, 'gsplat', { url: objectUrl, filename: 'lod-meta.json' });
  app.assets.add(asset);
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => { signal.removeEventListener('abort', abort); asset.off('load', loaded); asset.off('error', failed); };
      const loaded = () => {
        clean();
        if (signal.aborted) { asset.unload(); reject(signal.reason); }
        else resolve();
      };
      const failed = (error: unknown) => { clean(); reject(new Error(String(error))); };
      // Keep the load callback until the native parser settles, so a late resource
      // after cancellation is unloaded as well.
      const abort = () => { app.assets?.remove(asset); asset.unload(); reject(signal.reason); };
      asset.once('load', loaded);
      asset.once('error', failed);
      signal.addEventListener('abort', abort, { once: true });
      app.assets.load(asset);
    });
    signal.throwIfAborted();
    return asset;
  } catch (error) { app.assets?.remove(asset); asset.unload(); throw error; }
  finally { URL.revokeObjectURL(objectUrl); }
}
