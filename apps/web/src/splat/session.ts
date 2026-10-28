import {
  Asset, BoundingBox, Entity, RESOLUTION_AUTO, Mat4, Quat, Vec3, createGraphicsDevice,
  type GraphicsDevice,
} from 'playcanvas';
import { SplatChunkLoader } from './SplatChunkLoader';
import type { SplatStreamStatus } from './sogChunk';
import { fetchStreamingIndex, loadStreamingIndex, type StreamedSplatResource } from './streamingIndex';
import { createGroundMap, type GroundMapLayer, type GroundMapStatus } from './GroundMapLayer';
import { mapViewFrame } from './mapViewFrame';
import { PCApp } from './supersplat/pc-app';
import { Camera } from './supersplat/camera';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';
import type { UrbanOverlayState } from '../urban/types';
import { createLangSplatBuildingGlow, type GlowCategory } from './LangSplatBuildingGlow';
import { captureEarthView, captureMapView, EARTH_RADIUS, globeBlend, type GeographicView } from '../map/navigation3D';
import { createOrbitEarth } from '../map/OrbitEarth';
import { createSurfaceNavigation, referenceAtFocus } from '../map/SurfaceNavigation';
import { geographicToModel, modelToGeographic } from '../data/splatGeoreference';
import { metricFrame } from '../urban/model';

export interface SplatSession { dispose(): void; reset(): void; setSegmentedEnabled?(enabled: boolean): Promise<void>; setMapVisible(visible: boolean): void; reloadMap(): void; retryDetail(): void; setUrbanState?(state: UrbanOverlayState | null): void; setBuildingsEnabled?(enabled: boolean): Promise<void>; setGlowCategory?(category: GlowCategory): Promise<void>; getMapView?(): GeographicView | null }

