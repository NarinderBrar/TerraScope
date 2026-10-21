/**
 * The explore-mode basemap: Esri World Imagery with Esri reference labels.
 *
 * DOM images rather than GPU textures, on purpose. These are finished JPEG and
 * PNG pictures, not measurements: there is nothing for the numeric pipeline to
 * do with them, and as DOM they work even where WebGPU does not. The WebGPU
 * canvas sits above and only becomes visible for the timelapse.
 *
 * Loading order is low resolution first, then detail: a coarse level three
 * up (a handful of small tiles that arrive almost at once) is requested with
 * the sharp level at the view's zoom, and drawn beneath it.
 *
 * Nothing goes blank while zooming. Every other level near the view is drawn
 * underneath too, but only from tiles the browser has already loaded -- free
 * to show, and never a new request. So zooming in keeps the previous (now
 * blurrier) tiles until the sharp ones land, and zooming out keeps the finer
 * ones until their parents do. Each level is its own long-lived layer, so
 * crossing a zoom boundary does not remount images that are already on screen.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { lonLatToWorldPx, TILE_SIZE } from '@terrascope/contracts';
import type { MapScene, MapView } from '../app/MapScene';
import { WORLD_IMAGERY_ATTRIBUTION, WORLD_IMAGERY_MAX_ZOOM, WORLD_LABELS_ATTRIBUTION,
  worldImageryUrl, worldLabelsUrl } from './worldImagery';

const COARSE_DROP = 3;
/** Loaded levels kept under the view as stand-ins, coarser and finer. */
const FALLBACK_COARSER = 6;
const FALLBACK_FINER = 2;

/** Tile URLs the browser has finished loading, so they display instantly from cache. */
const loaded = new Set<string>();

export const BASEMAP_ATTRIBUTION =
  `${WORLD_IMAGERY_ATTRIBUTION} · ${WORLD_LABELS_ATTRIBUTION}`;

export function Basemap({ scene }: { scene: MapScene }): React.JSX.Element {
  const view = useMapView(scene);
  const z = Math.min(WORLD_IMAGERY_MAX_ZOOM, Math.max(0, Math.floor(view.camera.zoom)));
  const coarse = Math.max(0, z - COARSE_DROP);
  // Keep a broad overview beneath deep views even where regional detail is absent.
  const overview = Math.min(8, coarse);
  const labels = z;
  // Bottom to top: coarsest stand-ins, finer stand-ins, then the view's zoom.
  const levels: number[] = [overview];
  for (let d = FALLBACK_COARSER; d >= 1; d -= 1) levels.push(z - d);
  levels.sort((a, b) => a - b);
  for (let d = FALLBACK_FINER; d >= 1; d -= 1) levels.push(z + d);
  levels.push(z);
  return (
    <div className="basemap" aria-hidden="true">
      {[...new Set(levels)]
        .filter((level) => level >= 0 && level <= WORLD_IMAGERY_MAX_ZOOM)
        .map((level) => (
          <TileLayer
            key={`imagery-${level}`}
            view={view}
            z={level}
            url={worldImageryUrl}
            className={level === z ? 'sharp' : 'fallback'}
            loadedOnly={level !== z && level !== coarse && level !== overview}
          />
        ))}
      {/* Labels are the view's zoom only: two label levels at once would draw
          every name twice at different sizes. */}
      <TileLayer key={`labels-${labels}`} view={view} z={labels} url={worldLabelsUrl} className="labels" loadedOnly={false} />
    </div>
  );
}

function TileLayer({
  view,
  z,
  url,
  className,
  loadedOnly,
}: {
  view: MapView;
  z: number;
  url: (z: number, x: number, y: number) => string;
  className: string;
  /** Stand-in level: draw only what is already loaded, request nothing. */
  loadedOnly: boolean;
}): React.JSX.Element {
  const tiles = tilesAt(view, z)
    .map((tile) => ({ ...tile, src: url(z, tile.x, tile.y) }))
    .filter((tile) => !loadedOnly || loaded.has(tile.src));
  return (
    <div className={`basemap-layer ${className}`}>
      {tiles.map((tile) => (
        <img
          key={`${tile.x}/${tile.y}/${tile.wrap}`}
          src={tile.src}
          alt=""
          draggable={false}
          decoding="async"
          style={{
            transform: `translate(${tile.left}px, ${tile.top}px)`,
            width: tile.size,
            height: tile.size,
          }}
          onLoad={() => loaded.add(tile.src)}
          // A missing tile (ocean at high zoom, a hiccup) should show the
          // coarse layer beneath, not a broken-image icon.
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      ))}
    </div>
  );
}

interface PlacedTile {
  x: number;
  y: number;
  /** Which copy of the world, for keys: the map repeats horizontally. */
  wrap: number;
  left: number;
  top: number;
  size: number;
}

/**
 * Tiles of zoom `z` covering the viewport, positioned in CSS pixels.
 *
 * The same projection as `visibleTiles`, but for an arbitrary zoom, so the
 * coarse layer lines up exactly with the sharp one and with the GPU frames.
 * Sizes are rounded up by a pixel to hide hairline seams between images.
 */
function tilesAt(view: MapView, z: number): PlacedTile[] {
  const { camera, viewport } = view;
  if (viewport.width <= 0 || viewport.height <= 0) return [];
  const centre = lonLatToWorldPx(camera.center, z);
  const scale = 2 ** (camera.zoom - z);
  const size = TILE_SIZE * scale;
  const n = 2 ** z;
  const halfW = viewport.width / 2;
  const halfH = viewport.height / 2;
  const minTx = Math.floor((centre.px - halfW / scale) / TILE_SIZE);
  const maxTx = Math.floor((centre.px + halfW / scale) / TILE_SIZE);
  const minTy = Math.max(0, Math.floor((centre.py - halfH / scale) / TILE_SIZE));
  const maxTy = Math.min(n - 1, Math.floor((centre.py + halfH / scale) / TILE_SIZE));
  const out: PlacedTile[] = [];
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      out.push({
        x: ((tx % n) + n) % n,
        y: ty,
        wrap: Math.floor(tx / n),
        left: Math.floor((tx * TILE_SIZE - centre.px) * scale + halfW),
        top: Math.floor((ty * TILE_SIZE - centre.py) * scale + halfH),
        size: Math.ceil(size) + 1,
      });
    }
  }
  return out;
}

function useMapView(scene: MapScene): MapView {
  const subscribe = useCallback((onChange: () => void) => scene.subscribe(onChange), [scene]);
  return useSyncExternalStore(subscribe, () => scene.view, () => scene.view);
}
