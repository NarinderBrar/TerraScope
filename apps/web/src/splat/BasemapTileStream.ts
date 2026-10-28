import { GroundTileStream } from './GroundTileStream';
import type { GroundTile } from './groundTilePlan';
import type { BasemapStyle } from '../map/darkVectorTiles';

/** Separate bounded residency for each style; a late tile cannot cross styles. */
export class BasemapTileStream<T> {
  private streams: Record<BasemapStyle, GroundTileStream<T>>;
  private style: BasemapStyle = 'satellite';
  constructor(load: (style: BasemapStyle, tile: GroundTile, signal: AbortSignal) => Promise<T | null>, release: (value: T) => void,
    changed: () => void, maxResident = 256, concurrency = 6) {
    const create = (style: BasemapStyle) => new GroundTileStream<T>((tile, signal) => load(style, tile, signal), release,
      () => { if (this.style === style) changed(); }, style === 'dark-vector' ? Math.min(128, maxResident) : maxResident, concurrency);
    this.streams = { satellite: create('satellite'), 'dark-vector': create('dark-vector') };
  }
  get pending(): boolean { return this.streams[this.style].pending; }
  setStyle(style: BasemapStyle): boolean {
    if (style === this.style) return false;
    this.streams[this.style].setTiles([]); this.style = style; return true;
  }
  setTiles(tiles: GroundTile[]): void { this.streams[this.style].setTiles(tiles); }
  find(tile: GroundTile): { tile: GroundTile; value: T } | undefined { return this.streams[this.style].find(tile); }
  retry(): void { this.streams[this.style].retry(); }
  dispose(): void { for (const stream of Object.values(this.streams)) stream.dispose(); }
}
