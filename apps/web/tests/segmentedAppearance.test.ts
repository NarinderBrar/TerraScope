// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Entity, FILTER_NEAREST, NullGraphicsDevice, type Texture } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { createLangSplatBuildingGlow } from '../src/splat/LangSplatBuildingGlow';
import { parseSegmentationMetadata } from '../src/splat/segmentationMetadata';

const metadata = JSON.parse(readFileSync('public/semantics/JAX_214-segments.json', 'utf8'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(SKYFALL_SCENES)('validates actual packed categories and source identity for $id', scene => {
  const meta = parseSegmentationMetadata(JSON.parse(readFileSync(`public/semantics/${scene.id}-segments.json`, 'utf8')), scene.id);
  const bytes = readFileSync(`public/semantics/${meta.asset}`);
  expect(bytes.byteLength).toBe(meta.byteLength);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(meta.assetSha256);
  const counts = [0, 0, 0, 0, 0, 0];
  for (const id of bytes) { if (id > 5) throw new Error('Invalid class ID'); counts[id]++; }
  expect(meta.classes.map(c => c.voxels)).toEqual(counts.slice(1));
  expect(meta.classes[4].voxels).toBe(0);
  expect(() => parseSegmentationMetadata({ ...meta, sourceSha256: 'other' }, scene.id)).toThrow();
  expect(() => parseSegmentationMetadata({ ...meta, coordinateFrame: 'world' }, scene.id)).toThrow();
  expect(() => parseSegmentationMetadata({ ...meta, classes: [] }, scene.id)).toThrow();
});

function setup() {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(new Uint8Array(readFileSync(`public/semantics/${url.split('/').at(-1)}`)))));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const model = new Entity('Original registered model'); app.root.addChild(model);
  model.addComponent('gsplat', { unified: true });
  const abort = new AbortController();
  const glow = createLangSplatBuildingGlow(app, app.root, model, 'JAX_214', abort.signal);
  return { app, model, abort, glow, component: model.gsplat! };
}
it('colours every class on the same geometry and restores normal appearance without refetching', async () => {
  const { app, model, glow, component } = setup();
  const transform = model.getWorldTransform().clone();
  try {
    expect(fetch).not.toHaveBeenCalled();
    await glow.setSegmentedEnabled(true);
    expect(component.getParameter('segmentActive')).toBe(1);
    const texture = component.getParameter('segmentMask') as unknown as Texture;
    expect(texture.width).toBe(4096); expect(texture.minFilter).toBe(FILTER_NEAREST);
    glow.update(.2); expect(component.getParameter('segmentTime')).toBeGreaterThan(0);
    await glow.setSegmentedEnabled(false);
    expect(component.getParameter('segmentActive')).toBe(0);
    expect(component.getParameter('buildingGlowActive')).toBe(0);
    expect(model.enabled).toBe(true); expect(model.gsplat).toBe(component);
    expect(model.getWorldTransform().equals(transform)).toBe(true);
    await glow.setSegmentedEnabled(true); expect(fetch).toHaveBeenCalledTimes(2);
  } finally { glow.dispose(); app.destroy(); }
});
it('a late download cannot re-enable segments after switching off', async () => {
  const { app, glow, component } = setup();
  try {
    const loading = glow.setSegmentedEnabled(true);
    await glow.setSegmentedEnabled(false);
    await loading;
    expect(component.getParameter('segmentActive')).toBe(0);
  } finally { glow.dispose(); app.destroy(); }
});
it('rejects truncated data, keeps original colours and permits retry', async () => {
  const { app, glow, component } = setup();
  const fetcher = vi.mocked(fetch);
  fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(metadata)))
    .mockImplementationOnce(async () => new Response(new Uint8Array(2)));
  try {
    await expect(glow.setSegmentedEnabled(true)).rejects.toThrow('Incomplete');
    expect(component.getParameter('segmentActive')).toBe(0);
    await glow.setSegmentedEnabled(true);
    expect(component.getParameter('segmentActive')).toBe(1);
  } finally { glow.dispose(); app.destroy(); }
});
