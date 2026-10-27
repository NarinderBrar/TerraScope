import { useEffect, useRef, useState } from 'react';
import { SKYFALL_SCENES, type GeoBounds, type SplatSceneMeta } from '../data/splatScenes';
import type { SplatGeoreference } from '../data/splatGeoreference';
import { geographicToModel } from '../data/splatGeoreference';
import { WORLD_IMAGERY_ATTRIBUTION } from './worldImagery';
import { captureEarthView, captureMapView, EARTH_RADIUS, globeBlend, pickGroundFootprint, type GeographicView } from './navigation3D';

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
  const controls = useRef<{ setOrbit(x: number, y: number): void } | null>(null);
  const latestOrbit = useRef(orbit); latestOrbit.current = orbit;
  const footprintsVisible = useRef(showFootprints); footprintsVisible.current = showFootprints;
  const callbacks = useRef({ onViewChange, onOpenFootprint, onReady }); callbacks.current = { onViewChange, onOpenFootprint, onReady };
  const [status, setStatus] = useState('Starting 3D satellite map…');
  const [error, setError] = useState('');
  const [earthMode, setEarthMode] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
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
        const reference = map3DReference(center), frame = mapViewFrame(bounds, reference, orientation);
        const footprintLines: InstanceType<typeof pc.Vec3>[] = [];
        for (const scene of SKYFALL_SCENES) {
          const b = scene.bounds;
          const corners = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]]
            .map(([lon, lat]) => {
              const [x, y] = geographicToModel(reference, lon, lat);
              return root.getWorldTransform().transformPoint(new pc.Vec3(x, y, .2));
            });
          for (let i = 0; i < 4; i++) footprintLines.push(corners[i], corners[(i + 1) % 4]);
        }
        const footprintColor = new pc.Color(.3, 1, .55);
        const footprintColors = footprintLines.map(() => footprintColor);
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
        const earth = createOrbitEarth(viewer, center); cleanup.push(() => earth.dispose());
        let blend = 0, planetOffset = 0, publishTime = 0, groundVisible = true, showingEarth = false;
        let press: { id: number; x: number; y: number; moved: boolean } | null = null;
        const pointerDown = (event: PointerEvent) => {
          press = event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
        };
        const pointerMove = (event: PointerEvent) => {
          if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true;
        };
        const pointerUp = (event: PointerEvent) => {
          const click = press; press = null;
          if (!click || click.moved || click.id !== event.pointerId || !footprintsVisible.current || blend > .5) return;
          const rect = target.getBoundingClientRect();
          const selected = pickGroundFootprint(event.clientX - rect.left, event.clientY - rect.top, camera, root, reference);
          const view = captureMapView(camera, root, reference, rect.height);
          if (selected && view) callbacks.current.onOpenFootprint?.(selected, view);
        };
        const cancelPress = () => { press = null; };
        target.addEventListener('pointerdown', pointerDown); target.addEventListener('pointermove', pointerMove);
        target.addEventListener('pointerup', pointerUp); target.addEventListener('pointercancel', cancelPress);
        target.addEventListener('lostpointercapture', cancelPress);
        cleanup.push(() => {
          target.removeEventListener('pointerdown', pointerDown); target.removeEventListener('pointermove', pointerMove);
          target.removeEventListener('pointerup', pointerUp); target.removeEventListener('pointercancel', cancelPress);
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
          if (footprintsVisible.current && blend < .5) viewer.drawLines(footprintLines, footprintColors, false);
          publishTime += delta;
          if (publishTime > .1) {
            publishTime = 0;
            const view = blend > .5 ? captureEarthView(camera, center, target.clientHeight)
              : captureMapView(camera, root, reference, target.clientHeight);
            if (view) callbacks.current.onViewChange?.(view);
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
    <p className="map-3d-status" role={error ? 'alert' : 'status'}>{error || (earthMode ? 'Earth satellite globe' : status)}</p>
    <p className="map-3d-help">Drag to orbit · right-drag to pan · zoom out to Earth · click a footprint to open its splats</p>
    <span className="splat-map-attribution">{WORLD_IMAGERY_ATTRIBUTION}</span>
  </div>;
}
