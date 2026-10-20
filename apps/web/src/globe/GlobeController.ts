import type { NumericTile, Scene } from '@terrascope/contracts';
import type { RenderSettings } from '../gpu/RasterRenderer';
import type { GpuContext } from '../gpu/GpuContext';
import { RasterClient } from '../data/RasterClient';
import type { GlobeCamera, GlobeViewport } from './GlobeMath';
import { DEFAULT_GLOBE_CAMERA } from './GlobeMath';
import { GlobeRenderer, type GlobeGpuTile, type GlobeDrawItem } from './GlobeRenderer';
import { parentOf, visibleGlobeTiles, type GlobeTile } from './GlobeTiles';

const MIN_ZOOM = 8;
const MAX_ZOOM = 14;
const MAX_RESIDENT_BYTES = 96 * 1024 * 1024;
const MAX_TILE_REQUESTS = 96;
const RETRY_MS = 12_000;

type TilePair = { a: NumericTile; b?: NumericTile };

/** Stateful camera, request scheduler, bounded cache, and WebGPU frame loop. */
export class GlobeController {
  readonly client: RasterClient;

  #canvas: HTMLCanvasElement;
  #renderer: GlobeRenderer | null = null;
  #camera: GlobeCamera = { ...DEFAULT_GLOBE_CAMERA };
  #settings: RenderSettings | null = null;
  #sceneA: Scene | null = null;
  #sceneB: Scene | null = null;
  #qualityMask = true;
  #tiles = new Map<string, GlobeGpuTile>();
  #pending = new Map<string, AbortController>();
  #failures = new Map<string, number>();
  #frame = 0;
  #dirty = true;
  #disposed = false;
  #active = false;
  #viewport: GlobeViewport = { width: 0, height: 0 };
  #lastWanted = new Set<string>();

  constructor(canvas: HTMLCanvasElement, client: RasterClient) {
    this.#canvas = canvas;
    this.client = client;
  }

  async init(context: GpuContext): Promise<void> {
    this.#renderer = await GlobeRenderer.create(this.#canvas, context);
    this.resize();
    this.#schedule();
  }

