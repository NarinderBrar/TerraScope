import { ADDRESS_CLAMP_TO_EDGE, FILTER_NEAREST, PIXELFORMAT_R8, Texture, type Entity } from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';
import { loadSegmentationMetadata } from './segmentationMetadata';

/** Changes only appearance; keeps the registered model, stream and camera intact. */
export function createSegmentedAppearance(app: PCApp, model: Entity, scene: string, signal: AbortSignal) {
  const component = model.gsplat;
  const textures = new Set<Texture>();
  const motion = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let disposed = false, active = false, version = 0, time = 0, elapsed = 0;
  const names = ['segmentMask', 'segmentActive', 'segmentMin', 'segmentInvSpan', 'segmentGrid', 'segmentAtlas', 'segmentTime', 'segmentMotion'];
  const dummy = new Texture(app.graphicsDevice, { name: 'Empty segments', width: 1, height: 1, format: PIXELFORMAT_R8, mipmaps: false });
  (dummy.lock() as Uint8Array).fill(0); dummy.unlock(); textures.add(dummy);
  component?.setParameter('segmentMask', dummy);
  component?.setParameter('segmentActive', 0);
  component?.setParameter('segmentMin', [0, 0, 0]);
  component?.setParameter('segmentInvSpan', [1, 1, 1]);
  component?.setParameter('segmentGrid', [512, 512, 64]);
  component?.setParameter('segmentAtlas', [4096, 4096]);
  component?.setParameter('segmentTime', 0);
  component?.setParameter('segmentMotion', motion?.matches ? 0 : 1);
  let pending: Promise<void> | undefined;
  const load = (): Promise<void> => pending ??= (async () => {
    const meta = await loadSegmentationMetadata(scene, signal);
    const response = await fetch(`${import.meta.env.BASE_URL}semantics/${meta.asset}`, { signal });
    if (!response.ok) throw new Error('Segmented colours could not be loaded. Try again.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== meta.byteLength) throw new Error('Incomplete segmented data.');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== meta.assetSha256) throw new Error('Segmented data checksum mismatch.');
    signal.throwIfAborted();
    if (disposed || !component) throw new Error('Viewer closed.');
    const texture = new Texture(app.graphicsDevice, { name: 'LangSplat segments', width: meta.atlasSize[0], height: meta.atlasSize[1], format: PIXELFORMAT_R8,
      mipmaps: false, flipY: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST, addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE });
    (texture.lock() as Uint8Array).set(new Uint8Array(bytes)); texture.unlock(); textures.add(texture);
    component.setParameter('segmentMask', texture);
    component.setParameter('segmentMin', meta.boundsMin);
    component.setParameter('segmentInvSpan', meta.boundsMin.map((v, i) => 1 / (meta.boundsMax[i] - v)));
    component.setParameter('segmentGrid', meta.gridSize);
    component.setParameter('segmentAtlas', meta.atlasSize);
  })().catch((error: unknown) => { pending = undefined; throw error; });
  return {
    async setEnabled(enabled: boolean): Promise<void> {
      const request = ++version;
      if (disposed || signal.aborted) return;
      if (!enabled) { active = false; component?.setParameter('segmentActive', 0); return; }
      await load();
      if (disposed || signal.aborted || request !== version) return;
      time = elapsed = 0; active = true;
      component?.setParameter('segmentTime', 0);
      component?.setParameter('segmentActive', 1);
    },
    update(delta: number): void {
      if (!active || disposed || signal.aborted) return;
      time += Math.max(0, Math.min(delta, .2)); elapsed += Math.max(0, delta);
      if (elapsed < .1) return;
      elapsed = 0;
      component?.setParameter('segmentTime', time);
      component?.setParameter('segmentMotion', motion?.matches ? 0 : 1);
    },
    dispose(): void {
      disposed = true; active = false; version++;
      for (const name of names) component?.deleteParameter(name);
      for (const texture of textures) texture.destroy(); textures.clear();
    },
  };
}
