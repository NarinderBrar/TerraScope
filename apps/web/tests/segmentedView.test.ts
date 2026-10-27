// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Entity, NullGraphicsDevice } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { createSegmentedView, validateSegmentedMetadata } from '../src/splat/SegmentedView';

const metadata = JSON.parse(readFileSync('public/semantics/NYC_010-segmented.json', 'utf8'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rejects another scene, source model or coordinate frame', () => {
  expect(() => validateSegmentedMetadata(metadata, 'NYC_010')).not.toThrow();
  for (const value of [{ ...metadata, sourceSha256: 'other' }, { ...metadata, coordinateFrame: 'world' },
    { ...metadata, asset: 'other.ply' }, { ...metadata, geometryUnchanged: false }]) {
    expect(() => validateSegmentedMetadata(value, 'NYC_010')).toThrow();
  }
  expect(() => validateSegmentedMetadata(metadata, 'NYC_004')).toThrow();
});

it('loads the real exported PLY through the native parser and toggles registered appearances', async () => {
  const bytes = readFileSync('public/semantics/NYC_010-segmented.ply');
  const fetcher = vi.fn(async (url: string) => url.endsWith('.json')
    ? new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } })
    : new Response(new Uint8Array(bytes)));
  vi.stubGlobal('fetch', fetcher);
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const root = new Entity('Registered root'), normal = new Entity('Normal');
  root.setLocalEulerAngles(-90, 0, 0);
  app.root.addChild(root); root.addChild(normal);
  const controller = new AbortController();
  const view = createSegmentedView(app, root, normal, 'NYC_010', controller.signal);
  try {
    expect(fetcher).not.toHaveBeenCalled();
    const loading = view.setEnabled(true);
    expect(normal.enabled).toBe(true);
    await loading;
    const colored = root.findByName('NYC_010 segmented appearance') as Entity;
    expect(colored.gsplat?.resource?.numSplats).toBe(metadata.gaussians);
    expect(colored.parent).toBe(root);
    expect(colored.getLocalPosition().length()).toBe(0);
    expect(normal.enabled).toBe(false); expect(colored.enabled).toBe(true);
    await view.setEnabled(false);
    expect(normal.enabled).toBe(true); expect(colored.enabled).toBe(false);
    await view.setEnabled(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(normal.enabled).toBe(false); expect(colored.enabled).toBe(true);
  } finally { controller.abort(); view.dispose(); app.destroy(); }
}, 15000);

it('keeps normal splats after a failed load and permits retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false }));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const normal = new Entity('Normal');
  app.root.addChild(normal);
  const view = createSegmentedView(app, app.root, normal, 'NYC_010', new AbortController().signal);
  try {
    await expect(view.setEnabled(true)).rejects.toThrow('could not be loaded');
    expect(normal.enabled).toBe(true);
    await expect(view.setEnabled(true)).rejects.toThrow('could not be loaded');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { view.dispose(); app.destroy(); }
});
