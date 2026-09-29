/**
 * The map: camera, tile residency, GPU resources, and the render loop.
 *
 * Deliberately free of React. It owns mutable GPU state and a
 * requestAnimationFrame loop, and pushing that through a component's render
 * cycle is how you end up uploading a tile twice per frame. React reads it
 * through `subscribe` and the immutable snapshots below.
 */

import {
  createCamera,
  panBy,
  screenToLonLat,
  tileZoom,
  visibleTiles,
  zoomAround,
  type CameraState,
  type Viewport,
} from '../map/MapCamera';
import { GpuContext, WebGpuUnavailable } from '../gpu/GpuContext';
import { NdviGpu, type UploadedTile } from '../gpu/AnalysisKernels';
import { RasterRenderer, type DrawTile, type RenderSettings, type RenderTile } from '../gpu/RasterRenderer';
import { RasterClient, RasterError, type TileDescriptor } from '../data/RasterClient';
import type { NumericTile, Scene } from '@terrascope/contracts';
import { lonLatToWorldPx, TILE_SIZE } from '@terrascope/contracts';
import { computeNdvi } from '../analysis/AnalysisPipelines';

/** The profile every view requests. Only this one has all four bands. */
const PROFILE = 'rgbn';

export interface MapStats {
  resident: number;
  pending: number;
  failed: number;
  /** Bytes held by decoded tiles, from the server's own header where present. */
  bytes: number;
  zoom: number;
  centre: { lon: number; lat: number };
  lastFrameMs: number;
  requests: number;
  downloadedBytes: number;
  decodeMs: number;
  cacheHits: number;
}

export interface MapStatus {
  phase: 'starting' | 'ready' | 'error';
  message: string;
}

export interface PixelInspection {
  lon: number;
  lat: number;
  status: 'valid' | 'masked' | 'loading' | 'outside';
  date: string | null;
  red: number | null;
  green: number | null;
  blue: number | null;
  nir: number | null;
  ndvi: number | null;
  qualityValid: boolean | null;
}

/** Largest device pixel ratio worth paying for. */
const MAX_DPR = 2;

export class MapScene {
  readonly client: RasterClient;

  #canvas: HTMLCanvasElement;
  #context: GpuContext | null = null;
  #renderer: RasterRenderer | null = null;
  #ndvi: NdviGpu | null = null;

