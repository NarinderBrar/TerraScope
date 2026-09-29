/**
 * Camera and viewport.
 *
 * Camera state is kept in double precision, in geographic coordinates, and
 * only converted to single-precision GPU values *relative to the camera origin*
 * at draw time. Doing the projection in float32 world coordinates is the
 * classic cause of tile jitter at high zoom: at z20 a float32 world pixel is
 * several screen pixels wide.
 */

import {
  MAX_LATITUDE,
  TILE_SIZE,
  groundResolution,
  lonLatToWorldPx,
  worldPxToLonLat,
  type LonLat,
  type TileCoord,
} from '@terrascope/contracts';

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio, clamped to something a laptop GPU can sustain. */
  dpr: number;
}

export interface CameraState {
  center: LonLat;
  /** Fractional zoom. The tile zoom actually used is floor(zoom). */
  zoom: number;
  minZoom: number;
  maxZoom: number;
}

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 19;
export const MIN_LATITUDE = -MAX_LATITUDE;
export const MAX_LATITUDE_CLAMP = MAX_LATITUDE;

export function createCamera(center: LonLat = { lon: -121.3, lat: 38.1 }, zoom = 11): CameraState {
  return { center, zoom, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
}

export function clampCamera(state: CameraState): CameraState {
  return {
    ...state,
    zoom: Math.min(state.maxZoom, Math.max(state.minZoom, state.zoom)),
    center: {
      lon: wrapLongitude(state.center.lon),
      lat: Math.min(MAX_LATITUDE_CLAMP, Math.max(MIN_LATITUDE, state.center.lat)),
    },
  };
}

export function wrapLongitude(lon: number): number {
  let value = ((lon + 180) % 360 + 360) % 360 - 180;
  if (value === -180 && lon > 0) value = 180;
  return value;
}

/** Zoom actually used for tile selection and texture addressing. */
export function tileZoom(state: CameraState): number {
  return Math.min(state.maxZoom, Math.max(0, Math.floor(state.zoom)));
}

export interface ViewportTile {
  tile: TileCoord;
  /** 0 at the screen edge, 1 at the viewport centre. Drives fetch priority. */
  priority: number;
  /** Position in pixels relative to the camera origin, already float32-safe. */
  screenX: number;
  screenY: number;
}

/**
 * Visible tiles, nearest the viewport centre first.
 *
 * The returned coordinates are relative to the camera's world pixel position,
 * which keeps the magnitude small regardless of zoom.
 */
export function visibleTiles(state: CameraState, viewport: Viewport): ViewportTile[] {
  const z = tileZoom(state);
  const camera = lonLatToWorldPx(state.center, z);
  const scale = 2 ** (state.zoom - z);

  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;
  // The half-extent of the visible world rectangle, in world pixels.
  const spanX = halfWidth / scale;
  const spanY = halfHeight / scale;

  const minTx = Math.floor((camera.px - spanX) / TILE_SIZE);
  const maxTx = Math.floor((camera.px + spanX) / TILE_SIZE);
  const minTy = Math.floor((camera.py - spanY) / TILE_SIZE);
  const maxTy = Math.floor((camera.py + spanY) / TILE_SIZE);
  const n = 2 ** z;

  const out: ViewportTile[] = [];
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    // Vertical wrapping is not meaningful; skip rows outside the world.
    if (ty < 0 || ty >= n) continue;
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      // Horizontal wrapping is meaningful: the world repeats.
      const wrappedX = ((tx % n) + n) % n;
      const originX = tx * TILE_SIZE;
      const originY = ty * TILE_SIZE;
      const screenX = (originX - camera.px) * scale + halfWidth;
      const screenY = (originY - camera.py) * scale + halfHeight;

      const dx = screenX + (TILE_SIZE * scale) / 2 - halfWidth;
      const dy = screenY + (TILE_SIZE * scale) / 2 - halfHeight;
      const distance = Math.hypot(dx, dy) / Math.hypot(halfWidth, halfHeight);
      out.push({
        tile: { z, x: wrappedX, y: ty },
        priority: 1 / (1 + distance),
        screenX,
        screenY,
      });
    }
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/** Geographic position under a CSS-pixel offset from the viewport centre. */
export function screenToLonLat(
  state: CameraState,
  viewport: Viewport,
  offsetX: number,
  offsetY: number,
): LonLat {
  const z = tileZoom(state);
  const camera = lonLatToWorldPx(state.center, z);
  const scale = 2 ** (state.zoom - z);
  return worldPxToLonLat(
    camera.px + (offsetX - viewport.width / 2) / scale,
    camera.py + (offsetY - viewport.height / 2) / scale,
    z,
  );
}

/**
 * Zoom about a screen point, keeping that point under the cursor.
 *
 * Derived rather than guessed: the anchor's world-pixel offset from the camera
 * centre is invariant, so the new centre is the anchor's position at the new
 * tile zoom minus that same screen offset. Cross-multiplied rather than
 * dividing twice, which is where the usual version of this picks up drift.
 */
export function zoomAround(
  state: CameraState,
  viewport: Viewport,
  deltaY: number,
  offsetX: number,
  offsetY: number,
): CameraState {
  const zoom = Math.min(state.maxZoom, Math.max(state.minZoom, state.zoom - deltaY * 0.0025));
  if (zoom === state.zoom) return state;

  const anchor = screenToLonLat(state, viewport, offsetX, offsetY);

  // The anchor's offset from the viewport centre, in screen pixels. This is
  // the quantity that must not move.
  const offsetFromCentreX = offsetX - viewport.width / 2;
  const offsetFromCentreY = offsetY - viewport.height / 2;

  const toZ = tileZoom({ ...state, zoom });
  const anchorTo = lonLatToWorldPx(anchor, toZ);

  // `scale` is the factor between a world pixel and a screen pixel at the new
  // zoom. Converting the anchor's screen offset through *that* factor and
  // subtracting from the anchor's world position puts the anchor back under
  // the cursor exactly, at any fractional zoom.
  //
  // The subtlety is that the anchor's world position must be re-projected at
  // `toZ`, not carried over from the old zoom: the world pixel grid changes
  // scale with the tile zoom, and reusing the old position is what makes this
  // drift by whole tiles when crossing a zoom boundary.
  const scale = 2 ** (zoom - toZ);
  const centre = worldPxToLonLat(
    anchorTo.px - offsetFromCentreX / scale,
    anchorTo.py - offsetFromCentreY / scale,
    toZ,
  );
  return clampCamera({ ...state, zoom, center: centre });
}

/** Translate the camera by a screen-pixel delta. */
export function panBy(state: CameraState, dx: number, dy: number): CameraState {
  const z = tileZoom(state);
  const camera = lonLatToWorldPx(state.center, z);
  const scale = 2 ** (state.zoom - z);
  const moved = worldPxToLonLat(camera.px - dx / scale, camera.py - dy / scale, z);
  return clampCamera({ ...state, center: moved });
}

/**
 * How much detail the display is actually showing.
 *
 * Reported next to the sensor's native resolution so the interface can say
 * "source 10 m, shown at 4 m/px" rather than letting zoom imply detail that
 * does not exist.
 */
export function displayResolution(state: CameraState): number {
  return groundResolution(state.center.lat, state.zoom);
}
