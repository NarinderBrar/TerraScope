// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Entity, NullGraphicsDevice, type StandardMaterial } from 'playcanvas';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { createOrbitEarth } from '../src/map/OrbitEarth';
import { EARTH_RADIUS } from '../src/map/navigation3D';

afterEach(() => vi.unstubAllGlobals());
it('creates the Earth in the same tangent frame and fades it without making another camera', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));
  const canvas = document.createElement('canvas');
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  const camera = new Entity('Existing camera'); camera.addComponent('camera'); app.root.addChild(camera);
  const earth = createOrbitEarth(app, { lon: -74, lat: 40.7 });
  try {
    expect(fetch).not.toHaveBeenCalled();
    const globe = app.root.findByName('Earth satellite surface') as Entity;
    expect(globe.enabled).toBe(false);
    const base = app.root.findByName('Earth background') as Entity;
    expect(base.getPosition().y).toBeCloseTo(-EARTH_RADIUS, 0);
    earth.update(.5);
    expect(globe.enabled).toBe(true);
    expect((base.render!.material as StandardMaterial).opacity).toBe(.5);
    expect(app.root.findComponents('camera')).toHaveLength(1);
    earth.update(0); expect(globe.enabled).toBe(false);
  } finally { earth.dispose(); app.destroy(); }
});
