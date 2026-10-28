// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { BoundingBox, Entity, EventHandler, NullGraphicsDevice, Quat, Vec3 } from 'playcanvas';
import { bindCoverageFrames } from '../src/map/coverageFrame';
import { PCApp } from '../src/splat/supersplat/pc-app';
import { Camera } from '../src/splat/supersplat/camera';
import { createOrbitEarth } from '../src/map/OrbitEarth';
import { map3DReference } from '../src/map/Map3DView';
import { hitCoverage3D, projectCoverage3D } from '../src/map/coverage3D';
import { referenceAtFocus } from '../src/map/SurfaceNavigation';
import { EARTH_RADIUS } from '../src/map/navigation3D';
import { SKYFALL_SCENES } from '../src/data/splatScenes';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(scene = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!) {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1024, 768);
  const app = new PCApp(canvas, { graphicsDevice: new NullGraphicsDevice(canvas) });
  app.graphicsDevice.resizeCanvas(1024, 768);
  const camera = new Camera(app, canvas); camera.camera.aspectRatio = 1024 / 768;
  camera.frame(new BoundingBox(Vec3.ZERO, new Vec3(100, 100, 100)), {
    focalPoint: [0, 0, 0], halfHeight: 100, azimuth: 0, elevation: -90,
  });
  camera.maxDistance = 500000000 / camera.sceneRadius;
  const ground = new Entity('Ground frame', app);
  ground.setLocalRotation(new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP)); app.root.addChild(ground);
  const earth = createOrbitEarth(app, scene.center), reference = map3DReference(scene.center);
  const zoom = (range: number, globe = false) => {
    camera.setFocalPoint(new Vec3(0, globe ? -EARTH_RADIUS : 0, 0));
    camera.setDistance(range * camera.fovFactor / camera.sceneRadius);
  };
  const project = (blend = 0, ref = reference) => projectCoverage3D(camera, ground, ref, earth, scene.center, blend, 1024, 768);
  cleanup.push(() => { earth.dispose(); camera.destroy(); app.destroy(); });
  zoom(1000);
  return { app, scene, camera, earth, reference, zoom, project };
}

it.each(SKYFALL_SCENES)('shows and picks the registered bbox for $id in the close map', scene => {
  const state = setup(scene);
  const boxes = state.project(), box = boxes.find(b => b.scene.id === scene.id)!;
  expect(box).toBeDefined(); expect(box.marker).toBe(false);
  expect(box.points.length).toBe(4);
  expect(hitCoverage3D(boxes, box.center)?.scene.id).toBe(scene.id);
});

it('shows selectable location markers on the globe when exact bounds are subpixel', () => {
  const state = setup(); state.zoom(50000000, true);
  const boxes = state.project(1), box = boxes.find(b => b.scene.id === state.scene.id)!;
  expect(box).toBeDefined(); expect(box.marker).toBe(true);
  expect(hitCoverage3D(boxes, box.center)?.scene.id).toBe(state.scene.id);
});

it('follows the floating geographic frame and hides coverage behind the globe', () => {
  const state = setup(), focus = { lon: 106, lat: -40.7 };
  state.earth.setFocus(focus); state.zoom(50000000, true);
  expect(state.project(1, referenceAtFocus(state.reference, focus))).toHaveLength(0);
  state.earth.setFocus(state.scene.center);
  expect(state.project(1)).toContainEqual(expect.objectContaining({ scene: state.scene }));
});

it('does not invent boxes in regions with no registered scenes', () => {
  const state = setup(), focus = { lon: -121, lat: 38 };
  state.earth.setFocus(focus);
  expect(state.project(0, referenceAtFocus(state.reference, focus))).toHaveLength(0);
});

it('clips partially visible bounds at an inclined camera instead of dropping the box', () => {
  const state = setup(); state.zoom(100); state.camera.setAzimElev(0, -5);
  const box = state.project().find(b => b.scene.id === state.scene.id);
  expect(box).toBeDefined();
  expect(box!.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
});

function overlay() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = SKYFALL_SCENES.map(scene => `<g data-scene-id="${scene.id}" visibility="hidden"><title></title><circle/><polygon/></g>`).join('');
  return svg;
}

it('paints camera and globe motion into SVG synchronously on every rendered frame', () => {
  const state = setup(), svg = overlay(), renderer = state.app;
  let blend = 0, reference = state.reference;
  const unbind = bindCoverageFrames(renderer, () => svg, () => true, () => state.project(blend, reference), () => {});
  try {
    const group = svg.querySelector(`[data-scene-id="${state.scene.id}"]`)!;
    const positions = new Set<string>();
    for (let frame = 0; frame < 60; frame++) {
      state.camera.setAzimElev(frame * 2, -60 + 10 * Math.sin(frame));
      // The engine refreshes cached camera matrices in this phase. Projection
      // during update used to read the preceding frame's camera transform.
      renderer.fire('prerender');
      const expected = state.project().find(box => box.scene.id === state.scene.id)!;
      renderer.fire('postrender');
      expect(group.querySelector('polygon')!.getAttribute('points')).toBe(expected.points.map(p => `${p.x},${p.y}`).join(' '));
      positions.add(group.querySelector('polygon')!.getAttribute('points')!);
    }
    expect(positions.size).toBeGreaterThan(30);
    blend = 1; state.camera.setAzimElev(0, -90); state.zoom(50000000, true);
    for (let frame = 0; frame < 60; frame++) {
      const focus = { lon: state.scene.center.lon + frame * .1, lat: state.scene.center.lat };
      state.earth.setFocus(focus); reference = referenceAtFocus(state.reference, focus);
      renderer.fire('prerender');
      const expected = state.project(blend, reference).find(box => box.scene.id === state.scene.id)!;
      expect(expected.marker).toBe(true);
      renderer.fire('postrender');
      expect(group.querySelector('circle')!.getAttribute('cx')).toBe(String(expected.center.x));
      expect(group.querySelector('circle')!.getAttribute('cy')).toBe(String(expected.center.y));
    }
    const focus = { lon: 106, lat: -40.7 };
    state.earth.setFocus(focus); reference = referenceAtFocus(state.reference, focus);
    renderer.fire('postrender');
    expect((group as SVGGElement).style.display).toBe('none');
  } finally { unbind(); }
});

it('paints the first frame after mounting or re-enabling the overlay and detaches on disposal', () => {
  const state = setup(), renderer = new EventHandler();
  let svg: SVGSVGElement | null = null, enabled = true, projects = 0;
  const unbind = bindCoverageFrames(renderer, () => svg, () => enabled, () => { projects++; return state.project(); }, () => {});
  try {
    renderer.fire('postrender'); expect(projects).toBe(0);
    svg = overlay(); renderer.fire('postrender');
    expect(svg.querySelector('polygon[points]')).not.toBeNull();
    enabled = false; renderer.fire('postrender'); expect(svg.style.display).toBe('none');
    svg = overlay(); enabled = true; renderer.fire('postrender');
    expect(svg.style.display).toBe(''); expect(svg.querySelector('polygon[points]')).not.toBeNull();
    const before = projects; unbind(); renderer.fire('postrender'); expect(projects).toBe(before);
  } finally { unbind(); }
});