  #camera: CameraState = createCamera();
  #viewport: Viewport = { width: 0, height: 0, dpr: 1 };
  #settings: RenderSettings = {
    layer: 'natural',
    band: 'nir',
    swipe: 0.5,
    swipeEnabled: false,
    gamma: 1,
    exposure: 1,
    qualityMask: true,
    ndviMin: -1,
    ndviMax: 1,
    deltaRange: 1,
  };

  #scene: Scene | null = null;
  #sceneB: Scene | null = null;

  /**
   * Resident GPU resources, keyed by date and tile.
   *
   * The decoded CPU tile is *not* retained. Once a tile is in a texture and its
   * index is in a storage buffer, keeping the ~1 MB of decoded float32 bands
   * around doubles the cost of a tile for no benefit -- every frame reads the
   * texture, never the array.
   */
  #gpu = new Map<string, RenderTile>();

  #pending = new Map<string, AbortController>();
  #failed = new Set<string>();
  #frame = 0;
  #lastFrameMs = 0;
  #disposed = false;
  /** Bumped whenever something changed that a frame must redraw for. */
  #dirty = true;

  #status: MapStatus = { phase: 'starting', message: 'Starting WebGPU…' };
  #stats: MapStats = emptyStats();
  #listeners = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement, client: RasterClient = new RasterClient()) {
    this.#canvas = canvas;
    this.client = client;
  }

  // ---- observation -------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get status(): MapStatus {
    return this.#status;
  }

  get stats(): MapStats {
    return this.#stats;
  }

  get settings(): RenderSettings {
    return this.#settings;
  }

  get camera(): CameraState {
    return this.#camera;
  }

  get scene(): Scene | null {
    return this.#scene;
  }

  get sceneB(): Scene | null {
    return this.#sceneB;
  }

  get gpuInfo(): GpuContext['info'] | null {
    return this.#context?.info ?? null;
  }

  get canCompare(): boolean {
    return this.#scene != null;
  }

  // ---- lifecycle ---------------------------------------------------------

  async init(): Promise<void> {
    try {
      this.#context = await GpuContext.create();
      this.#context.attachCanvas(this.#canvas);
      this.#context.configure();
      this.#context.onDeviceLost((info) => {
        this.#setStatus({
          phase: 'error',
          message: `The GPU device was lost (${info.reason}). Reload to continue.`,
        });
        this.#stop();
      });
      this.#context.onError((message) => {
        // Validation errors do not throw. Without this they are only visible in
        // the console, and a blank canvas gives no clue which bind group is at
        // fault.
        this.#setStatus({ phase: 'error', message: `WebGPU error: ${message}` });
      });

      this.#renderer = new RasterRenderer(this.#context);
      await this.#renderer.initialise();
      this.#ndvi = new NdviGpu(this.#context.device);
      await this.#ndvi.initialise();

      this.#setStatus({ phase: 'ready', message: 'Ready' });
      this.resize();
      this.#loop();
    } catch (error) {
      const message = describe(error);
      this.#setStatus({
        phase: 'error',
        message: error instanceof WebGpuUnavailable ? message : `Startup failed: ${message}`,
      });
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop();
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear();
    for (const tile of this.#gpu.values()) this.#renderer?.destroyTile(tile);
    this.#gpu.clear();
    this.#ndvi?.destroy();
    this.#renderer?.destroy();
    this.#context?.destroy();
  }

  // ---- scene selection ---------------------------------------------------

  /** Load a primary date. Clears every tile, because tile bytes are date-specific. */
  async setScene(scene: Scene): Promise<void> {
    this.#scene = scene;
    this.#clearTiles();
    this.#setSceneB(this.#settings.swipeEnabled ? this.#sceneB : null);
    this.#invalidate();
  }

  /** Load a comparison date, or clear it with `null`. */
  async setSceneB(scene: Scene | null): Promise<void> {
    // Comparison resources are attached to A's resident tiles. They must be
    // released before changing B or a tile outside the new viewport can keep
    // the previous acquisition alive indefinitely.
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear();
    this.#failed.clear();
    for (const tile of this.#gpu.values()) this.#renderer?.releaseSecondDate(tile);
    this.#setSceneB(scene);
    this.#invalidate();
  }

  #setSceneB(scene: Scene | null): void {
    // A/B must not be the same acquisition, or the difference is identically
    // zero and the view looks broken rather than empty.
    if (scene && this.#scene && scene.id === this.#scene.id) scene = null;
    this.#sceneB = scene;
    this.#settings = { ...this.#settings, swipeEnabled: scene != null && this.#settings.layer !== 'difference' ? this.#settings.swipeEnabled : false };
  }

  updateSettings(patch: Partial<RenderSettings>): void {
    const qualityChanged = patch.qualityMask != null && patch.qualityMask !== this.#settings.qualityMask;
    const next = { ...this.#settings, ...patch };
    // Swipe and difference are mutually exclusive ways of using two dates: the
    // shader cannot split a difference image down the middle, so asking for
    // both silently drops the swipe.
    if (next.layer === 'difference' && next.swipeEnabled) next.swipeEnabled = false;
    if (next.swipeEnabled && !this.#sceneB) next.swipeEnabled = false;
    if (!next.swipeEnabled && next.layer === 'difference' && !this.#sceneB) next.layer = 'ndvi';
    this.#settings = next;
    if (qualityChanged) this.#clearTiles();
    this.#invalidate();
  }

  // ---- interaction -------------------------------------------------------

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    this.#viewport = { width: rect.width, height: rect.height, dpr };
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    this.#invalidate();
  }

  panByPixels(dx: number, dy: number): void {
    this.#camera = panBy(this.#camera, dx, dy);
    this.#invalidate();
  }

  zoomAroundPixels(deltaY: number, offsetX: number, offsetY: number): void {
    const next = zoomAround(this.#camera, this.#viewport, deltaY, offsetX, offsetY);
    if (next === this.#camera) return;
    this.#camera = next;
    this.#invalidate();
  }

  setView(center: { lon: number; lat: number }, zoom: number): void {
    this.#camera = createCamera(center, zoom);
    this.#invalidate();
  }

  viewBounds(): { west: number; south: number; east: number; north: number } {
    const nw = screenToLonLat(this.#camera, this.#viewport, 0, 0);
    const se = screenToLonLat(this.#camera, this.#viewport, this.#viewport.width, this.#viewport.height);
    return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
  }

  inspectPixel(offsetX: number, offsetY: number): PixelInspection {
    const point = screenToLonLat(this.#camera, this.#viewport, offsetX, offsetY);
    const scene = this.#scene;
    const empty = (status: PixelInspection['status']): PixelInspection => ({
      lon: point.lon, lat: point.lat, status, date: scene?.datetime ?? null,
      red: null, green: null, blue: null, nir: null, ndvi: null, qualityValid: null,
    });
    if (!scene) return empty('outside');
    const z = tileZoom(this.#camera);
    const world = lonLatToWorldPx(point, z);
    const x = Math.floor(world.px / TILE_SIZE);
    const y = Math.floor(world.py / TILE_SIZE);
    const resident = this.#gpu.get(tileKey(scene, z, x, y));
    if (!resident) return empty(covers(scene, z, x, y) ? 'loading' : 'outside');
    const px = Math.max(0, Math.min(resident.width - 1, Math.floor(world.px - x * TILE_SIZE)));
    const py = Math.max(0, Math.min(resident.height - 1, Math.floor(world.py - y * TILE_SIZE)));
    const index = py * resident.width + px;
    const tile = resident.source;
    const value = (name: string): number | null => {
      const band = tile.bands[name];
      return band && Number.isFinite(band[index]) ? band[index] : null;
    };
    const red = value('red');
    const nir = value('nir');
    const quality = tile.masks.quality?.[index] === 1;
    const result = computeNdvi(
      red ?? Number.NaN, nir ?? Number.NaN,
      tile.masks.red?.[index] === 1, tile.masks.nir?.[index] === 1, quality,
      tile.header.calibration.ndviEpsilon,
    );
    return {
      lon: point.lon, lat: point.lat, status: result.valid ? 'valid' : 'masked',
      date: tile.header.sources.datetime, red, green: value('green'), blue: value('blue'), nir,
      ndvi: result.valid ? result.value : null, qualityValid: quality,
    };
  }

  projectPoint(lon: number, lat: number): { x: number; y: number } {
    const z = tileZoom(this.#camera);
    const camera = lonLatToWorldPx(this.#camera.center, z);
    const point = lonLatToWorldPx({ lon, lat }, z);
    const worldWidth = TILE_SIZE * 2 ** z;
    let dx = point.px - camera.px;
    if (dx > worldWidth / 2) dx -= worldWidth;
    if (dx < -worldWidth / 2) dx += worldWidth;
    const scale = 2 ** (this.#camera.zoom - z);
    return { x: this.#viewport.width / 2 + dx * scale, y: this.#viewport.height / 2 + (point.py - camera.py) * scale };
  }

  // ---- frame -------------------------------------------------------------

  #loop = (): void => {
    if (this.#disposed) return;
    this.#frame = requestAnimationFrame(this.#loop);
    this.#render();
  };

  #stop(): void {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #invalidate(): void {
    this.#dirty = true;
  }

  #render(): void {
    const renderer = this.#renderer;
    const context = this.#context;
    const scene = this.#scene;
    if (!renderer || !context || this.#status.phase !== 'ready') return;
    if (this.#viewport.width <= 0 || this.#viewport.height <= 0) return;
    // Render on demand. The canvas keeps its last presented image until the next
    // draw, so an idle map costs nothing. Tiles in flight keep the loop running
    // even when nothing has been invalidated, because each arrival is one more
    // step toward a complete view.
    if (!this.#dirty && this.#pending.size === 0) return;
    this.#dirty = false;

    if (scene) {
      const visible = visibleTiles(this.#camera, this.#viewport);
      const wanted = new Set<string>();
      for (const item of visible) {
        if (covers(scene, item.tile.z, item.tile.x, item.tile.y)) {
          wanted.add(tileKey(scene, item.tile.z, item.tile.x, item.tile.y));
        }
        this.#ensure(item.tile.z, item.tile.x, item.tile.y, scene, false);
        const parent = parentTile(item.tile.z, item.tile.x, item.tile.y);
        if (parent && covers(scene, parent.z, parent.x, parent.y)) {
          wanted.add(tileKey(scene, parent.z, parent.x, parent.y));
          this.#ensure(parent.z, parent.x, parent.y, scene, false);
        }
      }
      if (this.#sceneB) {
        for (const item of visible) {
          if (covers(this.#sceneB, item.tile.z, item.tile.x, item.tile.y)) {
            wanted.add(tileKey(this.#sceneB, item.tile.z, item.tile.x, item.tile.y));
          }
          this.#ensure(item.tile.z, item.tile.x, item.tile.y, this.#sceneB, true);
          const parent = parentTile(item.tile.z, item.tile.x, item.tile.y);
          if (parent && covers(this.#sceneB, parent.z, parent.x, parent.y)) {
            wanted.add(tileKey(this.#sceneB, parent.z, parent.x, parent.y));
            this.#ensure(parent.z, parent.x, parent.y, this.#sceneB, true);
          }
        }
      }
      this.#abortUnwanted(wanted);
    }

    const started = performance.now();
    if (renderer.ready) {
      const tiles: DrawTile[] = scene
        ? visibleTiles(this.#camera, this.#viewport).map((item) => {
            const exact = tileKey(scene, item.tile.z, item.tile.x, item.tile.y);
            const parent = parentTile(item.tile.z, item.tile.x, item.tile.y);
            const useParent = !this.#gpu.has(exact) && parent
              ? tileKey(scene, parent.z, parent.x, parent.y)
              : null;
            return {
              key: useParent && this.#gpu.has(useParent) ? useParent : exact,
              screenX: item.screenX,
              screenY: item.screenY,
              // The quad still occupies the child's screen extent. Only its
              // texture coordinates point into the retained parent.
              scale: 2 ** (this.#camera.zoom - item.tile.z),
              uv: useParent && this.#gpu.has(useParent)
                ? parentUv(item.tile.x, item.tile.y)
                : undefined,
            };
          })
        : [];
      renderer.draw(tiles, (key) => this.#touch(key), this.#viewport, this.#settings);
    }
    this.#lastFrameMs = performance.now() - started;
    this.#publishStats();
  }

  // ---- tile residency ----------------------------------------------------

  #ensure(z: number, x: number, y: number, scene: Scene, isSecond: boolean): void {
    const key = tileKey(scene, z, x, y);
    if (isSecond) {
      // Only fetch B once A is resident: a swipe of two half-loaded dates shows
      // one side, then a hole, then the other side.
      if (!this.#scene || !this.#gpu.has(tileKey(this.#scene, z, x, y))) return;
    } else if (this.#gpu.has(key)) {
      return;
    }
    if (this.#pending.has(key) || this.#failed.has(key)) return;
    // Bounds are cheap and the alternative is a screen full of failed requests
    // for a scene that does not cover the view.
    if (!covers(scene, z, x, y)) return;

    const controller = new AbortController();
    this.#pending.set(key, controller);
    const descriptor: TileDescriptor = {
      collection: scene.collection,
      itemId: scene.id,
      profile: PROFILE,
      qualityMask: this.#settings.qualityMask,
      z,
      x,
      y,
    };
    void this.client
      .tile(descriptor, { signal: controller.signal })
      .then((tile) => {
        this.#pending.delete(key);
        // Abort can race response decoding. An obsolete response must never
        // allocate GPU resources after the camera or date has moved on.
        if (controller.signal.aborted) return;
        this.#admit(key, tile, z, x, y, isSecond);
      })
      .catch((error: unknown) => {
        this.#pending.delete(key);
        if (controller.signal.aborted) return;
        // 404 is the normal answer for a tile outside the scene footprint.
        // Retrying it forever would pin the scene's edges as permanent errors.
        if (error instanceof RasterError && error.status === 404) {
          this.#failed.add(key);
          return;
        }
        this.#failed.add(key);
        this.#setStatus({ phase: 'error', message: `Tile request failed: ${describe(error)}` });
      });
  }

  #admit(
    key: string,
    tile: NumericTile,
    z: number,
    x: number,
    y: number,
    isSecond: boolean,
  ): void {
    const renderer = this.#renderer;
    const ndvi = this.#ndvi;
    if (!renderer || !ndvi) return;

    // Each date gets its *own* compute tile. The shader reads A's index and B's
    // index at the same pixel, so they cannot share one upload, and a shared one
    // would make B overwrite A's bands and produce a difference of zero.
    const analysis = this.#analysis(tile);
    ndvi.runNdvi(analysis);
    // No delta kernel here: the shader's difference layer is `ndvi_b - ndvi_a`
    // and reads the two index planes directly. The masked delta plane exists
    // for area statistics, which are not rendered.

    const primaryKey = isSecond ? tileKey(this.#scene!, z, x, y) : key;
    const existing = this.#gpu.get(primaryKey);
    if (existing) {
      if (isSecond) renderer.uploadSecondDate(existing, tile, analysis);
      return;
    }
    if (isSecond) return;
    this.#gpu.set(primaryKey, renderer.upload(primaryKey, tile, analysis));
    this.#evict();
    this.#invalidate();
  }

  #analysis(tile: NumericTile): UploadedTile {
    const ndvi = this.#ndvi!;
    const { width, height } = tile.header;
    const required = (name: string): Uint8Array => {
      const mask = tile.masks[name];
      if (!mask) throw new Error(`tile is missing the '${name}' mask the index needs`);
      return mask;
    };
    return ndvi.uploadTile({
      width,
      height,
      red: tile.bands['red'] ?? new Float32Array(width * height),
      nir: tile.bands['nir'] ?? new Float32Array(width * height),
      redValid: required('red'),
      nirValid: required('nir'),
      qualityValid: required('quality'),
    });
  }

  /**
   * Bound GPU memory.
   *
   * Counted in tiles rather than bytes because a 256x256 rgba32float texture plus
   * its index planes is a fixed ~2.4 MB and the buffer itself would only be a
   * cross-check. Evicting by age-of-use also keeps the pan direction meaningful:
   * tiles behind the camera are the ones that drop out.
   */
  #evict(): void {
    const max = MAX_RESIDENT_TILES;
    if (this.#gpu.size <= max) return;
    for (const key of [...this.#gpu.keys()].slice(0, this.#gpu.size - max)) {
      const tile = this.#gpu.get(key);
      if (tile) this.#renderer?.destroyTile(tile);
      this.#gpu.delete(key);
    }
  }

  /** Mark a resident tile as recently used while resolving a draw. */
  #touch(key: string): RenderTile | undefined {
    const tile = this.#gpu.get(key);
    if (!tile) return undefined;
    // Map iteration order gives us a small, allocation-free LRU list.
    this.#gpu.delete(key);
    this.#gpu.set(key, tile);
    return tile;
  }

  /** Cancel queued and active work that can no longer contribute to the view. */
  #abortUnwanted(wanted: ReadonlySet<string>): void {
    for (const [key, controller] of this.#pending) {
      if (wanted.has(key)) continue;
      controller.abort();
      this.#pending.delete(key);
    }
  }

  #clearTiles(): void {
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear();
    this.#failed.clear();
    for (const tile of this.#gpu.values()) this.#renderer?.destroyTile(tile);
    this.#gpu.clear();
  }

  #publishStats(): void {
    this.#stats = {
      resident: this.#gpu.size,
      pending: this.#pending.size,
      failed: this.#failed.size,
      bytes: this.#gpu.size * BYTES_PER_TILE_ESTIMATE,
      zoom: this.#camera.zoom,
      centre: this.#camera.center,
      lastFrameMs: this.#lastFrameMs,
      requests: this.client.metrics.requests,
      downloadedBytes: this.client.metrics.downloadedBytes,
      decodeMs: this.client.metrics.decodeMs,
      cacheHits: this.client.metrics.edgeHits + this.client.metrics.r2Hits,
    };
    this.#emit();
  }

  #setStatus(status: MapStatus): void {
    this.#status = status;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const MAX_RESIDENT_TILES = 48;
const MIN_PARENT_ZOOM = 8;
const BYTES_PER_TILE_ESTIMATE = 256 * 256 * 40;

function emptyStats(): MapStats {
  return {
    resident: 0,
    pending: 0,
    failed: 0,
    bytes: 0,
    zoom: 0,
    centre: { lon: 0, lat: 0 },
    lastFrameMs: 0,
    requests: 0,
    downloadedBytes: 0,
    decodeMs: 0,
    cacheHits: 0,
  };
}

function tileKey(scene: Scene, z: number, x: number, y: number): string {
  return `${scene.collection}/${scene.id}/${z}/${x}/${y}`;
}

function parentTile(z: number, x: number, y: number): { z: number; x: number; y: number } | null {
  if (z <= MIN_PARENT_ZOOM) return null;
  return { z: z - 1, x: x >> 1, y: y >> 1 };
}

function parentUv(x: number, y: number): readonly [number, number, number, number] {
  const u0 = (x & 1) * 0.5;
  const v0 = (y & 1) * 0.5;
  return [u0, v0, u0 + 0.5, v0 + 0.5];
}

/**
 * Does the scene's footprint plausibly contain this tile?
 *
 * Bounds-only, by design: it is a coarse filter that avoids requests known to
 * fail, not a precise test. The server still returns 404 for tiles inside the
 * bounding box that fall between scene granules, and that is handled as a 404.
 */
function covers(scene: Scene, z: number, x: number, y: number): boolean {
  const bbox = scene.bbox;
  if (bbox.length < 4) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = tileToLat(y, n);
  const south = tileToLat(y + 1, n);
  return east >= minLon && west <= maxLon && south >= minLat && north <= maxLat;
}

function tileToLat(y: number, n: number): number {
  const t = Math.PI - (2 * Math.PI * y) / n;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