  setActive(active: boolean): void {
    this.#active = active;
    if (active) this.#invalidate();
    else if (this.#frame) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    for (const request of this.#pending.values()) request.abort();
    this.#pending.clear();
    for (const tile of this.#tiles.values()) this.#renderer?.destroyTile(tile);
    this.#tiles.clear();
    this.#renderer?.destroy();
    this.#renderer = null;
  }

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    this.#viewport = { width: rect.width, height: rect.height };
    this.#renderer?.resize();
    this.#invalidate();
  }

  setInputs(sceneA: Scene | null, sceneB: Scene | null, settings: RenderSettings): void {
    const sceneChanged = this.#sceneA?.id !== sceneA?.id
      || this.#sceneA?.collection !== sceneA?.collection
      || this.#sceneB?.id !== sceneB?.id
      || this.#sceneB?.collection !== sceneB?.collection;
    const qualityChanged = this.#qualityMask !== settings.qualityMask;
    this.#sceneA = sceneA;
    this.#sceneB = sceneB;
    this.#settings = settings;
    this.#qualityMask = settings.qualityMask;
    if (sceneChanged || qualityChanged) this.#clearTiles();
    this.#invalidate();
  }

  setInitialCenter(longitude: number, latitude: number): void {
    this.#camera = { ...this.#camera, longitude, latitude };
    this.#invalidate();
  }

  orbit(dx: number, dy: number): void {
    const width = Math.max(1, this.#viewport.width);
    this.#camera = {
      ...this.#camera,
      longitude: wrapLongitude(this.#camera.longitude - dx / width * 320),
      latitude: Math.max(-85, Math.min(85, this.#camera.latitude + dy / width * 320)),
    };
    this.#invalidate();
  }

  zoom(deltaY: number): void {
    const distance = Math.max(1.035, Math.min(8, this.#camera.distance * Math.exp(deltaY * 0.001)));
    if (distance === this.#camera.distance) return;
    this.#camera = { ...this.#camera, distance };
    this.#invalidate();
  }

  reset(): void {
    this.#camera = { ...DEFAULT_GLOBE_CAMERA };
    this.#invalidate();
  }

  #invalidate(): void {
    this.#dirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#disposed || !this.#active || this.#frame || !this.#renderer) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#render();
    });
  }

  #render(): void {
    const renderer = this.#renderer;
    const settings = this.#settings;
    if (!renderer || !settings || this.#disposed || !this.#active) return;
    renderer.resize();
    const scene = this.#sceneA;
    let visible: GlobeTile[] = [];
    if (scene && this.#viewport.width > 0 && this.#viewport.height > 0) {
      visible = visibleGlobeTiles(scene, this.#camera, this.#viewport, MIN_ZOOM, MAX_ZOOM)
        .slice(0, MAX_TILE_REQUESTS);
      this.#requestVisible(visible, scene);
    }

    const items = this.#drawItems(visible);
    if (this.#dirty || this.#pending.size > 0) {
      renderer.render(this.#camera, this.#viewport, settings, items, (key) => this.#tiles.get(key));
      this.#dirty = false;
    }
    if (this.#pending.size > 0) this.#schedule();
  }

  #requestVisible(visible: readonly GlobeTile[], scene: Scene): void {
    const wanted = new Set<string>();
    for (const tile of visible) {
      const ancestors = this.#ancestors(tile);
      for (const ancestor of ancestors) {
        const key = this.#resourceKey(ancestor);
        wanted.add(key);
        if (!this.#tiles.has(key)) this.#requestTile(key, ancestor, scene);
      }
      const key = this.#resourceKey(tile);
      wanted.add(key);
      if (!this.#tiles.has(key)) this.#requestTile(key, tile, scene);
    }
    this.#lastWanted = wanted;
    for (const [key, controller] of this.#pending) {
      if (!wanted.has(key)) {
        controller.abort();
        this.#pending.delete(key);
      }
    }
  }

  #drawItems(visible: readonly GlobeTile[]): GlobeDrawItem[] {
    const output = new Map<string, GlobeDrawItem>();
    // Coarse parents first so their geometry remains as a visual fallback
    // while a child is still downloading. Exact children render over it.
    for (const tile of visible) {
      for (const ancestor of this.#ancestors(tile)) {
        const key = this.#resourceKey(ancestor);
        if (this.#tiles.has(key)) output.set(key, { key, tile: ancestor });
      }
      const key = this.#resourceKey(tile);
      if (this.#tiles.has(key)) output.set(key, { key, tile });
    }
    return [...output.values()];
  }

  #ancestors(tile: GlobeTile): GlobeTile[] {
    const values: GlobeTile[] = [];
    let parent = parentOf(tile);
    while (parent && parent.z >= MIN_ZOOM) {
      values.unshift({ ...parent, key: this.#resourceKey(parent) });
      parent = parentOf(parent);
    }
    return values;
  }

  #resourceKey(tile: GlobeTile): string {
    return `${this.#sceneA?.collection}/${this.#sceneA?.id}/${this.#sceneB?.collection ?? 'single'}/${this.#sceneB?.id ?? 'single'}/${this.#qualityMask ? 1 : 0}/${tile.z}/${tile.x}/${tile.y}`;
  }

  #requestTile(key: string, tile: GlobeTile, scene: Scene): void {
    if (this.#pending.has(key) || this.#tiles.has(key)) return;
    const retry = this.#failures.get(key);
    if (retry !== undefined && performance.now() < retry) return;
    this.#failures.delete(key);
    const controller = new AbortController();
    this.#pending.set(key, controller);
    const descriptor = {
      collection: scene.collection,
      itemId: scene.id,
      profile: 'rgbn',
      qualityMask: this.#qualityMask,
      z: tile.z,
      x: tile.x,
      y: tile.y,
    } as const;
    const second = this.#sceneB;
    const request: Promise<TilePair> = second
      ? Promise.all([
          this.client.tile(descriptor, { signal: controller.signal }),
          this.client.tile({ ...descriptor, collection: second.collection, itemId: second.id }, { signal: controller.signal }),
        ]).then(([a, b]) => ({ a, b }))
      : this.client.tile(descriptor, { signal: controller.signal }).then((a) => ({ a }));
    request.then((pair) => {
      if (controller.signal.aborted || this.#disposed || !this.#lastWanted.has(key) || !this.#renderer) return;
      const resource = this.#renderer.uploadTile(key, tile, pair.a, pair.b);
      this.#tiles.set(key, resource);
      this.#evict();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.#failures.set(key, performance.now() + RETRY_MS);
      if (error instanceof Error) console.warn(`[TerraScope] globe tile ${tile.z}/${tile.x}/${tile.y}: ${error.message}`);
    }).finally(() => {
      this.#pending.delete(key);
      this.#invalidate();
    });
  }

  #evict(): void {
    let bytes = 0;
    for (const tile of this.#tiles.values()) bytes += tile.bytes;
    if (bytes <= MAX_RESIDENT_BYTES) return;
    for (const [key, tile] of this.#tiles) {
      if (this.#lastWanted.has(key)) continue;
      this.#renderer?.destroyTile(tile);
      this.#tiles.delete(key);
      bytes -= tile.bytes;
      if (bytes <= MAX_RESIDENT_BYTES) break;
    }
  }

  #clearTiles(): void {
    for (const request of this.#pending.values()) request.abort();
    this.#pending.clear();
    for (const tile of this.#tiles.values()) this.#renderer?.destroyTile(tile);
    this.#tiles.clear();
    this.#failures.clear();
    this.#lastWanted.clear();
  }
}

function wrapLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}
