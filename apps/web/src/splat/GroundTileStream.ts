import { groundTileKey, parentGroundTile, type GroundTile } from './groundTilePlan';

/** Bounded, cancellable imagery residency, independent of the rendering engine. */
export class GroundTileStream<T> {
  private tiles: GroundTile[] = [];
  private wanted = new Map<string, GroundTile>();
  private loaded = new Map<string, { tile: GroundTile; value: T; used: number }>();
  private active = new Map<string, AbortController>();
  private failed = new Map<string, number>();
  private clock = 0;
  private disposed = false;
  constructor(
    private load: (tile: GroundTile, signal: AbortSignal) => Promise<T | null>,
    private release: (value: T) => void,
    private changed: () => void,
    private maxResident = 256,
    private concurrency = 6,
  ) {}
  get pending(): boolean { return this.active.size > 0; }
  setTiles(tiles: GroundTile[]): void {
    if (this.disposed) return;
    this.tiles = tiles;
    this.wanted = new Map();
    // Keep a tiny world overview resident so a zoom change has coverage immediately.
    for (const tile of tiles) {
      const overview = parentGroundTile(tile, tile.z);
      this.wanted.set(groundTileKey(overview), overview);
    }
    // Fetch broad coverage first. Fine tiles replace its exact geographic subregions.
    for (const tile of tiles) {
      const parent = parentGroundTile(tile, 4);
      this.wanted.set(groundTileKey(parent), parent);
    }
    for (const tile of tiles) this.wanted.set(groundTileKey(tile), tile);
    for (const [key, controller] of this.active) if (!this.wanted.has(key)) controller.abort();
    this.trim();
    this.pump();
  }
  find(tile: GroundTile): { tile: GroundTile; value: T } | undefined {
    for (let ancestor = tile; ; ancestor = parentGroundTile(ancestor)) {
      const loaded = this.loaded.get(groundTileKey(ancestor));
      if (loaded) { loaded.used = ++this.clock; return loaded; }
      if (ancestor.z === 0) return;
    }
  }
  retry(): void { this.failed.clear(); this.pump(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    for (const resource of this.loaded.values()) this.release(resource.value);
    this.loaded.clear();
    this.failed.clear();
  }
  private trim(): void {
    const pinned = new Set(this.tiles.map((tile) => this.find(tile)).filter((item) => !!item).map((item) => groundTileKey(item.tile)));
    for (const [key, tile] of this.wanted) if (tile.z === 0) pinned.add(key);
    const unused = [...this.loaded.entries()].filter(([key]) => !pinned.has(key)).sort((a, b) => a[1].used - b[1].used);
    for (const [key, resource] of unused) {
      if (this.loaded.size <= this.maxResident) break;
      this.loaded.delete(key);
      this.release(resource.value);
    }
    // Failure metadata is bounded as well, even after travelling long distances.
    for (const key of this.failed.keys()) if (!this.wanted.has(key)) this.failed.delete(key);
  }
  private pump(): void {
    if (this.disposed) return;
    for (const [key, tile] of this.wanted) {
      if (this.active.size >= this.concurrency) break;
      if (this.loaded.has(key) || this.active.has(key) || (this.failed.get(key) ?? 0) > Date.now()) continue;
      const controller = new AbortController();
      this.active.set(key, controller);
      void this.load(tile, controller.signal).then((value) => {
        if (this.disposed || controller.signal.aborted) { if (value) this.release(value); return; }
        if (value) this.loaded.set(key, { tile, value, used: ++this.clock });
        else this.failed.set(key, Date.now() + 30000);
      }).catch(() => {
        if (!controller.signal.aborted && !this.disposed) this.failed.set(key, Date.now() + 30000);
      }).finally(() => {
        this.active.delete(key);
        if (this.disposed) return;
        // Rebind meshes before evicting textures used in the preceding frame.
        this.changed();
        this.trim();
        this.pump();
      });
    }
  }
}
