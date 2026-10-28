import { ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR, Mat4, PIXELFORMAT_R8, Texture, type Entity } from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';
import { createSegmentedAppearance } from './SegmentedAppearance';
import { BUILDING_GLOW_GLSL, BUILDING_GLOW_WGSL } from './buildingGlowShaders';

import { parseBuildingGlowMetadata, stemFor, type BuildingGlowMetadata, type GlowCategory } from './glowMetadata';
export { parseBuildingGlowMetadata, type BuildingGlowMetadata, type GlowCategory } from './glowMetadata';

export function buildingPulse(seconds: number, reducedMotion = false): number {
  return reducedMotion ? .35 : .075 + .425 * (.5 - .5 * Math.cos(seconds * 2 * Math.PI / 1.8));
}
export function revealHeight(min: number, max: number, seconds: number, reducedMotion = false): number {
  const feather = Math.max(.5, (max - min) / 40);
  const t = reducedMotion ? 1 : Math.max(0, Math.min(1, seconds / 2.4));
  return min - feather + (max - min + 3 * feather) * t;
}

/** One composable color/alpha shader for reveal and LangSplat category glow. */
export function createLangSplatBuildingGlow(app: PCApp, root: Entity, model: Entity, scene: string, signal: AbortSignal,
  revealBounds?: readonly [number, number], metresPerUnit = 1) {
  let desired = false, active = false, disposed = false, time = 0, elapsed = 0;
  let category: GlowCategory = 'buildings', request = 0;
  let revealing = !!revealBounds, started = false, revealTime = 0;
  const bounds: readonly [number, number] = revealBounds ?? [-1, 1];
  const cache = new Map<GlowCategory, Promise<{ texture: Texture; metadata: BuildingGlowMetadata }>>();
  const textures = new Set<Texture>();
  const motion = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const component = model.gsplat;
  const segmented = createSegmentedAppearance(app, model, scene, signal);
  let modelTransform = root.getWorldTransform().clone();
  const names = ['buildingGlowMask', 'buildingGlowWorldToModel', 'buildingGlowMin', 'buildingGlowInvSpan', 'buildingGlowPulse',
    'buildingGlowGridSize', 'buildingGlowAtlasSize', 'buildingGlowTime', 'buildingGlowKind', 'buildingGlowMetresPerUnit',
    'buildingGlowMinZ', 'buildingGlowCutoff', 'buildingGlowActive', 'buildingGlowTint', 'buildingRevealZ', 'buildingRevealFeather'];
  const dummy = new Texture(app.graphicsDevice, { name: 'Empty glow mask', width: 1, height: 1, format: PIXELFORMAT_R8, mipmaps: false });
  (dummy.lock() as Uint8Array).fill(0); dummy.unlock(); textures.add(dummy);
  component?.setParameter('buildingGlowMask', dummy);
  component?.setParameter('buildingGlowWorldToModel', new Mat4().copy(root.getWorldTransform()).invert().data);
  component?.setParameter('buildingGlowMin', [0, 0, 0]);
  component?.setParameter('buildingGlowInvSpan', [1, 1, 1]);
  component?.setParameter('buildingGlowGridSize', [256, 256, 64]);
  component?.setParameter('buildingGlowAtlasSize', [2048, 2048]);
  component?.setParameter('buildingGlowTime', 0);
  component?.setParameter('buildingGlowKind', 0);
  component?.setParameter('buildingGlowMetresPerUnit', metresPerUnit);
  component?.setParameter('buildingGlowMinZ', -1e10);
  component?.setParameter('buildingGlowCutoff', .02); // fixed maximum coverage
  component?.setParameter('buildingGlowPulse', buildingPulse(0, motion?.matches));
  component?.setParameter('buildingGlowActive', 0);
  component?.setParameter('buildingGlowTint', [.04, .5, 1]);
  component?.setParameter('buildingRevealFeather', Math.max(.5, (bounds[1] - bounds[0]) / 40));
  component?.setParameter('buildingRevealZ', revealing ? revealHeight(...bounds, 0) : 1e10);
  component?.setWorkBufferModifier({ glsl: BUILDING_GLOW_GLSL, wgsl: BUILDING_GLOW_WGSL });

  const load = (target: GlowCategory) => {
    let pending = cache.get(target);
    if (!pending) {
      pending = (async () => {
        const base = `${import.meta.env.BASE_URL}semantics/`, stem = stemFor(target);
        const response = await fetch(`${base}${scene}-${stem}-glow.json`, { signal });
        if (!response.ok) throw new Error('LangSplat features could not be loaded. Try again.');
        const meta = parseBuildingGlowMetadata(await response.json(), scene, target);
        const binary = await fetch(`${base}${meta.asset}`, { signal });
        if (!binary.ok) throw new Error('LangSplat glow mask could not be loaded. Try again.');
        const bytes = await binary.arrayBuffer();
        if (bytes.byteLength !== meta.byteLength) throw new Error('Incomplete LangSplat glow mask.');
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
        if (hash !== meta.assetSha256) throw new Error('LangSplat glow mask checksum mismatch.');
        signal.throwIfAborted();
        if (disposed) throw new Error('Viewer closed.');
        const texture = new Texture(app.graphicsDevice, { name: `LangSplat ${target}`, width: meta.atlasSize[0], height: meta.atlasSize[1],
          format: PIXELFORMAT_R8, mipmaps: false, flipY: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
          addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE });
        (texture.lock() as Uint8Array).set(new Uint8Array(bytes)); texture.unlock(); textures.add(texture);
        return { texture, metadata: meta };
      })().catch((error: unknown) => { cache.delete(target); throw error; });
      cache.set(target, pending);
    }
    return pending;
  };
  const enable = async (): Promise<void> => {
    const version = ++request, target = category;
    const { texture, metadata: meta } = await load(target);
    if (!desired || disposed || signal.aborted || version !== request) return;
    if (!component) throw new Error('The splat renderer is unavailable.');
    component.setParameter('buildingGlowMask', texture);
    component.setParameter('buildingGlowMin', meta.boundsMin);
    component.setParameter('buildingGlowGridSize', meta.gridSize);
    component.setParameter('buildingGlowAtlasSize', meta.atlasSize);
    component.setParameter('buildingGlowKind', target === 'buildings' ? 0 : 1);
    component.setParameter('buildingGlowMinZ', meta.minimumLocalZ);
    component.setParameter('buildingGlowInvSpan', meta.boundsMin.map((v, i) => 1 / (meta.boundsMax[i] - v)));
    component.setParameter('buildingGlowTint', target === 'buildings' ? [.04, .5, 1] : [.18, 1, .38]);
    component.setParameter('buildingGlowActive', 1);
    component.setParameter('buildingGlowTime', 0);
    component.setParameter('buildingGlowPulse', buildingPulse(0, motion?.matches));
    time = 0; active = true;
  };
  return {
    async setSegmentedEnabled(enabled: boolean): Promise<void> {
      desired = active = false; request++;
      component?.setParameter('buildingGlowActive', 0);
      await segmented.setEnabled(enabled);
    },
    startReveal(): void {
      started = true;
      if (motion?.matches) { component?.setParameter('buildingRevealZ', revealHeight(...bounds, 0, true)); revealing = false; }
    },
    async setEnabled(enabled: boolean): Promise<void> {
      if (disposed || signal.aborted) return;
      desired = enabled;
      if (!enabled) { request++; active = false; component?.setParameter('buildingGlowActive', 0); return; }
      try { await enable(); } catch (error) { desired = false; throw error; }
    },
    async setCategory(target: GlowCategory): Promise<void> {
      if (target !== 'buildings' && target !== 'vegetation') throw new Error('Unknown glow category.');
      const previous = category;
      category = target;
      try { if (desired && !disposed && !signal.aborted) await enable(); }
      catch (error) { category = previous; throw error; }
    },
    update(delta: number): void {
      if (disposed || signal.aborted) return;
      segmented.update(delta);
      const transform = root.getWorldTransform();
      if (!modelTransform.equals(transform)) {
        modelTransform = transform.clone();
        component?.setParameter('buildingGlowWorldToModel', new Mat4().copy(transform).invert().data);
      }
      const step = Math.max(0, Math.min(delta, .2));
      time += step; elapsed += Math.max(0, delta);
      if (revealing && started) revealTime += step;
      if (elapsed < .1) return;
      elapsed = 0;
      if (revealing && started) {
        component?.setParameter('buildingRevealZ', revealHeight(...bounds, revealTime, motion?.matches));
        if (revealTime >= 2.4 || motion?.matches) revealing = false;
      }
      if (active) {
        const scanTime = motion?.matches ? 0 : time;
        if (component?.getParameter('buildingGlowTime') !== scanTime) component?.setParameter('buildingGlowTime', scanTime);
        const next = buildingPulse(time, motion?.matches);
        if (component?.getParameter('buildingGlowPulse') !== next) component?.setParameter('buildingGlowPulse', next);
      }
    },
    dispose(): void {
      disposed = true; desired = active = false; request++;
      component?.setWorkBufferModifier(null);
      segmented.dispose();
      for (const name of names) component?.deleteParameter(name);
      for (const texture of textures) texture.destroy(); textures.clear();
    },
  };
}
