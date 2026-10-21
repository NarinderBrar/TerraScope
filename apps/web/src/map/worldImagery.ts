/** Shared imagery service for the explorer and the registered 3D ground map. */
const ESRI_SERVICES = 'https://server.arcgisonline.com/ArcGIS/rest/services';
export const WORLD_IMAGERY_MAX_ZOOM = 20;
export const WORLD_IMAGERY_ATTRIBUTION = 'Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community';
export const WORLD_LABELS_ATTRIBUTION = 'Labels © Esri and contributors';

export const worldImageryUrl = (z: number, x: number, y: number): string =>
  `${ESRI_SERVICES}/World_Imagery/MapServer/tile/${z}/${y}/${x}?blankTile=false`;
export const worldLabelsUrl = (z: number, x: number, y: number): string =>
  `${ESRI_SERVICES}/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}?blankTile=false`;

export type ImageryTileCache = Map<string, Promise<Blob | null>>;

/** Recover missing detail from the same imagery's parent tiles, with exact UV cropping. */
export async function fetchWorldImageryTile(
  z: number, x: number, y: number, signal: AbortSignal, cache: ImageryTileCache,
): Promise<{ blob: Blob; left: number; top: number; size: number } | null> {
  for (let level = z; level >= Math.max(0, z - 3); level--) {
    signal.throwIfAborted();
    const factor = 2 ** (z - level);
    const url = worldImageryUrl(level, Math.floor(x / factor), Math.floor(y / factor));
    let pending = cache.get(url);
    if (!pending) {
      pending = fetch(url, { signal }).then((response) =>
        response.ok && response.headers.get('blank-tile') !== 'true' ? response.blob() : null,
      ).catch((error: unknown) => { if (signal.aborted) throw error; return null; });
      cache.set(url, pending);
    }
    const blob = await pending;
    signal.throwIfAborted();
    if (blob) return { blob, left: (x % factor) * 256 / factor, top: (y % factor) * 256 / factor, size: 256 / factor };
  }
  return null;
}