export async function createSplatSession(
  canvas: HTMLCanvasElement,
  meta: SplatSceneMeta,
  signal: AbortSignal,
  onProgress: (message: string, fraction?: number) => void,
  onError: (message: string) => void,
  onMapStatus: (status: GroundMapStatus) => void,
  entryBounds: GeoBounds,
  onStreamStatus: (status: SplatStreamStatus) => void = () => {},
  entryOrientation?: GeographicView['orientation'],
): Promise<SplatSession> {
  signal.throwIfAborted();
  onProgress('Starting graphics and loading the 3D tile index…');
  const indexController = new AbortController();
  const index = fetchStreamingIndex(meta.lodUrl, AbortSignal.any([signal, indexController.signal]));
  // An index failure can precede GPU initialization; retain it for the await below.
  void index.catch(() => {});
  // SuperSplat's PCApp setup, using the engine's native SOG asset loader. Select
  // the display GPU consistently with TerraScope's map on hybrid-GPU laptops.
  const device: GraphicsDevice = await createGraphicsDevice(canvas, {
    deviceTypes: ['webgpu', 'webgl2'], antialias: false, depth: true, stencil: false,
    xrCompatible: false, powerPreference: 'low-power',
  }).catch((error: unknown) => { indexController.abort(); throw error; });
  let app: PCApp | undefined;
  let camera: Camera | undefined;
  let asset: Asset | undefined;
  let observer: ResizeObserver | undefined;
  let groundMap: GroundMapLayer | undefined;
  let chunks: SplatChunkLoader | undefined;
  let buildingGlow: ReturnType<typeof createLangSplatBuildingGlow> | undefined;
  let earth: ReturnType<typeof createOrbitEarth> | undefined;
  let navigation: ReturnType<typeof createSurfaceNavigation> | undefined;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    indexController.abort();
    navigation?.dispose();
    buildingGlow?.dispose();
    earth?.dispose();
    signal.removeEventListener('abort', dispose);
    observer?.disconnect();
    groundMap?.dispose();
    camera?.destroy();
    // Let app.destroy release the renderer's world references before unloading
    // registered assets (which destroys the chunk loader and its GPU resources).
    app?.root.findByName('Skyfall model')?.destroy();
    if (app) app.destroy(); else device.destroy();
  };
  const fail = (): void => {
    if (!disposed) { dispose(); onError('The 3D graphics context was lost. Retry to reload the scene.'); }
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    signal.throwIfAborted();
    app = new PCApp(canvas, { graphicsDevice: device });
    device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    app.setCanvasResolution(RESOLUTION_AUTO);
    device.on('devicelost', fail);
    camera = new Camera(app, canvas);
    const blockMenu = (event: Event): void => event.preventDefault();
    canvas.addEventListener('contextmenu', blockMenu);
    app.on('destroy', () => canvas.removeEventListener('contextmenu', blockMenu));
    const resize = (): void => {
      if (disposed) return;
      const rect = canvas.getBoundingClientRect();
      device.resizeCanvas(Math.max(1, rect.width), Math.max(1, rect.height));
    };
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    onProgress('Loading the 3D tile index…');
    asset = await loadStreamingIndex(app, meta.id, meta.lodUrl, signal, index);
    signal.throwIfAborted();
    const resource = asset.resource as unknown as StreamedSplatResource;
    if (!resource?.octree || !resource.aabb) throw new Error('The city model did not provide a streaming tile index.');
    const levels = new Map(resource.octree.files.map((file) => [file.url, file.lodLevel]));
    chunks = new SplatChunkLoader(device, levels, (state) => {
      if (disposed) return;
      if (!state.loaded) onProgress('Loading LOD 3 · coarse city tiles…');
      onStreamStatus(state);
    });
    resource.octree.assetLoader?.destroy();
    resource.octree.assetLoader = chunks;
    app.scene.gsplat.lodUnderfillLimit = 2;
    app.scene.gsplat.splatBudget = 2_000_000;
    app.scene.gsplat.cooldownTicks = 60;
    const modelRoot = new Entity('Skyfall model', app);
    // SuperSplat controls use Y-up. Rotate the complete Z-up data frame once,
    // including the ground map, so the model and imagery stay in one frame.
    modelRoot.setLocalRotation(new Quat().setFromDirections(new Vec3(...meta.upVector), Vec3.UP));
    app.root.addChild(modelRoot);
    const model = new Entity(meta.id, app);
    model.addComponent('gsplat', { asset, unified: true, lodRangeMin: 0, lodRangeMax: 2, lodBaseDistance: 300, lodMultiplier: 2 });
    modelRoot.addChild(model);
    const bounds = new BoundingBox();
    bounds.setFromTransformedAabb(resource.aabb, modelRoot.getWorldTransform());
    const frame = mapViewFrame(entryBounds, meta.georeference, entryOrientation);
    const initialFocus = modelToGeographic(meta.georeference, frame.focalPoint[0], -frame.focalPoint[2]);
    const viewScale = Math.cos(initialFocus.lat * Math.PI / 180) / Math.cos(meta.georeference.origin.lat * Math.PI / 180);
    camera.frame(bounds, { ...frame, halfHeight: frame.halfHeight * viewScale, focalPoint: [0, meta.georeference.groundZ, 0] });
    const metresPerUnit = metricFrame(meta).metresPerUnit;
    camera.maxDistance = 500000000 / metresPerUnit / camera.sceneRadius;
    camera.minDistance = .1 / metresPerUnit / camera.sceneRadius; camera.zoomFloor = 0;
    const groundRoot = new Entity('Registered satellite frame', app);
    groundRoot.setLocalRotation(modelRoot.getLocalRotation()); app.root.addChild(groundRoot);
    groundMap = createGroundMap(app, groundRoot, meta.georeference, camera, onMapStatus);
    earth = createOrbitEarth(app, meta.georeference.origin, meta.georeference, camera);
    navigation = createSurfaceNavigation(camera, meta.georeference, initialFocus, groundRoot, earth, metresPerUnit, (focus, next) => {
      earth?.setFocus(focus); groundMap?.setReference?.(next);
      const offset = geographicToModel(next, meta.georeference.origin.lon, meta.georeference.origin.lat);
      modelRoot.setLocalPosition(modelRoot.getLocalRotation().transformVector(new Vec3(offset[0], offset[1], 0)));
      const scale = Math.cos(focus.lat * Math.PI / 180) / Math.cos(meta.georeference.origin.lat * Math.PI / 180);
      modelRoot.setLocalScale(scale, scale, 1);
    });
    let planetBlend = 0, planetOffset = 0, mapVisible = true, groundVisible = true, tilesReady = false;
    let segmentChange = 0;
    buildingGlow = createLangSplatBuildingGlow(app, modelRoot, model, meta.id, indexController.signal,
      [resource.aabb.center.z - resource.aabb.halfExtents.z, resource.aabb.center.z + resource.aabb.halfExtents.z], metresPerUnit);
    const reloadMap = (): void => {
      if (disposed) return;
      groundMap?.retry();
    };
    app.on('update', (delta: number) => {
      if (!camera) return;
      camera.update(delta);
      const distance = camera.distance * camera.sceneRadius / camera.fovFactor * metresPerUnit;
      planetBlend = globeBlend(distance);
      if (distance > 30000) earth?.prepare();
      const offset = -EARTH_RADIUS / metresPerUnit * globeBlend(distance / 16);
      if (Math.abs(offset - planetOffset) > .01) {
        camera.setFocalPoint(camera.focalPoint.clone().add(new Vec3(0, offset - planetOffset, 0))); planetOffset = offset;
      }
      earth?.update(mapVisible ? planetBlend : 0); groundMap?.setOpacity?.(1 - planetBlend);
      model.enabled = !tilesReady || planetBlend < 1;
      const visible = mapVisible && planetBlend < 1;
      if (visible !== groundVisible) { groundVisible = visible; groundMap?.setVisible(visible); }
      if (visible) groundMap?.update();
      buildingGlow?.update(delta);
    });
    app.start();
    let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([chunks.firstReady, new Promise<never>((_, reject) => {
        firstFrameTimeout = setTimeout(() => reject(new Error('Coarse city tiles could not be loaded. Retry the scene.')), 60000);
      })]);
    } finally { clearTimeout(firstFrameTimeout); }
    signal.throwIfAborted();
    tilesReady = true;
    // The map and coarse chunks render before refinement continues in the background.
    buildingGlow.startReveal();
    await new Promise<void>((resolve, reject) => {
      const clean = () => { app!.off('frameend', done); signal.removeEventListener('abort', abort); };
      const done = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      app!.once('frameend', done);
      signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted();
    return {
      dispose,
      reset: () => { if (!disposed) { planetOffset = 0; camera?.reset(); } },
      getMapView: () => {
        if (disposed || !camera) return null;
        const view = planetBlend > .5 && earth
          ? captureEarthView(camera, meta.georeference.origin, canvas.clientHeight, new Mat4().copy(earth.getWorldTransform()).invert())
          : captureMapView(camera, groundRoot, navigation ? referenceAtFocus(meta.georeference, navigation.focus) : meta.georeference, canvas.clientHeight);
        const [a, b] = meta.georeference.modelToMercator;
        return view ? { ...view, orientation: { azimuth: camera.azim - Math.atan2(b, a) * 180 / Math.PI, elevation: camera.elevation } } : null;
      },
      reloadMap,
      retryDetail: () => chunks?.retry(),
      setSegmentedEnabled: async (enabled) => {
        const change = ++segmentChange;
        await buildingGlow?.setSegmentedEnabled(enabled);
        if (disposed || change !== segmentChange) return;
        const style = enabled ? 'dark-vector' : 'satellite';
        groundMap?.setStyle?.(style); earth?.setStyle(style);
      },
      setBuildingsEnabled: (enabled) => buildingGlow?.setEnabled(enabled) ?? Promise.resolve(),
      setGlowCategory: (category) => buildingGlow?.setCategory(category) ?? Promise.resolve(),
      setMapVisible: (visible) => { mapVisible = visible; groundVisible = visible && planetBlend < 1; groundMap?.setVisible(groundVisible); },
    };
  } catch (error) { dispose(); throw error; }
}
