// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { Entity, Mat4, NullGraphicsDevice, Vec3 } from 'playcanvas';
import { afterEach, expect, it, vi } from 'vitest';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { buildingPulse, createLangSplatBuildingGlow, parseBuildingGlowMetadata, revealHeight } from '../src/splat/LangSplatBuildingGlow';

const metadata = JSON.parse(readFileSync('public/semantics/NYC_010-building-glow.json', 'utf8'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rejects another source or coordinate frame and respects reduced motion', () => {
  expect(parseBuildingGlowMetadata(metadata, 'NYC_010')).toEqual(metadata);
  for (const bad of [{ ...metadata, sourceSha256: 'other' }, { ...metadata, boundsMax: metadata.boundsMin },
    { ...metadata, coordinateFrame: 'world' }, { ...metadata, byteLength: 5 }]) {
    expect(() => parseBuildingGlowMetadata(bad, 'NYC_010')).toThrow();
  }
  expect(() => parseBuildingGlowMetadata(metadata, 'NYC_004')).toThrow();
  expect(buildingPulse(0)).toBeCloseTo(.075);
  expect(buildingPulse(.9)).toBeCloseTo(.5);
  expect(buildingPulse(1.8)).toBeCloseTo(.075);
  expect(buildingPulse(0, true)).toBe(buildingPulse(.9, true));
  expect(revealHeight(-40, 100, 0)).toBeLessThan(-40);
  expect(revealHeight(-40, 100, 1.2)).toBeGreaterThan(-40);
  expect(revealHeight(-40, 100, 2.4)).toBeGreaterThan(100);
  expect(revealHeight(-40, 100, 0, true)).toBeGreaterThan(100);
});

it('loads real LangSplat evidence and modifies original splat colors without changing the entity or root', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(new Uint8Array(readFileSync(`public/semantics/${url.split('/').at(-1)}`)))));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const root = new Entity('Registered model root'), model = new Entity('Original streamed splats');
  root.setLocalEulerAngles(-90, 0, 0); app.root.addChild(root); root.addChild(model);
  model.addComponent('gsplat', { unified: true });
  const component = model.gsplat!;
  const modifier = vi.spyOn(component, 'setWorkBufferModifier');
  const controller = new AbortController();
  const glow = createLangSplatBuildingGlow(app, root, model, 'NYC_010', controller.signal, [-40, 100]);
  const before = root.getWorldTransform().clone();
  try {
    expect(fetch).not.toHaveBeenCalled();
    await glow.setEnabled(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(model.enabled).toBe(true);
    expect(model.gsplat).toBe(component);
    expect(root.getWorldTransform().equals(before)).toBe(true);
    const inverse = new Mat4().set(Array.from(component.getParameter('buildingGlowWorldToModel') as Float32Array));
    const source = new Vec3(10, 20, -25);
    expect(inverse.transformPoint(before.transformPoint(source)).distance(source)).toBeLessThan(1e-5);
    const texture = component.getParameter('buildingGlowMask') as unknown as { width: number; height: number };
    expect(texture.width).toBe(2048); expect(texture.height).toBe(2048);
    const initial = component.getParameter('buildingGlowPulse');
    expect(component.getParameter('buildingGlowCutoff')).toBe(.02);
    glow.update(.01); expect(component.getParameter('buildingGlowPulse')).toBe(initial);
    glow.update(.15); expect(component.getParameter('buildingGlowPulse')).not.toBe(initial);
    expect(component.getParameter('buildingRevealZ')).toBeLessThan(-40);
    glow.startReveal();
    for (let i = 0; i < 13; i++) glow.update(.2);
    expect(component.getParameter('buildingRevealZ')).toBeGreaterThan(100);
    await glow.setCategory('vegetation');
    expect(component.getParameter('buildingGlowTint')).toEqual([.18, 1, .38]);
    expect(fetch).toHaveBeenCalledTimes(4);
    await glow.setCategory('buildings'); expect(fetch).toHaveBeenCalledTimes(4);
    await glow.setEnabled(false);
    expect(component.getParameter('buildingGlowActive')).toBe(0);
    expect(modifier).not.toHaveBeenLastCalledWith(null);
    expect(model.enabled).toBe(true);
    await glow.setEnabled(true); expect(fetch).toHaveBeenCalledTimes(4);
    controller.abort(); const pulse = component.getParameter('buildingGlowPulse');
    glow.update(.2); expect(component.getParameter('buildingGlowPulse')).toBe(pulse);
  } finally { glow.dispose(); app.destroy(); }
});

it('rejects corrupted evidence without changing the normal splats', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('.json')
    ? new Response(JSON.stringify(metadata)) : new Response(new Uint8Array(2))));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const model = new Entity('Original'); app.root.addChild(model);
  const glow = createLangSplatBuildingGlow(app, app.root, model, 'NYC_010', new AbortController().signal);
  try {
    await expect(glow.setEnabled(true)).rejects.toThrow('Incomplete');
    expect(model.enabled).toBe(true);
  } finally { glow.dispose(); app.destroy(); }
});

it('loads a refined scene atlas and switches cyan holograms to green vegetation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(new Uint8Array(readFileSync(`public/semantics/${url.split('/').at(-1)}`)))));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const model = new Entity('Original'); app.root.addChild(model);
  model.addComponent('gsplat', { unified: true });
  const glow = createLangSplatBuildingGlow(app, app.root, model, 'JAX_068', new AbortController().signal, undefined, 1.0025);
  try {
    await glow.setEnabled(true);
    const texture = model.gsplat!.getParameter('buildingGlowMask') as unknown as { width: number; height: number };
    expect(texture.width).toBe(4096); expect(texture.height).toBe(4096);
    expect(model.gsplat!.getParameter('buildingGlowGridSize')).toEqual([512, 512, 64]);
    expect(model.gsplat!.getParameter('buildingGlowTint')).toEqual([.04, .5, 1]);
    expect(model.gsplat!.getParameter('buildingGlowKind')).toBe(0);
    expect(model.gsplat!.getParameter('buildingGlowMetresPerUnit')).toBe(1.0025);
    glow.update(.15);
    expect(model.gsplat!.getParameter('buildingGlowTime')).toBeGreaterThan(0);
    await glow.setCategory('vegetation');
    expect(model.gsplat!.getParameter('buildingGlowKind')).toBe(1);
    expect(model.gsplat!.getParameter('buildingGlowTint')).toEqual([.18, 1, .38]);
  } finally { glow.dispose(); app.destroy(); }
});
