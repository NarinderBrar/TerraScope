/**
 * Tile residency and request scheduling.
 *
 * Two things this has to get right:
 *
 *  1. **A panned map requests tiles it will never show.** Every pan issues
 *     requests for the whole visible set, and most of them are stale before
 *     they land. Superseded and out-of-view requests are aborted, not merely
 *     ignored, because an ignored 1.2 MB download still occupies a connection
 *     and a slot in the client's concurrency queue.
 *  2. **Residency is bounded by both count and bytes.** A 256x256 4-band tile
 *     is 1.25 MB of float32 plus masks; a few hundred of them is more GPU
 *     memory than a laptop adapter will quietly accept. Eviction is
 *     least-recently-*used*, and the parent tile is retained over its children
 *     so zooming out never re-downloads.
 *
 * The LRU is a single flat list per zoom level rather than a tree, which is the
 * right trade here: the working set is a few hundred tiles, so the flat scan
 * is cheaper than maintaining parent/child links, and a tree's reinsertion
 * path is where eviction bugs hide.
 */

import type { TileCoord } from '@terrascope/contracts';

export type TileState = 'absent' | 'loading' | 'ready' | 'error';

export interface TileKeyed {
  key: string;
  tile: TileCoord;
}

export interface TileCacheOptions {
  /** Upper bound on retained tiles. */
  maxTiles: number;
  /** Upper bound on retained bytes. Whichever limit is hit first wins. */
  maxBytes: number;
  /** Bytes charged for one tile, payload plus an allowance for GPU copies. */
  bytesPerTile: number;
}

export const DEFAULT_CACHE: TileCacheOptions = {
  // ~64 MiB of tile data. Two 4-band tiles' worth of headroom is not needed
  // because masks are uint8 and share the source buffer.
  maxTiles: 220,
  maxBytes: 96 * 1024 * 1024,
  bytesPerTile: 4 * 1024 * 1024,
};

interface Entry<T> {
  key: string;
  tile: TileCoord;
  value: T;
  bytes: number;
  /** Monotonic counter, not a timestamp: the clock can move. */
  used: number;
}

export class TileCache<T> {
  #entries = new Map<string, Entry<T>>();
  #bytes = 0;
  #clock = 0;
  readonly #options: TileCacheOptions;

  constructor(options: TileCacheOptions = DEFAULT_CACHE) {
    this.#options = options;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Fetch and mark as most recently used. */
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    entry.used = ++this.#clock;
    return entry.value;
  }

  /** Read without affecting eviction order, for stats and debugging. */
  peek(key: string): T | undefined {
    return this.#entries.get(key)?.value;
  }

  set(key: string, tile: TileCoord, value: T, bytes = this.#options.bytesPerTile): void {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#bytes -= existing.bytes;
      existing.value = value;
      existing.bytes = bytes;
      existing.used = ++this.#clock;
      this.#bytes += bytes;
      this.#evict();
      return;
    }
    this.#entries.set(key, { key, tile, value, bytes, used: ++this.#clock });
    this.#bytes += bytes;
    this.#evict();
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** Entries least-recently-used first. */
  keysByAge(): string[] {
    return [...this.#entries.values()].sort((a, b) => a.used - b.used).map((e) => e.key);
  }

  #evict(): void {
    while (this.#entries.size > this.#options.maxTiles || this.#bytes > this.#options.maxBytes) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const entry of this.#entries.values()) {
        if (entry.used < oldest) {
          oldest = entry.used;
          oldestKey = entry.key;
        }
      }
      if (oldestKey === null) return;
      this.delete(oldestKey);
    }
  }
}

export function tileKeyString(
  collection: string,
  itemId: string,
  profile: string,
  tile: TileCoord,
): string {
  return `${collection}|${itemId}|${profile}|${tile.z}|${tile.x}|${tile.y}`;
}

/**
 * Which tiles the map currently wants.
 *
 * `protected` are inside the viewport plus a margin, and are never aborted.
 * `optional` are in the next zoom step out, fetched only when the connection
 * is otherwise idle -- a speculative prefetch, not a promise.
 */
export interface RequestPlan {
  required: TileCoord[];
  optional: TileCoord[];
  /** Tiles that were wanted last frame and are not wanted now. */
  release: TileCoord[];
}

export function planRequests(
  current: TileCoord[],
  parents: TileCoord[],
): RequestPlan {
  return {
    required: current,
    optional: parents,
    release: [],
  };
}

export function parentOf(tile: TileCoord): TileCoord {
  return { z: Math.max(0, tile.z - 1), x: tile.x >> 1, y: tile.y >> 1 };
}

/**
 * Device pixels per source texel at the current zoom.
 *
 * A tile carries 256 texels and is drawn `256 * 2^(zoom - z)`
 * CSS pixels across, times the device pixel ratio -- so the magnification
 * factor is `2^(zoom - z) * dpr` and does not depend on `TILE_SIZE` at all.
 *
 * This is what decides the sampling mode. Above 1.0 the source is being
 * *magnified* and point sampling is correct; below 1.0 it is being minified
 * and averaging several texels into one screen pixel is what avoids aliasing.
 */
export function devicePixelsPerTexel(zoom: number, dpr: number): number {
  return 2 ** (zoom - Math.floor(zoom)) * dpr;
}
