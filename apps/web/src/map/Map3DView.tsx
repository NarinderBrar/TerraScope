import { useEffect, useRef, useState } from 'react';
import { SKYFALL_SCENES, type GeoBounds, type SplatSceneMeta } from '../data/splatScenes';
import type { SplatGeoreference } from '../data/splatGeoreference';
import { geographicToModel } from '../data/splatGeoreference';
import { WORLD_IMAGERY_ATTRIBUTION } from './worldImagery';
import { createSurfaceNavigation } from './SurfaceNavigation';
import { hitCoverage3D, projectCoverage3D, type Coverage3D } from './coverage3D';
import { bindCoverageFrames } from './coverageFrame';
import { captureEarthView, captureMapView, EARTH_RADIUS, globeBlend, type GeographicView } from './navigation3D';

/** A coordinate frame for a satellite surface, independent of Gaussian assets. */
export function map3DReference(center: { lon: number; lat: number }): SplatGeoreference {
  const scale = 1 / Math.cos(center.lat * Math.PI / 180);
  return { origin: center, modelToMercator: [scale, 0, 0, scale], groundZ: 0 };
}

export function Map3DView({ bounds, center, orbit, orientation, showFootprints = false, onViewChange, onOpenFootprint, onReady }: {
  bounds: GeoBounds; center: { lon: number; lat: number }; orbit: { x: number; y: number };
  showFootprints?: boolean;
  orientation?: GeographicView['orientation'];
  onReady?: () => void;
  onViewChange?: (view: GeographicView) => void;
  onOpenFootprint?: (scene: SplatSceneMeta, view: GeographicView) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef<{ setOrbit(x: number, y: number): void; activate?(box: Coverage3D): void; city?(prefix: string): void } | null>(null);
  const coverageSvg = useRef<SVGSVGElement>(null);
  const coverageFrame = useRef<Coverage3D[]>([]);
  const [coverageStatus, setCoverageStatus] = useState({ checked: false, count: 0 });
  const latestOrbit = useRef(orbit); latestOrbit.current = orbit;
  const footprintsVisible = useRef(showFootprints); footprintsVisible.current = showFootprints;
  const callbacks = useRef({ onViewChange, onOpenFootprint, onReady }); callbacks.current = { onViewChange, onOpenFootprint, onReady };
  const [status, setStatus] = useState('Starting 3D satellite map…');
  const [error, setError] = useState('');
  const [earthMode, setEarthMode] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    coverageFrame.current = []; setCoverageStatus({ checked: false, count: 0 });
    if (coverageSvg.current) coverageSvg.current.style.display = 'none';
    const target = canvas.current;
    const abort = new AbortController();
    let dispose = (): void => {};
    void (async () => {
      const [pc, { PCApp }, { Camera }, { createGroundMap }, { mapViewFrame }, { createOrbitEarth }] = await Promise.all([
        import('playcanvas'), import('../splat/supersplat/pc-app'), import('../splat/supersplat/camera'),
        import('../splat/GroundMapLayer'), import('../splat/mapViewFrame'), import('./OrbitEarth'),
      ]);
      abort.signal.throwIfAborted();
      const device = await pc.createGraphicsDevice(target, { deviceTypes: ['webgpu', 'webgl2'],
        antialias: false, depth: true, powerPreference: 'low-power' });
      if (abort.signal.aborted) { device.destroy(); return; }
      let app: InstanceType<typeof PCApp> | undefined;
      try {
        app = new PCApp(target, { graphicsDevice: device });
        const viewer = app;
        const cleanup: (() => void)[] = [() => viewer.destroy()];
        let released = false;
        dispose = () => {
          if (released) return;
          released = true; controls.current = null;
          for (const release of cleanup.reverse()) release();
        };
        const camera = new Camera(viewer, target);
        cleanup.push(() => camera.destroy());
        const root = new pc.Entity('Geographic satellite surface', viewer);
        root.setLocalRotation(new pc.Quat().setFromDirections(new pc.Vec3(0, 0, 1), pc.Vec3.UP));
        viewer.root.addChild(root);
        const originalReference = map3DReference(center);
        let reference = originalReference;
        const frame = mapViewFrame(bounds, reference, orientation);
        const nw = geographicToModel(reference, bounds.west, bounds.north);
        const se = geographicToModel(reference, bounds.east, bounds.south);
        camera.frame(new pc.BoundingBox(new pc.Vec3(...frame.focalPoint),
          new pc.Vec3(Math.abs(se[0] - nw[0]) / 2, 1, Math.abs(se[1] - nw[1]) / 2)), frame);
        const baseAzimuth = camera.azim, baseElevation = camera.elevation;
        camera.maxDistance = 500000000 / camera.sceneRadius;
        camera.minDistance = .1 / camera.sceneRadius; camera.zoomFloor = 0;
        controls.current = { setOrbit: (x, y) => camera.setAzimElev(baseAzimuth - x * .2,
          y === 0 ? baseElevation : Math.min(-5, baseElevation + Math.abs(y) * .2)) };
        controls.current.setOrbit(latestOrbit.current.x, latestOrbit.current.y);
        let presented = false;
        const ground = createGroundMap(viewer, root, reference, camera, next => {
          if (!abort.signal.aborted) setStatus(next === 'ready' ? '3D satellite surface' : next === 'loading' ? 'Loading satellite imagery…' : 'Satellite imagery unavailable');
          if (next !== 'loading' && !presented) {
            presented = true;
            viewer.once('frameend', () => { if (!abort.signal.aborted) callbacks.current.onReady?.(); });
          }
        });
        cleanup.push(() => ground.dispose());
        const earth = createOrbitEarth(viewer, center, undefined, camera); cleanup.push(() => earth.dispose());
        const navigation = createSurfaceNavigation(camera, originalReference, center, root, earth, 1, (focus, next) => {
          reference = next; earth.setFocus(focus); ground.setReference?.(next);
        });
        cleanup.push(() => navigation.dispose());
        let blend = 0, planetOffset = 0, publishTime = 0, groundVisible = true, showingEarth = false;
        const readCoverage = () => {
          const rect = target.getBoundingClientRect();
          return projectCoverage3D(camera, root, reference, earth, center, blend, rect.width, rect.height);
        };
        let previousCount = -1, previousChecked = false;
        cleanup.push(bindCoverageFrames(viewer, () => coverageSvg.current, () => footprintsVisible.current,
          readCoverage, (boxes, checked) => {
            coverageFrame.current = boxes;
            if (boxes.length !== previousCount || checked !== previousChecked) {
              previousCount = boxes.length; previousChecked = checked;
              setCoverageStatus({ checked, count: boxes.length });
            }
          }));
        const focusBounds = (area: GeoBounds) => {
          navigation.goTo({ lon: (area.west + area.east) / 2, lat: (area.south + area.north) / 2 });
          camera.setFocalPoint(new pc.Vec3(0, reference.groundZ, 0)); planetOffset = 0;
          const fitted = mapViewFrame(area, reference);
          const left = geographicToModel(reference, area.west, area.south), right = geographicToModel(reference, area.east, area.north);
          const rect = target.getBoundingClientRect(), aspect = rect.width / Math.max(1, rect.height);
          const halfHeight = Math.max(fitted.halfHeight, Math.abs(right[0] - left[0]) / (2 * aspect));
          const distance = halfHeight * 1.2 / Math.tan(camera.camera.fov * Math.PI / 360);
          camera.setDistance(distance * camera.fovFactor / camera.sceneRadius);
        };
        const activate = (box: Coverage3D) => {
          if (box.marker || blend >= .5) { focusBounds(box.scene.bounds); return; }
          const view = captureMapView(camera, root, reference, target.clientHeight);
          if (view) callbacks.current.onOpenFootprint?.(box.scene, view);
        };
        controls.current.activate = activate;
        controls.current.city = prefix => {
          const scenes = SKYFALL_SCENES.filter(scene => scene.id.startsWith(prefix));
          if (scenes.length) focusBounds({ west: Math.min(...scenes.map(s => s.bounds.west)), east: Math.max(...scenes.map(s => s.bounds.east)),
            south: Math.min(...scenes.map(s => s.bounds.south)), north: Math.max(...scenes.map(s => s.bounds.north)) });
        };
        let press: { id: number; x: number; y: number; moved: boolean } | null = null;
        const pointerDown = (event: PointerEvent) => {
          press = event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
        };
        const pointerMove = (event: PointerEvent) => {
          if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true;
          const rect = target.getBoundingClientRect();
          const hover = footprintsVisible.current
            ? hitCoverage3D(coverageFrame.current, { x: event.clientX - rect.left, y: event.clientY - rect.top }) : undefined;
          target.style.cursor = hover ? 'pointer' : press?.moved ? 'grabbing' : 'grab';
          target.title = hover ? `${hover.scene.name} · ${hover.marker ? 'zoom to coverage' : 'open in 3D'}` : '';
        };
        const pointerUp = (event: PointerEvent) => {
          const click = press; press = null;
          if (!click || click.moved || click.id !== event.pointerId || !footprintsVisible.current) return;
          const rect = target.getBoundingClientRect();
          const selected = hitCoverage3D(coverageFrame.current, { x: event.clientX - rect.left, y: event.clientY - rect.top });
          if (selected) activate(selected);
        };
        const cancelPress = () => { press = null; };
        target.addEventListener('pointerdown', pointerDown); target.addEventListener('pointermove', pointerMove);
        // Handle activation before PointerController releases capture, which can
        // synchronously emit lostpointercapture and cancel the pending click.
        target.addEventListener('pointerup', pointerUp, true); target.addEventListener('pointercancel', cancelPress);
        target.addEventListener('lostpointercapture', cancelPress);
        cleanup.push(() => {
          target.removeEventListener('pointerdown', pointerDown); target.removeEventListener('pointermove', pointerMove);
          target.removeEventListener('pointerup', pointerUp, true); target.removeEventListener('pointercancel', cancelPress);
          target.removeEventListener('lostpointercapture', cancelPress);
        });
        const resize = (): void => {
          const rect = target.getBoundingClientRect();
          device.resizeCanvas(Math.max(1, rect.width), Math.max(1, rect.height));
        };
        const observer = new ResizeObserver(resize); cleanup.push(() => observer.disconnect()); observer.observe(target); resize();
        const blockMenu = (event: Event): void => event.preventDefault();
        target.addEventListener('contextmenu', blockMenu);
        cleanup.push(() => target.removeEventListener('contextmenu', blockMenu));
        viewer.on('update', (delta: number) => {
          camera.update(delta);
          const distance = camera.distance * camera.sceneRadius / camera.fovFactor;
          blend = globeBlend(distance);
          if ((blend > .5) !== showingEarth) { showingEarth = blend > .5; setEarthMode(showingEarth); }
          if (distance > 30000) earth.prepare();
          const nextOffset = -EARTH_RADIUS * globeBlend(distance / 16);
          if (Math.abs(nextOffset - planetOffset) > .01) {
            camera.setFocalPoint(camera.focalPoint.clone().add(new pc.Vec3(0, nextOffset - planetOffset, 0))); planetOffset = nextOffset;
          }
          earth.update(blend); ground.setOpacity?.(1 - blend);
          const visible = blend < 1;
          if (visible !== groundVisible) { groundVisible = visible; ground.setVisible(visible); }
          if (visible) ground.update();
          publishTime += delta;
          if (publishTime > .1) {
            publishTime = 0;
            const view = blend > .5 ? captureEarthView(camera, center, target.clientHeight, new pc.Mat4().copy(earth.getWorldTransform()).invert())
              : captureMapView(camera, root, reference, target.clientHeight);
            if (view) {
              const [a, b] = reference.modelToMercator;
              callbacks.current.onViewChange?.({ ...view, orientation: {
                azimuth: camera.azim - Math.atan2(b, a) * 180 / Math.PI, elevation: camera.elevation,
              } });
            }
          }
        });
        viewer.start();
      } catch (reason) { if (app) dispose(); else device.destroy(); throw reason; }
    })().catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { abort.abort(); dispose(); };
  }, [bounds, center, orientation]);
  useEffect(() => { controls.current?.setOrbit(orbit.x, orbit.y); }, [orbit]);
  return <div className="map-3d-view">
    <canvas ref={canvas} aria-label="Interactive 3D satellite map" />
    {showFootprints && <svg ref={coverageSvg} className="coverage-3d" role="group" aria-label="Registered 3D coverage">
      {SKYFALL_SCENES.map(scene => <g key={scene.id} data-scene-id={scene.id} className="coverage-3d-scene"
        role="button" tabIndex={-1} visibility="hidden" aria-label={`Open ${scene.name} in 3D`}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          const box = coverageFrame.current.find(box => box.scene.id === scene.id);
          if (box) controls.current?.activate?.(box);
        }}>
        <title>{scene.name}</title>
        <circle r={6} visibility="hidden" />
        <polygon visibility="hidden" />
      </g>)}
    </svg>}
    {showFootprints && coverageStatus.checked && !coverageStatus.count && <div className="coverage-3d-empty" role="status">
      <span>No registered 3D coverage in this view.</span>
      <button type="button" onClick={() => controls.current?.city?.('JAX')}>Show Jacksonville</button>
      <button type="button" onClick={() => controls.current?.city?.('NYC')}>Show New York City</button>
    </div>}
    <p className="map-3d-status" role={error ? 'alert' : 'status'}>{error || (earthMode ? 'Earth satellite globe' : status)}</p>
    <p className="map-3d-help">Drag to pan · right-drag to orbit · zoom out to Earth · click a footprint to open its splats</p>
    <span className="splat-map-attribution">{WORLD_IMAGERY_ATTRIBUTION}</span>
  </div>;
}
