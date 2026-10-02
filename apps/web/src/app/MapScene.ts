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
import { planFrame, timelineWindow, type FramePlan, type FrameScene } from './timelapsePlan';
import { TileRequestScheduler } from '../map/TileRequestScheduler';

/** The profile every view requests. Only this one has all four bands. */
const PROFILE = 'rgbn';
/** Delay before a tile that failed for a reason other than 404 is requested again. */
const TILE_RETRY_MS = 10_000;
const MAX_CONCURRENT_TILE_REQUESTS = 6;

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

  #timelapse: TimelapseSession | null = null;
  /** Auto-remove frames cloudier than this fraction of the view; null = off. Kept across timelapses. */
  #autoCloud: number | null = DEFAULT_AUTO_CLOUD;
  #timelapseSnapshot: TimelapseState = IDLE_TIMELAPSE;
  /** Frame index actually on screen: the current one, or its nearest stand-in. */
  #drawnFrame: number | null = null;

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

  get view(): MapView {
    return this.#view;
  }

  get timelapse(): TimelapseState {
    return this.#timelapseSnapshot;
  }

  get canCompare(): boolean {
    return this.#scene != null;
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
    this.stopTimelapse();
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
    this.#sceneStartedAt = performance.now();
    this.#firstImageMs = null;
    this.#clearTiles();
    this.#setSceneB(this.#settings.swipeEnabled ? this.#sceneB : null);
    this.#invalidate();
  }

  /** Load a comparison date, or clear it with `null`. */
  async setSceneB(scene: Scene | null): Promise<void> {
    // Comparison resources are attached to A's resident tiles. They must be
    // released before changing B or a tile outside the new viewport can keep
    // the previous acquisition alive indefinitely.
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
    if (qualityChanged) {
      this.#clearTiles();
      // The mask is applied server-side, so loaded frames are now stale.
      // Same frames, same locked view: start over with the new policy.
      if (this.#timelapse) this.startTimelapse(this.#timelapse.frames);
    }
    this.#invalidate();
  }

  // ---- timelapse ---------------------------------------------------------

  /**
   * Lock the view and play `frames` (already selected, oldest first).
   *
   * Every frame is read for exactly the current view, so the camera is frozen
   * until `stopTimelapse`. Tile requests in flight are dropped: on a slow link
   * they would only compete with the first frame for bandwidth.
   */
  startTimelapse(frames: readonly FrameScene[]): void {
    if (frames.length === 0) return;
    this.stopTimelapse();
    this.#pending.clear();
    // Frames carry one date each; swipe and difference need two.
    this.#setSceneB(null);
    if (this.#settings.layer === 'difference') this.#settings = { ...this.#settings, layer: 'ndvi' };
    this.#settings = { ...this.#settings, swipeEnabled: false };

    this.#timelapse = {
      frames: [...frames],
      status: frames.map(() => 'idle' as FrameStatus),
      excluded: frames.map(() => false),
      viewCloud: frames.map(() => null),
      viewVegetation: frames.map(() => null),
      autoRemoved: frames.map(() => false),
      manual: frames.map(() => false),
      userSeeked: false,
      plan: planFrame(this.viewBounds(), this.#viewport),
      tiles: new Map(),
      loading: new Set(),
      controllers: new Map(),
      index: 0,
      direction: 1,
      playing: false,
      fps: 4,
      loop: true,
      buffering: false,
      lastStep: 0,
    };
    this.#sceneStartedAt = performance.now();
    this.#firstImageMs = null;
    this.#pumpFrames();
    this.#publishTimelapse();
    this.#invalidate();
  }

  /** Release every frame and unlock the view. */
  stopTimelapse(): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    for (const controller of timelapse.controllers.values()) controller.abort();
    for (const tile of timelapse.tiles.values()) this.#renderer?.destroyTile(tile);
    this.#timelapse = null;
    this.#drawnFrame = null;
    this.#publishTimelapse();
    this.#invalidate();
  }

  play(): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    if (!timelapse.loop && timelapse.index >= timelapse.frames.length - 1) timelapse.index = 0;
    timelapse.userSeeked = true;
    timelapse.playing = true;
    timelapse.lastStep = performance.now();
    this.#pumpFrames();
    this.#publishTimelapse();
  }

  pause(): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    timelapse.playing = false;
    timelapse.buffering = false;
    this.#publishTimelapse();
  }

  /** Jump to a frame. Pauses, and fetches that frame next if it is not loaded. */
  seek(index: number): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    const next = Math.max(0, Math.min(timelapse.frames.length - 1, Math.round(index)));
    if (next !== timelapse.index) timelapse.direction = next > timelapse.index ? 1 : -1;
    timelapse.index = next;
    timelapse.userSeeked = true;
    timelapse.playing = false;
    timelapse.buffering = false;
    this.#pumpFrames();
    this.#publishTimelapse();
    // Paused with everything loaded, the loop is idle and draws only when
    // invalidated -- without this the label moves and the picture does not.
    this.#invalidate();
  }

  setPlayback(options: { fps?: number; loop?: boolean }): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    if (options.fps != null) timelapse.fps = Math.max(0.5, Math.min(30, options.fps));
    if (options.loop != null) timelapse.loop = options.loop;
    this.#pumpFrames();
    this.#publishTimelapse();
  }

  /**
   * Remove a date from the timelapse, or restore it.
   *
   * A toggle rather than a delete, so a mis-click is one more click to undo.
   * A removed date is skipped by playback and not fetched while removed; one
   * already loaded stays on the GPU, so restoring it is instant.
   */
  toggleFrame(index: number): void {
    const timelapse = this.#timelapse;
    if (!timelapse || index < 0 || index >= timelapse.frames.length) return;
    timelapse.excluded[index] = !timelapse.excluded[index];
    timelapse.manual[index] = true;
    timelapse.autoRemoved[index] = false;
    this.#pumpFrames();
    this.#publishTimelapse();
    this.#invalidate();
  }

  /**
   * Set the cloud rule: frames with more than `threshold` of the view under
   * cloud are removed automatically (null turns it off). Re-applied to every
   * loaded frame, except dates the user has toggled by hand.
   */
  setAutoCloud(threshold: number | null): void {
    this.#autoCloud = threshold;
    const timelapse = this.#timelapse;
    if (timelapse) {
      timelapse.frames.forEach((_, i) => this.#applyCloudRule(timelapse, i));
      this.#pumpFrames();
      this.#publishTimelapse();
      this.#invalidate();
    }
  }

  /**
   * Explicitly drop/remove all frames exceeding the specified cloud threshold (default 0.3 = 30%).
   */
  dropCloudyFrames(threshold = 0.3): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    for (let i = 0; i < timelapse.frames.length; i += 1) {
      const cloud = timelapse.viewCloud[i] ?? (timelapse.frames[i].cloudCover != null ? timelapse.frames[i].cloudCover! / 100 : null);
      if (cloud != null && cloud > threshold) {
        timelapse.excluded[i] = true;
        timelapse.manual[i] = true;
      }
    }
    if (timelapse.excluded[timelapse.index]) {
      const kept = nearestKept(timelapse, timelapse.index);
      if (kept != null) timelapse.index = kept;
    }
    this.#pumpFrames();
    this.#publishTimelapse();
    this.#invalidate();
  }

  /**
   * Restore all frames to playback.
   */
  restoreAllFrames(): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    for (let i = 0; i < timelapse.frames.length; i += 1) {
      timelapse.excluded[i] = false;
      timelapse.manual[i] = true;
      timelapse.autoRemoved[i] = false;
    }
    this.#pumpFrames();
    this.#publishTimelapse();
    this.#invalidate();
  }

  #applyCloudRule(timelapse: TimelapseSession, index: number): void {
    const cloud = timelapse.viewCloud[index];
    if (timelapse.manual[index] || cloud == null) return;
    const remove = this.#autoCloud != null && cloud > this.#autoCloud;
    if (remove && !timelapse.excluded[index]) {
      timelapse.excluded[index] = true;
      timelapse.autoRemoved[index] = true;
      // Do not leave a paused view parked on a frame that just disappeared
      // from the timeline; move to the nearest kept one.
      if (timelapse.index === index && !timelapse.playing && !timelapse.userSeeked) {
        const kept = nearestKept(timelapse, index);
        if (kept != null) timelapse.index = kept;
      }
    } else if (!remove && timelapse.autoRemoved[index]) {
      timelapse.excluded[index] = false;
      timelapse.autoRemoved[index] = false;
    }
  }

  /**
   * Keep up to FRAME_CONCURRENCY frames in flight, in `order`.
   *
   * Until the first frame is on screen it travels alone: on a
   * bandwidth-limited link, parallel frames would each arrive later.
   */
  #pumpFrames(): void {
    const timelapse = this.#timelapse;
    if (!timelapse) return;
    const wanted = timelineWindow(
      timelapse.frames.length,
      timelapse.index,
      timelapse.direction,
      timelapse.loop,
      timelapse.excluded,
    );
    const wantedSet = new Set(wanted);
    for (const [index, controller] of timelapse.controllers) {
      if (wantedSet.has(index)) continue;
      controller.abort();
      timelapse.controllers.delete(index);
      timelapse.loading.delete(index);
      if (timelapse.status[index] === 'loading') timelapse.status[index] = 'idle';
    }
    const anyReady = timelapse.status.includes('ready');
    while (timelapse.loading.size < (anyReady ? FRAME_CONCURRENCY : 1)) {
      const next = wanted.find((i) => timelapse.status[i] === 'idle');
      if (next === undefined) return;
      this.#loadFrame(timelapse, next);
    }
  }

  #loadFrame(timelapse: TimelapseSession, index: number): void {
    const scene = timelapse.frames[index];
    const controller = new AbortController();
    timelapse.controllers.set(index, controller);
    timelapse.status[index] = 'loading';
    timelapse.loading.add(index);
    void this.client
      .frame(
        {
          collection: scene.collection,
          itemId: scene.id,
          profile: PROFILE,
          bounds3857: timelapse.plan.bounds3857,
          width: timelapse.plan.width,
          height: timelapse.plan.height,
          qualityMask: this.#settings.qualityMask,
          mosaic: scene.mosaicIds,
        },
        { signal: controller.signal },
      )
      .then((tile) => {
        timelapse.loading.delete(index);
        if (timelapse.controllers.get(index) === controller) timelapse.controllers.delete(index);
        if (timelapse !== this.#timelapse || controller.signal.aborted) return;
        const renderer = this.#renderer;
        const ndvi = this.#ndvi;
        if (!renderer || !ndvi) return;
        const analysis = this.#analysis(tile);
        ndvi.runNdvi(analysis);
        timelapse.tiles.set(index, renderer.upload(frameKey(index), tile, analysis));
        timelapse.status[index] = 'ready';
        this.#evictFrames(timelapse);
        timelapse.viewCloud[index] = viewCloudFraction(tile);
        timelapse.viewVegetation[index] = viewVegetationStats(tile);
        this.#applyCloudRule(timelapse, index);
        // Until the user takes over, rest on the earliest date still in the
        // timeline. The first frame loads alone and may be removed as cloudy;
        // the next kept one to arrive is often the last date (fetched early
        // for scrubbing), so keep re-settling as earlier ones land.
        if (!timelapse.playing && !timelapse.userSeeked) {
          const earliest = timelapse.status.findIndex((st, i) => st === 'ready' && !timelapse.excluded[i]);
          if (earliest >= 0) timelapse.index = earliest;
        }
        if (this.#firstImageMs === null) {
          this.#firstImageMs = performance.now() - this.#sceneStartedAt;
          console.info(`[TerraScope] first timelapse frame in ${this.#firstImageMs.toFixed(0)} ms (${scene.datetime.slice(0, 10)})`);
        }
        this.#pumpFrames();
        this.#publishTimelapse();
        this.#invalidate();
      })
      .catch((error: unknown) => {
        timelapse.loading.delete(index);
        if (timelapse.controllers.get(index) === controller) timelapse.controllers.delete(index);
        if (timelapse !== this.#timelapse || controller.signal.aborted) return;
        timelapse.status[index] = 'failed';
        this.#lastTileError = `Frame ${scene.datetime.slice(0, 10)} failed: ${describe(error)}`;
        this.#pumpFrames();
        this.#publishTimelapse();
        this.#invalidate();
      });
  }

  #evictFrames(timelapse: TimelapseSession): void {
    if (timelapse.tiles.size <= MAX_RESIDENT_FRAMES) return;
    const keep = new Set(timelineWindow(
      timelapse.frames.length,
      timelapse.index,
      timelapse.direction,
      timelapse.loop,
      timelapse.excluded,
    ));
    for (const [index, tile] of timelapse.tiles) {
      if (timelapse.tiles.size <= MAX_RESIDENT_FRAMES) break;
      if (keep.has(index)) continue;
      this.#renderer?.destroyTile(tile);
      timelapse.tiles.delete(index);
      timelapse.status[index] = 'idle';
      timelapse.viewCloud[index] = null;
      timelapse.viewVegetation[index] = null;
    }
  }

  #renderTimelapse(renderer: RasterRenderer, timelapse: TimelapseSession): void {
    const now = performance.now();
    // Idle when nothing moves: paused, nothing loading, nothing changed.
    if (!this.#dirty && !timelapse.playing && timelapse.loading.size === 0) return;
    this.#dirty = false;

    if (timelapse.playing && now - timelapse.lastStep >= 1000 / timelapse.fps) {
      this.#stepPlayback(timelapse);
      timelapse.lastStep = now;
    }

    const drawn = nearestReady(timelapse.status, timelapse.index);
    this.#drawnFrame = drawn;
    const started = performance.now();
    if (renderer.ready) {
      const tiles: DrawTile[] = drawn == null ? [] : [{
        key: frameKey(drawn),
        screenX: 0,
        screenY: 0,
        scale: 1,
        size: { width: this.#viewport.width, height: this.#viewport.height },
      }];
      renderer.draw(tiles, (key) => timelapse.tiles.get(frameIndex(key)), this.#viewport, this.#settings);
    }
    this.#lastFrameMs = performance.now() - started;
    // Removed dates are not part of what is being loaded.
    const kept = timelapse.status.filter((_, i) => !timelapse.excluded[i]);
    this.#needTotal = kept.length;
    this.#needDone = kept.filter((s) => s === 'ready' || s === 'failed').length;
    this.#publishStats();
  }

  /**
   * Advance one frame, skipping frames that failed or were removed. A frame that is not
   * loaded yet is not skipped: playback waits for it, like a video buffering,
   * so the sequence is never shown out of order.
   */
  #stepPlayback(timelapse: TimelapseSession): void {
    const count = timelapse.frames.length;
    for (let step = 1; step <= count; step += 1) {
      let next = timelapse.index + step;
      if (next >= count) {
        if (!timelapse.loop) {
          timelapse.playing = false;
          timelapse.buffering = false;
          this.#publishTimelapse();
          return;
        }
        next %= count;
      }
      const status = timelapse.status[next];
      if (status === 'failed' || timelapse.excluded[next]) continue;
      if (status === 'ready') {
        timelapse.index = next;
        timelapse.direction = 1;
        timelapse.buffering = false;
        this.#pumpFrames();
      } else {
        timelapse.buffering = true;
        this.#pumpFrames();
      }
      this.#publishTimelapse();
      return;
    }
    // Every other date is removed or failed: nothing left to advance to.
    timelapse.playing = false;
    timelapse.buffering = false;
    this.#publishTimelapse();
  }

  #publishTimelapse(): void {
    const timelapse = this.#timelapse;
    this.#timelapseSnapshot = timelapse
      ? {
          active: true,
          frames: timelapse.frames,
          status: [...timelapse.status],
          excluded: [...timelapse.excluded],
          viewCloud: [...timelapse.viewCloud],
          viewVegetation: [...timelapse.viewVegetation],
          autoRemoved: [...timelapse.autoRemoved],
          autoCloud: this.#autoCloud,
          index: timelapse.index,
          playing: timelapse.playing,
          buffering: timelapse.buffering,
          fps: timelapse.fps,
          loop: timelapse.loop,
          frameSize: { width: timelapse.plan.width, height: timelapse.plan.height },
        }
      : IDLE_TIMELAPSE;
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
    // A timelapse's frames are read for one exact view; moving would show
    // them in the wrong place.
    if (this.#timelapse) return;
    this.#camera = panBy(this.#camera, dx, dy);
    this.#invalidate();
  }

  zoomAroundPixels(deltaY: number, offsetX: number, offsetY: number): void {
    if (this.#timelapse) return;
    const next = zoomAround(this.#camera, this.#viewport, deltaY, offsetX, offsetY);
    if (next === this.#camera) return;
    this.#camera = next;
    this.#invalidate();
  }

  setView(center: { lon: number; lat: number }, zoom: number): void {
    if (this.#timelapse) return;
    this.#camera = createCamera(center, zoom);
    this.#invalidate();
  }

  /** Centre and zoom the camera so a geographic box fills the view. */
  fitBounds(bounds: { west: number; south: number; east: number; north: number }, maxZoom = MAX_ZOOM): void {
    if (this.#timelapse) return;
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
    const timelapse = this.#timelapse;
    const scene = timelapse ? timelapse.frames[timelapse.index] : this.#scene;
    const empty = (status: PixelInspection['status']): PixelInspection => ({
      lon: point.lon, lat: point.lat, status, date: scene?.datetime ?? null,
      red: null, green: null, blue: null, nir: null, ndvi: null, qualityValid: null,
    });
    if (timelapse) {
      // The frame covers the viewport exactly, so the pixel is a proportion.
      const resident = this.#drawnFrame == null ? undefined : timelapse.tiles.get(this.#drawnFrame);
      if (!resident) return empty('loading');
      const px = Math.max(0, Math.min(resident.width - 1, Math.floor((offsetX / this.#viewport.width) * resident.width)));
      const py = Math.max(0, Math.min(resident.height - 1, Math.floor((offsetY / this.#viewport.height) * resident.height)));
      return readPixel(resident, py * resident.width + px, point);
    }
    if (!scene) return empty('outside');
    const z = tileZoom(this.#camera);
    const world = lonLatToWorldPx(point, z);
    const x = Math.floor(world.px / TILE_SIZE);
    const y = Math.floor(world.py / TILE_SIZE);
    const resident = this.#gpu.get(tileKey(scene, z, x, y));
    if (!resident) return empty(covers(scene, z, x, y) ? 'loading' : 'outside');
    const px = Math.max(0, Math.min(resident.width - 1, Math.floor(world.px - x * TILE_SIZE)));
    const py = Math.max(0, Math.min(resident.height - 1, Math.floor(world.py - y * TILE_SIZE)));
    return readPixel(resident, py * resident.width + px, point);
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
    const timelapse = this.#timelapse;
    if (timelapse) {
      this.#renderTimelapse(renderer, timelapse);
      return;
    }
    if (!this.#dirty && this.#pending.size === 0) return;
    this.#dirty = false;

    if (scene) {
      const visible = visibleTiles(this.#camera, this.#viewport);
      const wanted = new Set<string>();
      // Coarse preview first. One or two overview-level tiles cover the whole
      // view, so something is on screen long before the ~20 detail tiles are.
      // They are requested before any detail tile, which puts them at the
      // front of the client's queue and warms the server's dataset handles.
      const preview = previewTiles(scene, visible.map((item) => item.tile));
      for (const [distance, tile] of preview.entries()) {
        wanted.add(tileKey(scene, tile.z, tile.x, tile.y));
        this.#ensure(tile.z, tile.x, tile.y, scene, false, requestScore(0, distance));
      }
      // Until the first image of a scene is resident, detail requests would
      // only compete with the preview for server slots. After that, the
      // preview is just the first entry in each frame's queue.
      const holdDetail = preview.some((tile) => this.#pending.has(tileKey(scene, tile.z, tile.x, tile.y)))
        && !this.#hasResident(scene);
      // Parents outrank exact tiles; within each level the centre goes first.
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
      if (this.#sceneB) {
        for (const item of visible) {
          const parent = parentTile(item.tile.z, item.tile.x, item.tile.y);
          if (parent && covers(this.#sceneB, parent.z, parent.x, parent.y)) {
            wanted.add(tileKey(this.#sceneB, parent.z, parent.x, parent.y));
            this.#ensure(parent.z, parent.x, parent.y, this.#sceneB, true, requestScore(1, 1 - item.priority));
          }
        }
        for (const item of visible) {
          if (covers(this.#sceneB, item.tile.z, item.tile.x, item.tile.y)) {
            wanted.add(tileKey(this.#sceneB, item.tile.z, item.tile.x, item.tile.y));
          }
          this.#ensure(item.tile.z, item.tile.x, item.tile.y, this.#sceneB, true, requestScore(2, 1 - item.priority));
        }
      }
      this.#abortUnwanted(wanted);

      // What the finished view is made of: the preview plus the detail tiles.
      // Parents are stand-ins, not part of the target.
      const needed = preview.map((tile) => tileKey(scene, tile.z, tile.x, tile.y));
      for (const item of visible) {
        if (covers(scene, item.tile.z, item.tile.x, item.tile.y)) needed.push(tileKey(scene, item.tile.z, item.tile.x, item.tile.y));
      }
      this.#needTotal = needed.length;
      // A tile that failed is settled too; counting it as outstanding would
      // leave the bar short of full forever at a scene's edge.
      this.#needDone = needed.filter((key) => this.#gpu.has(key) || this.#failed.has(key)).length;
    } else {
      this.#needTotal = 0;
      this.#needDone = 0;
    }

    const started = performance.now();
    if (renderer.ready) {
      const tiles: DrawTile[] = scene
        ? visibleTiles(this.#camera, this.#viewport).map((item) => {
            const exact = tileKey(scene, item.tile.z, item.tile.x, item.tile.y);
            const fallback = this.#gpu.has(exact) ? null : this.#residentAncestor(scene, item.tile);
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
      // Only fetch B once A is resident: a swipe of two half-loaded dates shows
      // one side, then a hole, then the other side.
      if (!this.#scene || !this.#gpu.has(tileKey(this.#scene, z, x, y))) return;
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
    for (const tile of this.#gpu.values()) this.#renderer?.destroyTile(tile);
    this.#gpu.clear();
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

// ---- timelapse types and helpers -----------------------------------------

export interface MapView {
  camera: CameraState;
  viewport: Viewport;
}

export type FrameStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface FrameVegetationStats {
  meanNdvi: number;
  vegetationPercent: number;
  sampleCount: number;
}

/** Immutable snapshot for React. Replaced, never mutated, on every change. */
export interface TimelapseState {
  active: boolean;
  frames: readonly Scene[];
  status: readonly FrameStatus[];
  /** Per frame: removed from playback, by the user or the cloud rule. */
  excluded: readonly boolean[];
  /** Per frame: fraction of the view that is cloud, shadow or cirrus; null until loaded. */
  viewCloud: readonly (number | null)[];
  /** Per frame: mean vegetation index and cover percentage; null until loaded. */
  viewVegetation: readonly (FrameVegetationStats | null)[];
  /** Per frame: removed by the cloud rule. */
  autoRemoved: readonly boolean[];
  /** Cloud rule threshold (fraction of the view), or null when off. */
  autoCloud: number | null;
  index: number;
  playing: boolean;
  /** Playback is waiting for the next frame to arrive. */
  buffering: boolean;
  fps: number;
  loop: boolean;
  frameSize: { width: number; height: number } | null;
}

export const IDLE_TIMELAPSE: TimelapseState = {
  active: false, frames: [], status: [], excluded: [], viewCloud: [], viewVegetation: [], autoRemoved: [], autoCloud: null, index: 0, playing: false, buffering: false, fps: 4, loop: true, frameSize: null,
};

interface TimelapseSession {
  frames: FrameScene[];
  status: FrameStatus[];
  /** Dates removed from playback, by the user or by the cloud rule. */
  excluded: boolean[];
  /** Fraction of the view under cloud, cloud shadow or cirrus; null until loaded. */
  viewCloud: Array<number | null>;
  /** Vegetation statistics; null until loaded. */
  viewVegetation: Array<FrameVegetationStats | null>;
  /** Removed by the cloud rule rather than by the user. */
  autoRemoved: boolean[];
  /** The user toggled this date: the cloud rule leaves it alone from then on. */
  manual: boolean[];
  /** The user has played, scrubbed or stepped; from then on the position is theirs. */
  userSeeked: boolean;
  plan: FramePlan;
  /** GPU resources per frame index, bounded independently from ordinary tiles. */
  tiles: Map<number, RenderTile>;
  loading: Set<number>;
  controllers: Map<number, AbortController>;
  index: number;
  direction: 1 | -1;
  playing: boolean;
  fps: number;
  loop: boolean;
  buffering: boolean;
  lastStep: number;
}

/**
 * Frames fetched at once after the first. Two, not six: on a
 * bandwidth-limited link more parallel frames only makes each one later,
 * and playback needs them in order.
 */
const FRAME_CONCURRENCY = 2;
/** Four nearby frames plus two recently viewed frames for smooth back-scrubbing. */
const MAX_RESIDENT_FRAMES = 6;

/**
 * Default cloud rule: drop frames with more than 30% of the view under cloud.
 * Loose enough to keep a few scattered clouds, strict enough to drop the
 * overcast and hazy days that make a timelapse flicker.
 */
const DEFAULT_AUTO_CLOUD = 0.3;

/**
 * Fraction of the frame's covered pixels that are cloud, cloud shadow or
 * cirrus, from its `clear` mask. Null when the frame has none (quality
 * masking off) or covers nothing.
 */
function viewCloudFraction(tile: NumericTile): number | null {
  const clear = tile.masks['clear'];
  const covered = tile.masks['coverage:red'];
  if (!clear || !covered) return null;
  let total = 0;
  let cloudy = 0;
  for (let i = 0; i < covered.length; i += 1) {
    if (covered[i] !== 1) continue;
    total += 1;
    if (clear[i] !== 1) cloudy += 1;
  }
  return total > 0 ? cloudy / total : null;
}

/**
 * Vegetation metrics over the clear, covered pixels in this frame:
 * mean NDVI and the percentage of area with living vegetation (NDVI >= 0.25).
 */
function viewVegetationStats(tile: NumericTile): FrameVegetationStats | null {
  const red = tile.bands['red'];
  const nir = tile.bands['nir'];
  const clear = tile.masks['clear'];
  const covered = tile.masks['coverage:red'];
  if (!red || !nir || !clear || !covered) return null;
  let validCount = 0;
  let sumNdvi = 0;
  let vegCount = 0;
  const len = covered.length;
  for (let i = 0; i < len; i += 1) {
    if (covered[i] !== 1) continue;
    if (clear[i] !== 1) continue;
    const r = red[i];
    const n = nir[i];
    if (!Number.isFinite(r) || !Number.isFinite(n)) continue;
    const denom = n + r;
    if (Math.abs(denom) <= 1e-3) continue;
    const ndvi = (n - r) / denom;
    if (!Number.isFinite(ndvi)) continue;
    validCount += 1;
    sumNdvi += ndvi;
    if (ndvi >= 0.25) vegCount += 1;
  }
  if (validCount === 0) return null;
  return {
    meanNdvi: sumNdvi / validCount,
    vegetationPercent: (vegCount / validCount) * 100,
    sampleCount: validCount,
  };
}

/** Nearest loaded frame still in the timeline, looking forward first. */
function nearestKept(timelapse: TimelapseSession, index: number): number | null {
  for (let d = 1; d < timelapse.frames.length; d += 1) {
    for (const i of [index + d, index - d]) {
      if (i >= 0 && i < timelapse.frames.length && timelapse.status[i] === 'ready' && !timelapse.excluded[i]) return i;
    }
  }
  return null;
}

function frameKey(index: number): string {
  return `frame:${index}`;
}

function frameIndex(key: string): number {
  return Number(key.slice('frame:'.length));
}

/** The requested frame if loaded, else the nearest loaded one before it, else after. */
function nearestReady(status: readonly FrameStatus[], index: number): number | null {
  for (let i = index; i >= 0; i -= 1) if (status[i] === 'ready') return i;
  for (let i = index + 1; i < status.length; i += 1) if (status[i] === 'ready') return i;
  return null;
}

/** Values and NDVI at one sample of a resident tile or frame. */
function readPixel(resident: RenderTile, index: number, point: { lon: number; lat: number }): PixelInspection {
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
