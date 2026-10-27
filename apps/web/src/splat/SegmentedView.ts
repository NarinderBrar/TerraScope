import { Asset, Entity } from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';

const SOURCE_SHA = 'a4febf9866e1edddcfd24c1cde9c6ca529436a5259980640cd78b5d52c0c95a4';

export function validateSegmentedMetadata(value: unknown, scene: string): void {
  const meta = value as Record<string, unknown> | null;
  if (scene !== 'NYC_010' || !meta || meta.schemaVersion !== 1 || meta.scene !== scene
      || meta.kind !== 'experimental-segmented-splats' || meta.coordinateFrame !== 'registered-model-local'
      || meta.sourceSha256 !== SOURCE_SHA || meta.asset !== 'NYC_010-segmented.ply' || meta.geometryUnchanged !== true) {
    throw new Error('Segmented splats do not match this registered scene.');
  }
}

/** A registered, reduced-detail appearance variant; never creates a separate scene or camera. */
export function createSegmentedView(app: PCApp, root: Entity, normal: Entity, scene: string, signal: AbortSignal) {
  let desired = false, disposed = false;
  let entity: Entity | undefined, asset: Asset | undefined, pending: Promise<void> | undefined;
  const release = (): void => {
    entity?.destroy(); entity = undefined;
    if (asset) { app.assets?.remove(asset); asset.unload(); asset = undefined; }
  };
  const load = async (): Promise<void> => {
    const base = `${import.meta.env.BASE_URL}semantics/`;
    const response = await fetch(`${base}NYC_010-segmented.json`, { signal });
    if (!response.ok) throw new Error('Segmented view could not be loaded. Try again.');
    validateSegmentedMetadata(await response.json(), scene);
    signal.throwIfAborted();
    if (disposed) throw new Error('Viewer closed.');
    const loadedAsset = new Asset('NYC_010 segmented', 'gsplat', { url: `${base}NYC_010-segmented.ply` });
    asset = loadedAsset;
    app.assets.add(loadedAsset);
    await new Promise<void>((resolve, reject) => {
      const clean = () => { signal.removeEventListener('abort', abort); loadedAsset.off('load', loaded); loadedAsset.off('error', failed); };
      const loaded = () => {
        clean();
        if (disposed || signal.aborted) { loadedAsset.unload(); reject(signal.reason ?? new Error('Viewer closed.')); }
        else resolve();
      };
      const failed = (error: unknown) => { clean(); reject(new Error(String(error))); };
      // Keep completion listeners after abort to unload a late native resource.
      const abort = () => { app.assets?.remove(loadedAsset); loadedAsset.unload(); reject(signal.reason); };
      loadedAsset.once('load', loaded);
      loadedAsset.once('error', failed);
      signal.addEventListener('abort', abort, { once: true });
      app.assets.load(loadedAsset);
    });
    signal.throwIfAborted();
    if (disposed) throw new Error('Viewer closed.');
    entity = new Entity('NYC_010 segmented appearance', app);
    entity.enabled = false;
    root.addChild(entity);
    entity.addComponent('gsplat', { asset: loadedAsset, unified: true });
  };
  return {
    async setEnabled(enabled: boolean): Promise<void> {
      if (disposed || signal.aborted) return;
      if (enabled && scene !== 'NYC_010') throw new Error('Segmentation is available for Union Square only.');
      desired = enabled;
      if (!enabled) {
        normal.enabled = true;
        if (entity) entity.enabled = false;
        return;
      }
      if (!pending) pending = load().catch((error: unknown) => {
        pending = undefined;
        if (!disposed && !signal.aborted) { release(); normal.enabled = true; }
        throw error;
      });
      await pending;
      if (disposed || signal.aborted) return;
      normal.enabled = !desired;
      if (entity) entity.enabled = desired;
    },
    dispose(): void { disposed = true; desired = false; release(); },
  };
}
