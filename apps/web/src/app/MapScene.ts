/**
 * The map: camera, tile residency, GPU resources, and the render loop.
 *
 * Deliberately free of React. It owns mutable GPU state and a
 * requestAnimationFrame loop, and pushing that through a component's render
 * cycle is how you end up uploading a tile twice per frame. React reads it
 * through `subscribe` and the immutable snapshots below.
 */

import {
  MAX_ZOOM,
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
import { RasterClient, RasterError, type RequestProgress, type TileDescriptor } from '../data/RasterClient';
import type { NumericTile, Scene } from '@terrascope/contracts';
import { lonLatToWorldPx, TILE_SIZE } from '@terrascope/contracts';
import { computeNdvi } from '../analysis/AnalysisPipelines';
import type { FrameScene } from './comparePlan';

const TILE_RETRY_MS = 12_000;
import { TileRequestScheduler } from '../map/TileRequestScheduler';

/** The profile every view requests. Only this one has all four bands. */
const PROFILE = 'rgbn';
/** Stream tiles one by one so progress updates smoothly and pairs resolve in order. */
const MAX_CONCURRENT_TILE_REQUESTS = 1;

export interface MapStats {
  resident: number;
  pending: number;
  failed: number;
  /** Most recent tile failure other than 404, for the HUD. */
  lastTileError: string | null;
  /** Bytes held by decoded tiles, from the server's own header where present. */
  bytes: number;
  zoom: number;
  centre: { lon: number; lat: number };
  lastFrameMs: number;
  requests: number;
  downloadedBytes: number;
  decodeMs: number;
  cacheHits: number;
  /** Milliseconds from selecting the current scene to its first tile on the GPU. */
  firstImageMs: number | null;
  /** Tiles the current view is made of, and how many of them are settled. */
  neededTiles: number;
  neededDone: number;
  /** Tile requests in flight, by phase. */
  inFlight: RequestProgress;
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

  #pending = new TileRequestScheduler(MAX_CONCURRENT_TILE_REQUESTS);
  /** Tile key -> earliest time (ms) it may be requested again. */
  #failed = new Map<string, number>();
  #lastTileError: string | null = null;
  #needTotal = 0;
  #needDone = 0;
  #sceneStartedAt = 0;
  #firstImageMs: number | null = null;
  #frame = 0;
  #lastFrameMs = 0;
  #disposed = false;
  /** Bumped whenever something changed that a frame must redraw for. */
  #dirty = true;

  #status: MapStatus = { phase: 'starting', message: 'Starting WebGPU…' };
  #stats: MapStats = emptyStats();
  #listeners = new Set<() => void>();

  /** Camera and viewport together, replaced whenever either changes. The DOM basemap follows this. */
  #view: MapView = { camera: this.#camera, viewport: this.#viewport };

  #compare: CompareSession | null = null;
  #compareSnapshot: CompareState = IDLE_COMPARE;
  #loadedSecond = new Set<string>();

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

  get gpuContext(): GpuContext | null {
    return this.#context;
  }

  get gpuInfo(): GpuContext['info'] | null {
    return this.#context?.info ?? null;
  }

  get view(): MapView {
    return this.#view;
  }

  get compare(): CompareState {
    return this.#compareSnapshot;
  }

  /** A comparison is loaded, so both dates are on screen. */
  get canCompare(): boolean {
    return this.#compare != null;
  }

  // ---- lifecycle ---------------------------------------------------------

  async init(): Promise<void> {
    try {
      this.#context = await GpuContext.create();
      this.#context.attachCanvas(this.#canvas);
      this.resize();
      this.#context.configure();
      this.#context.onDeviceLost((info) => {
        this.#setStatus({
          phase: 'error',
          message: `The GPU device was lost (${info.message || info.reason}). Reload to continue.`,
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
    this.stopCompare();
    this.#pending.clear();
    for (const tile of this.#gpu.values()) this.#renderer?.destroyTile(tile);
    this.#gpu.clear();
    this.#ndvi?.destroy();
    this.#renderer?.destroy();
    this.#context?.destroy();
  }

  // ---- comparison --------------------------------------------------------

  /**
   * Compare two dates across the current view.
   *
   * Both are read on one grid (see `planFrame`) so the swipe seam lands on the
   * same ground on both sides and the difference layer is exact. A is the
   * earlier date, so dragging the divider right always moves forward in time.
   */
  startCompare(pair: { a: FrameScene; b: FrameScene; fromGapDays: number; toGapDays: number }): void {
    this.stopCompare();
    this.#pending.clear();
    this.#clearTiles();
    this.#scene = pair.a;
    this.#sceneB = pair.b;
    this.#compare = {
      a: pair.a,
      b: pair.b,
      fromGapDays: pair.fromGapDays,
      toGapDays: pair.toGapDays,
      statusA: 'loading',
      statusB: 'loading',
    };
    this.#sceneStartedAt = performance.now();
    this.#firstImageMs = null;
    // A difference is one image of two dates and cannot be split down the
    // middle, so it is the one layer the swipe steps aside for.
    this.#settings = { ...this.#settings, swipeEnabled: this.#settings.layer !== 'difference' };
    this.#publishCompare();
    this.#invalidate();
  }

  /** Release both dates and return to the plain map. */
  stopCompare(): void {
    const compare = this.#compare;
    if (!compare) return;
    this.#compare = null;
    this.#scene = null;
    this.#sceneB = null;
    this.#clearTiles();
    this.#settings = { ...this.#settings, swipeEnabled: false };
    this.#publishCompare();
    this.#invalidate();
  }

  /**
   * Move the swipe divider, 0 at the left edge to 1 at the right.
   */
  setSwipe(fraction: number): void {
    this.#settings = { ...this.#settings, swipe: Math.min(1, Math.max(0, fraction)) };
    this.#invalidate();
    this.#emit();
  }

  #publishCompare(): void {
    const compare = this.#compare;
    this.#compareSnapshot = compare
      ? {
          active: true,
          a: compare.a,
          b: compare.b,
          statusA: compare.statusA,
          statusB: compare.statusB,
          refreshing: false,
          fromGapDays: compare.fromGapDays,
          toGapDays: compare.toGapDays,
        }
      : IDLE_COMPARE;
    this.#emit();
  }

  // ---- settings ------------------------------------------------------------

  updateSettings(patch: Partial<RenderSettings>): void {
    const qualityChanged = patch.qualityMask != null && patch.qualityMask !== this.#settings.qualityMask;
    const next = { ...this.#settings, ...patch };
    // A comparison is shown as a swipe whichever layer is chosen -- that is the
    // whole point of loading two dates. The difference layer is the one view
    // that cannot be split down the middle, so it takes both dates at once and
    // the swipe steps aside until another layer is picked.
    if (next.layer === 'difference') next.swipeEnabled = false;
    else if (this.#compare) next.swipeEnabled = true;
    this.#settings = next;
    if (qualityChanged) {
      // The mask is applied server-side, so both loaded dates are now stale.
      this.#clearTiles();
    }
    this.#invalidate();
    this.#emit();
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
      if (this.#context?.configured) {
        this.#context.configure();
      }
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

  /** Centre and zoom the camera so a geographic box fills the view. */
  fitBounds(bounds: { west: number; south: number; east: number; north: number }, maxZoom = MAX_ZOOM): void {
    const nw = lonLatToWorldPx({ lon: bounds.west, lat: bounds.north }, 0);
    const se = lonLatToWorldPx({ lon: bounds.east, lat: bounds.south }, 0);
    const spanX = Math.max(1e-9, se.px - nw.px);
    const spanY = Math.max(1e-9, se.py - nw.py);
    // Leave a margin so the place is not flush with the edges.
    const fit = Math.log2(Math.min(this.#viewport.width / spanX, this.#viewport.height / spanY) * 0.85);
    const zoom = Math.max(2, Math.min(maxZoom, fit));
    this.setView({ lon: (bounds.west + bounds.east) / 2, lat: (bounds.north + bounds.south) / 2 }, zoom);
  }

  viewBounds(): { west: number; south: number; east: number; north: number } {
    const nw = screenToLonLat(this.#camera, this.#viewport, 0, 0);
    const se = screenToLonLat(this.#camera, this.#viewport, this.#viewport.width, this.#viewport.height);
    return { west: nw.lon, south: se.lat, east: se.lon, north: nw.lat };
  }

  inspectPixel(offsetX: number, offsetY: number): PixelInspection {
    const point = screenToLonLat(this.#camera, this.#viewport, offsetX, offsetY);
    const compare = this.#compare;
    // Report the date the user is actually looking at: whichever side of the
    // divider this pixel falls on, not always the earlier one.
    const onRight = offsetX >= this.#settings.swipe * this.#viewport.width;
    const useB = compare != null
      && this.#settings.layer !== 'difference'
      && onRight
      && compare.statusB === 'ready';
    const scene = compare == null ? null : useB ? compare.b : compare.a;
    const empty = (status: PixelInspection['status']): PixelInspection => ({
      lon: point.lon, lat: point.lat, status, date: scene?.datetime ?? null,
      red: null, green: null, blue: null, nir: null, ndvi: null, qualityValid: null,
    });
    const activeScene = this.#scene;
    if (!activeScene) return empty('outside');
    const z = tileZoom(this.#camera);
    const world = lonLatToWorldPx(point, z);
    const x = Math.floor(world.px / TILE_SIZE);
    const y = Math.floor(world.py / TILE_SIZE);
    const resident = this.#gpu.get(tileKey(activeScene, z, x, y));
    if (!resident) return empty(covers(activeScene, z, x, y) ? 'loading' : 'outside');
    if (useB && resident.sourceB == null) return empty('loading');
    if (!useB && resident.source == null) return empty('loading');
    const px = Math.max(0, Math.min(resident.width - 1, Math.floor(world.px - x * TILE_SIZE)));
    const py = Math.max(0, Math.min(resident.height - 1, Math.floor(world.py - y * TILE_SIZE)));
    const source = (useB && resident.sourceB) ? resident.sourceB : resident.source ?? undefined;
    return readPixel(resident, py * resident.width + px, point, source);
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
    // The basemap is DOM, not GPU: it must follow the camera even when WebGPU
    // is unavailable and no frame is ever rendered.
    if (this.#view.camera !== this.#camera || this.#view.viewport !== this.#viewport) {
      this.#view = { camera: this.#camera, viewport: this.#viewport };
      this.#emit();
    }
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
      // Coarse preview first. One or two overview-level tiles cover the whole
      // view, so something is on screen long before the ~20 detail tiles are.
      // They are requested before any detail tile, which puts them at the
      // front of the client's queue and warms the server's dataset handles.
      const isCompare = this.#compare != null;

      // In compare mode, only request exact visible tiles (no coarse preview tiles or parent stand-ins)
      // so 100% of network bandwidth loads the detail tiles, and missing tiles show the explorer map.
      let preview: Array<{ z: number; x: number; y: number }> = [];
      if (!isCompare) {
        preview = previewTiles(scene, visible.map((item) => item.tile));
        for (const [distance, tile] of preview.entries()) {
          wanted.add(tileKey(scene, tile.z, tile.x, tile.y));
          this.#ensure(tile.z, tile.x, tile.y, scene, false, requestScore(0, distance));
        }
        const holdDetail = preview.some((tile) => this.#pending.has(tileKey(scene, tile.z, tile.x, tile.y)))
          && !this.#hasResident(scene);
        for (const item of holdDetail ? [] : visible) {
          const parent = parentTile(item.tile.z, item.tile.x, item.tile.y);
          if (parent && covers(scene, parent.z, parent.x, parent.y)) {
            wanted.add(tileKey(scene, parent.z, parent.x, parent.y));
            this.#ensure(parent.z, parent.x, parent.y, scene, false, requestScore(1, 1 - item.priority));
          }
        }
        for (const item of holdDetail ? [] : visible) {
          if (covers(scene, item.tile.z, item.tile.x, item.tile.y)) {
            wanted.add(tileKey(scene, item.tile.z, item.tile.x, item.tile.y));
          }
          this.#ensure(item.tile.z, item.tile.x, item.tile.y, scene, false, requestScore(2, 1 - item.priority));
        }
      } else {
        // In compare mode: request both sides for each tile coordinate together,
        // prioritised from the view centre outward.
        for (const item of visible) {
          const priorityA = requestScore(2, 1 - item.priority);
          const priorityB = priorityA + 0.0001;

          if (covers(scene, item.tile.z, item.tile.x, item.tile.y)) {
            wanted.add(tileKey(scene, item.tile.z, item.tile.x, item.tile.y));
            this.#ensure(item.tile.z, item.tile.x, item.tile.y, scene, false, priorityA);
          }

          if (this.#sceneB && covers(this.#sceneB, item.tile.z, item.tile.x, item.tile.y)) {
            wanted.add(tileKey(this.#sceneB, item.tile.z, item.tile.x, item.tile.y));
            this.#ensure(item.tile.z, item.tile.x, item.tile.y, this.#sceneB, true, priorityB);
          }
        }
      }
      this.#abortUnwanted(wanted);

      // What the finished view is made of: the preview plus the detail tiles.
      // Parents are stand-ins, not part of the target.
      const neededA: string[] = [];
      for (const tile of preview) neededA.push(tileKey(scene, tile.z, tile.x, tile.y));
      for (const item of visible) {
        if (covers(scene, item.tile.z, item.tile.x, item.tile.y)) neededA.push(tileKey(scene, item.tile.z, item.tile.x, item.tile.y));
      }
      const doneA = neededA.filter((key) => (this.#gpu.get(key)?.analysisA != null) || this.#failed.has(key)).length;

      let neededB: string[] = [];
      let doneB = 0;
      if (this.#sceneB) {
        for (const item of visible) {
          if (covers(this.#sceneB, item.tile.z, item.tile.x, item.tile.y)) neededB.push(tileKey(this.#sceneB, item.tile.z, item.tile.x, item.tile.y));
        }
        doneB = neededB.filter((key) => this.#loadedSecond.has(key) || this.#failed.has(key)).length;
      }

      this.#needTotal = neededA.length + neededB.length;
      this.#needDone = doneA + doneB;

      if (this.#compare) {
        const nextStatusA: CompareStatus = neededA.length === 0 || doneA >= neededA.length ? 'ready' : 'loading';
        const nextStatusB: CompareStatus = neededB.length === 0 || doneB >= neededB.length ? 'ready' : 'loading';
        if (this.#compare.statusA !== nextStatusA || this.#compare.statusB !== nextStatusB) {
          this.#compare.statusA = nextStatusA;
          this.#compare.statusB = nextStatusB;
          this.#publishCompare();
        }
      }
    } else {
      this.#needTotal = 0;
      this.#needDone = 0;
    }

    const started = performance.now();
    if (renderer.ready) {
      const isCompare = this.#compare != null;
      const tiles: DrawTile[] = scene
        ? visibleTiles(this.#camera, this.#viewport).map((item) => {
            const exact = tileKey(scene, item.tile.z, item.tile.x, item.tile.y);
            // In compare mode: if exact tile is not loaded, do not stretch coarse ancestors;
            // leave it unrendered so the explorer basemap shows through until exact tiles arrive!
            const fallback = isCompare ? null : (this.#gpu.has(exact) ? null : this.#residentAncestor(scene, item.tile));
            return {
              key: fallback?.key ?? exact,
              screenX: item.screenX,
              screenY: item.screenY,
              // The quad still occupies the child's screen extent. Only its
              // texture coordinates point into the retained ancestor.
              scale: 2 ** (this.#camera.zoom - item.tile.z),
              uv: fallback?.uv,
            };
          })
        : [];
      renderer.draw(tiles, (key) => this.#touch(key), this.#viewport, this.#settings);
    }
    this.#lastFrameMs = performance.now() - started;
    this.#publishStats();
  }

  // ---- tile residency ----------------------------------------------------

  #ensure(z: number, x: number, y: number, scene: Scene, isSecond: boolean, priority: number): void {
    const key = tileKey(scene, z, x, y);
    if (isSecond) {
      if (this.#loadedSecond.has(key)) return;
    } else if (this.#gpu.has(key)) {
      return;
    }
    if (this.#pending.has(key)) return;
    // A transient failure (cold upstream, dropped range read) must not leave a
    // permanent hole, so non-404 failures become eligible again after a delay.
    const retryAt = this.#failed.get(key);
    if (retryAt !== undefined) {
      if (performance.now() < retryAt) return;
      this.#failed.delete(key);
    }
    // Bounds are cheap and the alternative is a screen full of failed requests
    // for a scene that does not cover the view.
    if (!covers(scene, z, x, y)) return;

    const descriptor: TileDescriptor = {
      collection: scene.collection,
      itemId: scene.id,
      profile: PROFILE,
      qualityMask: this.#settings.qualityMask,
      z,
      x,
      y,
    };
    this.#pending.enqueue({ key, priority, run: async (signal) => {
      await this.client
      .tile(descriptor, { signal })
      .then((tile) => {
        // Abort can race response decoding. An obsolete response must never
        // allocate GPU resources after the camera or date has moved on.
        if (signal.aborted) return;
        this.#admit(key, tile, z, x, y, isSecond);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        // 404 is the normal answer for a tile outside the scene footprint.
        // Retrying it forever would pin the scene's edges as permanent errors.
        if (error instanceof RasterError && error.status === 404) {
          this.#failed.set(key, Infinity);
          // One more frame, so the progress readout settles on the final count.
          this.#invalidate();
          return;
        }
        this.#failed.set(key, performance.now() + TILE_RETRY_MS);
        // One tile is not the map: a page-level error would stop rendering
        // every tile that did arrive. Report it in the HUD and retry later.
        this.#lastTileError = `Tile request failed: ${describe(error)}`;
        this.#publishStats();
        setTimeout(() => this.#invalidate(), TILE_RETRY_MS);
      });
    }});
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

    if (isSecond) {
      this.#loadedSecond.add(key);
      if (this.#scene) {
        const primaryKey = tileKey(this.#scene, z, x, y);
        const existing = this.#gpu.get(primaryKey);
        if (existing) {
          renderer.uploadSecond(primaryKey, tile, analysis, existing);
        } else {
          const gpuTile = renderer.uploadSecond(primaryKey, tile, analysis);
          this.#gpu.set(primaryKey, gpuTile);
        }
      }
      this.#invalidate();
      return;
    }

    const primaryKey = key;
    const existing = this.#gpu.get(primaryKey);
    let gpuTile: RenderTile;
    if (existing) {
      gpuTile = renderer.upload(primaryKey, tile, analysis, existing);
    } else {
      gpuTile = renderer.upload(primaryKey, tile, analysis);
      this.#gpu.set(primaryKey, gpuTile);
    }

    if (this.#firstImageMs === null) {
      this.#firstImageMs = performance.now() - this.#sceneStartedAt;
      console.info(`[TerraScope] first image in ${this.#firstImageMs.toFixed(0)} ms (tile z${z}/${x}/${y})`);
    }
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
      if (tile) {
        if (tile.analysisA) this.#ndvi?.destroyTile(tile.analysisA);
        if (tile.analysisB) this.#ndvi?.destroyTile(tile.analysisB);
        this.#renderer?.destroyTile(tile);
      }
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

  /** Is any tile of this scene on the GPU? */
  #hasResident(scene: Scene): boolean {
    const prefix = `${scene.collection}/${scene.id}/`;
    for (const key of this.#gpu.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * The nearest resident ancestor of a tile, and the part of it the tile covers.
   *
   * Nearest first, so the sharpest available stand-in is drawn: the parent
   * once it arrives, the coarse preview before that.
   */
  #residentAncestor(
    scene: Scene,
    tile: { z: number; x: number; y: number },
  ): { key: string; uv: readonly [number, number, number, number] } | null {
    for (let depth = 1; tile.z - depth >= COARSEST_ZOOM; depth += 1) {
      const key = tileKey(scene, tile.z - depth, tile.x >> depth, tile.y >> depth);
      if (this.#gpu.has(key)) return { key, uv: ancestorUv(tile.x, tile.y, depth) };
    }
    return null;
  }

  /** Cancel queued and active work that can no longer contribute to the view. */
  #abortUnwanted(wanted: ReadonlySet<string>): void {
    this.#pending.cancelExcept(wanted);
  }

  #clearTiles(): void {
    this.#pending.clear();
    this.#failed.clear();
    for (const tile of this.#gpu.values()) {
      if (tile.analysisA) this.#ndvi?.destroyTile(tile.analysisA);
      if (tile.analysisB) this.#ndvi?.destroyTile(tile.analysisB);
      this.#renderer?.destroyTile(tile);
    }
    this.#gpu.clear();
    this.#loadedSecond.clear();
  }

  #publishStats(): void {
    this.#stats = {
      resident: this.#gpu.size,
      pending: this.#pending.size,
      failed: this.#failed.size,
      lastTileError: this.#failed.size > 0 ? this.#lastTileError : null,
      bytes: this.#gpu.size * BYTES_PER_TILE_ESTIMATE,
      zoom: this.#camera.zoom,
      centre: this.#camera.center,
      lastFrameMs: this.#lastFrameMs,
      requests: this.client.metrics.requests,
      downloadedBytes: this.client.metrics.downloadedBytes,
      decodeMs: this.client.metrics.decodeMs,
      cacheHits: this.client.metrics.edgeHits + this.client.metrics.r2Hits,
      firstImageMs: this.#firstImageMs,
      neededTiles: this.#needTotal,
      neededDone: this.#needDone,
      inFlight: this.client.progress,
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
/** Coarsest zoom the ordinary parent fallback uses. */
const MIN_PARENT_ZOOM = 8;
/** Coarsest zoom the raster service serves (its MIN_ZOOM); nothing below it exists. */
const COARSEST_ZOOM = 8;
/** Levels between the view and its preview tiles. */
const PREVIEW_ZOOM_DROP = 3;
const BYTES_PER_TILE_ESTIMATE = 256 * 256 * 40;

/** Resolution dominates distance: parent centre, parent edge, exact centre, exact edge. */
function requestScore(resolutionPriority: number, distance: number): number {
  return resolutionPriority * 1_000 + Math.max(0, distance);
}

function emptyStats(): MapStats {
  return {
    resident: 0,
    pending: 0,
    failed: 0,
    lastTileError: null,
    bytes: 0,
    zoom: 0,
    centre: { lon: 0, lat: 0 },
    lastFrameMs: 0,
    requests: 0,
    downloadedBytes: 0,
    decodeMs: 0,
    cacheHits: 0,
    firstImageMs: null,
    neededTiles: 0,
    neededDone: 0,
    inFlight: IDLE_PROGRESS,
  };
}

export const IDLE_PROGRESS: RequestProgress = {
  queued: 0, waiting: 0, downloading: 0, loadedBytes: 0, totalBytes: 0, oldestMs: null,
};

// ---- compare types and helpers ------------------------------------------

export interface MapView {
  camera: CameraState;
  viewport: Viewport;
}

export type CompareStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Immutable snapshot for React. Replaced, never mutated, on every change. */
export interface CompareState {
  active: boolean;
  a: FrameScene | null;
  b: FrameScene | null;
  statusA: CompareStatus;
  statusB: CompareStatus;
  /** The view moved; a re-read is about to run after the gesture settles. */
  refreshing: boolean;
  fromGapDays: number;
  toGapDays: number;
}

export const IDLE_COMPARE: CompareState = {
  active: false,
  a: null,
  b: null,
  statusA: 'idle',
  statusB: 'idle',
  refreshing: false,
  fromGapDays: 0,
  toGapDays: 0,
};

interface CompareSession {
  a: FrameScene;
  b: FrameScene;
  fromGapDays: number;
  toGapDays: number;
  statusA: CompareStatus;
  statusB: CompareStatus;
}

/** Values and NDVI at one sample of a resident tile or frame. */
function readPixel(
  resident: RenderTile,
  index: number,
  point: { lon: number; lat: number },
  source?: NumericTile,
): PixelInspection {
  const tile = source ?? resident.source;
  if (!tile) {
    return {
      lon: point.lon, lat: point.lat, status: 'outside',
      date: null, red: null, green: null, blue: null, nir: null,
      ndvi: null, qualityValid: null,
    };
  }
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

function tileKey(scene: Scene, z: number, x: number, y: number): string {
  return `${scene.collection}/${scene.id}/${z}/${x}/${y}`;
}

function parentTile(z: number, x: number, y: number): { z: number; x: number; y: number } | null {
  if (z <= MIN_PARENT_ZOOM) return null;
  return { z: z - 1, x: x >> 1, y: y >> 1 };
}

/** The sub-rectangle of an ancestor `depth` levels up that a tile covers. */
function ancestorUv(x: number, y: number, depth: number): readonly [number, number, number, number] {
  const n = 2 ** depth;
  const size = 1 / n;
  const u0 = (x % n) * size;
  const v0 = (y % n) * size;
  return [u0, v0, u0 + size, v0 + size];
}

/**
 * Coarse tiles covering the view, `PREVIEW_ZOOM_DROP` levels above it.
 *
 * Eight times coarser means one tile spans what ~64 detail tiles do, and the
 * server reads it from the COG overviews rather than full-resolution blocks.
 * Empty when the view is already at or near the coarsest served zoom.
 */
function previewTiles(scene: Scene, visible: Array<{ z: number; x: number; y: number }>): Array<{ z: number; x: number; y: number }> {
  const out = new Map<string, { z: number; x: number; y: number }>();
  for (const tile of visible) {
    const z = Math.max(COARSEST_ZOOM, tile.z - PREVIEW_ZOOM_DROP);
    // At z-1 the ordinary parent fetch already covers this.
    if (tile.z - z < 2) continue;
    const depth = tile.z - z;
    const preview = { z, x: tile.x >> depth, y: tile.y >> depth };
    if (covers(scene, preview.z, preview.x, preview.y)) out.set(`${z}/${preview.x}/${preview.y}`, preview);
  }
  return [...out.values()];
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
  // Overlap on both axes. Latitude used to test containment instead, which
  // rejected every tile taller than the scene -- all coarse preview tiles.
  return east >= minLon && west <= maxLon && north >= minLat && south <= maxLat;
}

function tileToLat(y: number, n: number): number {
  const t = Math.PI - (2 * Math.PI * y) / n;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
