/** Minimal geometry-only MVT renderer for a quiet, dark analysis basemap.
 * Format: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 * Source: https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer
 * Vector geometry is styled locally then uploaded to the existing registered meshes.
 */
export const DARK_VECTOR_ATTRIBUTION = 'Map data © Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors, and the GIS User Community';
export type BasemapStyle = 'satellite' | 'dark-vector';
const SOURCE = 'https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer';
export const darkVectorUrl = (z: number, x: number, y: number): string => `${SOURCE}/tile/${z}/${y}/${x}.pbf`;

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  uint(): number {
    let result = 0, multiplier = 1;
    for (let i = 0; i < 8; i++) {
      if (this.offset >= this.bytes.length) throw new Error('Truncated vector tile');
      const byte = this.bytes[this.offset++];
      result += (byte & 127) * multiplier;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(result)) throw new Error('Invalid vector integer');
        return result;
      }
      multiplier *= 128;
    }
    throw new Error('Invalid vector integer');
  }
  block(): Uint8Array {
    const size = this.uint(), start = this.offset;
    if (size > this.bytes.length - start) throw new Error('Truncated vector block');
    this.offset += size;
    return this.bytes.subarray(start, this.offset);
  }
  skip(wire: number): void {
    if (wire === 2) { this.block(); return; }
    if (wire === 0) {
      for (let i = 0; i < 10 && this.offset < this.bytes.length; i++) {
        if (!(this.bytes[this.offset++] & 128)) return;
      }
      throw new Error('Invalid vector varint');
    }
    if (wire !== 1 && wire !== 5) throw new Error('Invalid vector field');
    this.offset += wire === 1 ? 8 : 4;
    if (this.offset > this.bytes.length) throw new Error('Truncated vector field');
  }
}
export interface VectorFeature { type: number; paths: [number, number][][] }
export interface VectorLayer { name: string; extent: number; features: VectorFeature[] }
function geometry(bytes: Uint8Array): [number, number][][] {
  const reader = new Reader(bytes), paths: [number, number][][] = [];
  let x = 0, y = 0, path: [number, number][] | undefined, vertices = 0;
  while (reader.offset < bytes.length) {
    const command = reader.uint(), id = command % 8, count = Math.floor(command / 8);
    if (!count || count > 1000000 || ![1, 2, 7].includes(id)) throw new Error('Invalid vector geometry');
    if (id === 7) {
      if (count !== 1 || !path?.length) throw new Error('Invalid vector ring');
      path.push([...path[0]]); continue;
    }
    for (let i = 0; i < count; i++) {
      if (++vertices > 1000000) throw new Error('Vector geometry too large');
      const dx = reader.uint(), dy = reader.uint();
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
      y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      if (id === 1) { path = []; paths.push(path); }
      if (!path) throw new Error('Vector line without origin');
      path.push([x, y]);
    }
  }
  return paths;
}
export function decodeVectorTile(bytes: Uint8Array): VectorLayer[] {
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Vector tile too large');
  const tile = new Reader(bytes), layers: VectorLayer[] = [];
  let featureCount = 0;
  while (tile.offset < bytes.length) {
    const tag = tile.uint();
    if (tag !== 26) { tile.skip(tag % 8); continue; }
    if (layers.length >= 256) throw new Error('Too many vector layers');
    const reader = new Reader(tile.block()), features: VectorFeature[] = [];
    let name = '', extent = 4096;
    while (reader.offset < reader.bytes.length) {
      const field = reader.uint();
      if (field === 10) name = new TextDecoder().decode(reader.block());
      else if (field === 40) extent = reader.uint();
      else if (field === 18) {
        if (++featureCount > 200000) throw new Error('Too many vector features');
        const feature = new Reader(reader.block());
        let type = 0, commands = new Uint8Array(0);
        while (feature.offset < feature.bytes.length) {
          const f = feature.uint();
          if (f === 24) type = feature.uint();
          else if (f === 34) commands = new Uint8Array(feature.block());
          else feature.skip(f % 8);
        }
        if (type === 2 || type === 3) features.push({ type, paths: geometry(commands) });
      } else reader.skip(field % 8);
    }
    if (!extent || extent > 65536) throw new Error('Invalid vector extent');
    layers.push({ name, extent, features });
  }
  return layers;
}

export function vectorPaint(name: string): { fill?: string; stroke?: string; width: number; order: number } | null {
  if (/label|hillshade|contour/i.test(name)) return null;
  if (/water|marine|ocean|lake|river/i.test(name)) return { fill: '#081b28', stroke: '#173246', width: 1, order: 2 };
  if (/park|vegetation|forest|landmark|landuse/i.test(name)) return { fill: '#10201e', width: 1, order: 1 };
  if (/building/i.test(name)) return { fill: '#172532', stroke: '#2b3c4a', width: .7, order: 3 };
  if (/road|street|transport/i.test(name)) return { stroke: '#536275', width: 1.6, order: 5 };
  if (/rail|boundary|admin/i.test(name)) return { stroke: '#2c3a49', width: .8, order: 4 };
  if (/land/i.test(name)) return { fill: '#101923', width: 1, order: 0 };
  return null;
}
export function renderVectorTile(layers: VectorLayer[], factor = 1, column = 0, row = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Vector map rendering is unavailable');
  context.fillStyle = '#0b121b'; context.fillRect(0, 0, 512, 512);
  const ordered = layers.map(layer => ({ layer, paint: vectorPaint(layer.name) }))
    .filter(item => item.paint !== null).sort((a, b) => a.paint!.order - b.paint!.order);
  for (const { layer, paint } of ordered) {
    const scale = 512 * factor / layer.extent;
    context.save();
    context.translate(-column * 512, -row * 512); context.scale(scale, scale);
    context.lineWidth = paint!.width * 2 / scale; context.lineCap = 'round'; context.lineJoin = 'round';
    for (const feature of layer.features) {
      context.beginPath();
      for (const path of feature.paths) {
        path.forEach(([x, y], i) => i === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
        if (feature.type === 3) context.closePath();
      }
      if (feature.type === 3 && paint!.fill) { context.fillStyle = paint!.fill; context.fill('evenodd'); }
      if (paint!.stroke) { context.strokeStyle = paint!.stroke; context.stroke(); }
    }
    context.restore();
  }
  return canvas;
}
export async function fetchDarkVectorTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
  // Bound source requests to level 16; overzoom geometry rather than scaling a screenshot.
  const top = Math.min(16, z);
  for (let level = top; level >= Math.max(0, top - 3); level--) {
    signal.throwIfAborted();
    const factor = 2 ** (z - level);
    const response = await fetch(darkVectorUrl(level, Math.floor(x / factor), Math.floor(y / factor)), { signal });
    if (!response.ok) continue;
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    return renderVectorTile(decodeVectorTile(bytes), factor, x % factor, y % factor);
  }
  return null;
}
