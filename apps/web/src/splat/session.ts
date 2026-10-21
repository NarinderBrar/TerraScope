import {
  Asset, BoundingBox, Entity, RESOLUTION_AUTO, Quat, Vec3, createGraphicsDevice,
  type GraphicsDevice,
} from 'playcanvas';
import { SplatChunkLoader } from './SplatChunkLoader';
import type { SplatStreamStatus } from './sogChunk';
import { loadStreamingIndex, type StreamedSplatResource } from './streamingIndex';
import { createGroundMap, type GroundMapLayer, type GroundMapStatus } from './GroundMapLayer';
import { mapViewFrame } from './mapViewFrame';
import { PCApp } from './supersplat/pc-app';
import { Camera } from './supersplat/camera';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';

export interface SplatSession { dispose(): void; reset(): void; setMapVisible(visible: boolean): void; reloadMap(): void; retryDetail(): void }

export async function createSplatSession(
  canvas: HTMLCanvasElement,
  meta: SplatSceneMeta,
  signal: AbortSignal,
  onProgress: (message: string, fraction?: number) => void,
  onError: (message: string) => void,
  onMapStatus: (status: GroundMapStatus) => void,
  entryBounds: GeoBounds,
  onStreamStatus: (status: SplatStreamStatus) => void = () => {},
): Promise<SplatSession> {
  signal.throwIfAborted();
  // SuperSplat's PCApp setup, using the engine's native SOG asset loader. Select
  // the display GPU consistently with TerraScope's map on hybrid-GPU laptops.
  const device: GraphicsDevice = await createGraphicsDevice(canvas, {
    deviceTypes: ['webgpu', 'webgl2'], antialias: false, depth: true, stencil: false,
    xrCompatible: false, powerPreference: 'low-power',
  });
  let app: PCApp | undefined;
  let camera: Camera | undefined;
  let asset: Asset | undefined;
  let observer: ResizeObserver | undefined;
  let groundMap: GroundMapLayer | undefined;
  let chunks: SplatChunkLoader | undefined;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
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
    asset = await loadStreamingIndex(app, meta.id, meta.lodUrl, signal);
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
    const modelRoot = new Entity('Skyfall model');
    // SuperSplat controls use Y-up. Rotate the complete Z-up data frame once,
    // including the ground map, so the model and imagery stay in one frame.
    modelRoot.setLocalRotation(new Quat().setFromDirections(new Vec3(...meta.upVector), Vec3.UP));
    app.root.addChild(modelRoot);
    const model = new Entity(meta.id);
    model.addComponent('gsplat', { asset, unified: true, lodRangeMin: 0, lodRangeMax: 2, lodBaseDistance: 300, lodMultiplier: 2 });
    modelRoot.addChild(model);
    const bounds = new BoundingBox();
    bounds.setFromTransformedAabb(resource.aabb, modelRoot.getWorldTransform());
    camera.frame(bounds, mapViewFrame(entryBounds, meta.georeference));
    groundMap = createGroundMap(app, modelRoot, meta.georeference, camera, onMapStatus);
    const reloadMap = (): void => {
      if (disposed) return;
      groundMap?.retry();
    };
    app.on('update', (delta: number) => { camera?.update(delta); groundMap?.update(); });
    app.start();
    let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([chunks.firstReady, new Promise<never>((_, reject) => {
        firstFrameTimeout = setTimeout(() => reject(new Error('Coarse city tiles could not be loaded. Retry the scene.')), 60000);
      })]);
    } finally { clearTimeout(firstFrameTimeout); }
    signal.throwIfAborted();
    // The map and coarse chunks render before refinement continues in the background.
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
      reset: () => { if (!disposed) camera?.reset(); },
      reloadMap,
      retryDetail: () => chunks?.retry(),
      setMapVisible: (visible) => { groundMap?.setVisible(visible); },
    };
  } catch (error) { dispose(); throw error; }
}
