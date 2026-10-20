import {
  Asset, BoundingBox, Entity, RESOLUTION_AUTO, Quat, Vec3, createGraphicsDevice,
  type GraphicsDevice, type GSplatResourceBase,
} from 'playcanvas';
import { fetchSplatBlob } from './file-handler';
import { loadGroundMap, type GroundMapLayer, type GroundMapStatus } from './GroundMapLayer';
import { mapViewFrame } from './mapViewFrame';
import { planGroundMap } from './groundMapPlan';
import { PCApp } from './supersplat/pc-app';
import { Camera } from './supersplat/camera';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';

export interface SplatSession { dispose(): void; reset(): void; setMapVisible(visible: boolean): void; reloadMap(): void }

export async function createSplatSession(
  canvas: HTMLCanvasElement,
  meta: SplatSceneMeta,
  signal: AbortSignal,
  onProgress: (message: string, fraction?: number) => void,
  onError: (message: string) => void,
  onMapStatus: (status: GroundMapStatus) => void,
  entryBounds: GeoBounds,
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
  let mapController: AbortController | undefined;
  let mapVisible = true;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    observer?.disconnect();
    mapController?.abort();
    groundMap?.dispose();
    camera?.destroy();
    // Destroy placements before releasing their asset and its GPU textures.
    app?.root.findByName('Skyfall model')?.destroy();
    if (app && asset) { app.assets.remove(asset); asset.unload(); }
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

    const blob = await fetchSplatBlob(meta.splatUrl, signal, onProgress);
    signal.throwIfAborted();
    onProgress('Decoding Gaussian splats…');
    const contents = await blob.arrayBuffer();
    signal.throwIfAborted();
    asset = new Asset(meta.id, 'gsplat', { url: meta.splatUrl, filename: `${meta.id}.sog`, contents });
    app.assets.add(asset);
    const modelAsset = asset;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        signal.removeEventListener('abort', abort);
        modelAsset.off('load', loaded);
        modelAsset.off('error', failed);
        error ? reject(error) : resolve();
      };
      const loaded = (): void => finish();
      const failed = (reason: unknown): void => finish(new Error(String(reason)));
      const abort = (): void => finish(signal.reason);
      modelAsset.once('load', loaded);
      modelAsset.once('error', failed);
      signal.addEventListener('abort', abort, { once: true });
      app!.assets.load(modelAsset);
    });
    signal.throwIfAborted();
    const resource = asset.resource as GSplatResourceBase;
    if (!resource?.aabb) throw new Error('The city model did not provide valid bounds.');
    const modelRoot = new Entity('Skyfall model');
    // SuperSplat controls use Y-up. Rotate the complete Z-up data frame once,
    // including the ground map, so the model and imagery stay in one frame.
    modelRoot.setLocalRotation(new Quat().setFromDirections(new Vec3(...meta.upVector), Vec3.UP));
    app.root.addChild(modelRoot);
    const model = new Entity(meta.id);
    model.addComponent('gsplat', { asset, unified: true });
    modelRoot.addChild(model);
    const bounds = new BoundingBox();
    bounds.setFromTransformedAabb(resource.aabb, modelRoot.getWorldTransform());
    camera.frame(bounds, mapViewFrame(entryBounds, meta.georeference));
    const mapPlan = planGroundMap(meta, device.maxTextureSize, entryBounds);
    const reloadMap = (): void => {
      if (disposed) return;
      mapController?.abort();
      groundMap?.dispose();
      groundMap = undefined;
      const controller = new AbortController();
      mapController = controller;
      onMapStatus('loading');
      void loadGroundMap(app!, modelRoot, mapPlan, controller.signal).then((layer) => {
        if (disposed || controller.signal.aborted) { layer.dispose(); return; }
        groundMap = layer;
        layer.setVisible(mapVisible);
        // Reveal after the ground texture has been submitted in a rendered frame.
        app!.once('frameend', () => {
          if (!disposed && !controller.signal.aborted) onMapStatus('ready');
        });
      }).catch(() => { if (!disposed && !controller.signal.aborted) onMapStatus('unavailable'); });
    };
    reloadMap();
    app.on('update', (delta: number) => camera?.update(delta));
    app.start();
    return {
      dispose,
      reset: () => { if (!disposed) camera?.reset(); },
      reloadMap,
      setMapVisible: (visible) => { mapVisible = visible; groundMap?.setVisible(visible); },
    };
  } catch (error) { dispose(); throw error; }
}
