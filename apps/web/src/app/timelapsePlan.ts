/**
 * Timelapse planning: which scenes become frames, in what order they load, and
 * what grid a frame is read on. Pure functions, so the rules are testable
 * without a GPU or a network.
 */

import type { Scene } from '@terrascope/contracts';

/** Preferred when two collections carry the same acquisition. */
const PREFERRED_COLLECTION = 'sentinel-2-c1-l2a';

/**
 * Pixel budget for one frame. The server caps a frame at 320k pixels, which a
 * 4-band EOT1 payload (25 bytes a pixel) only just fits under its 8 MiB limit.
 * Staying below that keeps a margin for the header.
 */
export const MAX_FRAME_PIXELS = 300_000;

const EARTH_RADIUS = 6378137;

/** Sentinel-2's finest bands (red, green, blue, NIR) are 10 m. */
export const NATIVE_GSD_M = 10;

/** A frame's scene, plus same-pass granules that fill the parts of the view it misses. */
export type FrameScene = Scene & {
  mosaicIds?: readonly string[];
  /** Fraction of the view with data on this date (0..1), from footprints. */
  coverage?: number;
};

type Bounds = { west: number; south: number; east: number; north: number };

/** Extra granules one frame may composite (the server enforces the same cap). */
const MAX_MOSAIC_GRANULES = 3;

/**
 * Dates whose footprints cover less of the view than this are skipped. A
 * view on the boundary between two orbit tracks is only half imaged on each
 * track's dates; playing those gives frames that are half empty.
 */
export const MIN_VIEW_COVERAGE = 0.8;

/** Points sampled across the view to measure footprint coverage. */
const SAMPLES_X = 16;
const SAMPLES_Y = 10;

/**
 * One scene per acquisition date, oldest first, judged at the view centre.
 * The simple rule, kept for callers without a view; see `selectFramesForView`.
 */
export function selectFrames(
  scenes: readonly Scene[],
  centre: { lon: number; lat: number },
  maxCloud: number,
): FrameScene[] {
  const byDate = new Map<string, Scene>();
  for (const scene of scenes) {
    if (!inFootprint(scene, centre)) continue;
    if (scene.cloudCover != null && scene.cloudCover > maxCloud) continue;
    const date = scene.datetime.slice(0, 10);
    const current = byDate.get(date);
    if (!current || better(scene, current)) byDate.set(date, scene);
  }
  return [...byDate.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
}

function better(candidate: Scene, current: Scene): boolean {
  const candidatePreferred = candidate.collection === PREFERRED_COLLECTION;
  const currentPreferred = current.collection === PREFERRED_COLLECTION;
  if (candidatePreferred !== currentPreferred) return candidatePreferred;
  return (candidate.cloudCover ?? 100) < (current.cloudCover ?? 100);
}

export interface ViewSelection {
  frames: FrameScene[];
  /** Dates dropped because their footprints miss too much of the view. */
  partial: number;
  /** Dates dropped for cloud cover. */
  cloudy: number;
}

/**
 * One frame per acquisition date for a whole view, oldest first.
 *
 * A search returns several entries per date: the same pass in two
 * collections, and neighbouring ~110 km granules of that pass. Coverage is
 * judged from each scene's *data footprint* (its STAC geometry), not its
 * bounding box: a granule at the edge of the imaging swath fills only a
 * diagonal slice of its box.
 *
 * Per date: keep one collection (the newer one when it covers the view),
 * then pick granules greedily -- the one covering most of the view leads, and
 * others are added while they cover something new. Dates that still cover
 * less than `minCoverage` of the view, or whose lead is cloudier than
 * `maxCloud`, are skipped and counted.
 */
export function selectFramesForView(
  scenes: readonly Scene[],
  view: Bounds,
  maxCloud: number,
  minCoverage = MIN_VIEW_COVERAGE,
): ViewSelection {
  const samples = sampleView(view);
  const byDate = new Map<string, Array<{ scene: Scene; hits: Set<number> }>>();
  for (const scene of scenes) {
    const hits = new Set<number>();
    samples.forEach((point, i) => {
      if (inFootprint(scene, point)) hits.add(i);
    });
    if (hits.size === 0) continue;
    const date = scene.datetime.slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push({ scene, hits });
    byDate.set(date, list);
  }

  const frames: FrameScene[] = [];
  let partial = 0;
  let cloudy = 0;
  for (const candidates of byDate.values()) {
    const preferred = candidates.filter((c) => c.scene.collection === PREFERRED_COLLECTION);
    const pool = preferred.length > 0 ? preferred : candidates;
    const chosen: Array<{ scene: Scene; hits: Set<number> }> = [];
    const covered = new Set<number>();
    while (chosen.length < 1 + MAX_MOSAIC_GRANULES) {
      let best: { scene: Scene; hits: Set<number> } | null = null;
      let bestGain = 0;
      for (const candidate of pool) {
        if (chosen.includes(candidate)) continue;
        let gain = 0;
        for (const i of candidate.hits) if (!covered.has(i)) gain += 1;
        const tie = best && gain === bestGain && (candidate.scene.cloudCover ?? 100) < (best.scene.cloudCover ?? 100);
        if (gain > bestGain || tie) {
          best = candidate;
          bestGain = gain;
        }
      }
      if (!best || bestGain === 0) break;
      chosen.push(best);
      for (const i of best.hits) covered.add(i);
    }
    const lead = chosen[0].scene;
    if (lead.cloudCover != null && lead.cloudCover > maxCloud) {
      cloudy += 1;
      continue;
    }
    const coverage = covered.size / samples.length;
    if (coverage < minCoverage) {
      partial += 1;
      continue;
    }
    const others = chosen.slice(1).map((c) => c.scene.id);
    frames.push({ ...lead, coverage, ...(others.length > 0 ? { mosaicIds: others } : {}) });
  }
  frames.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return { frames, partial, cloudy };
}

/** Cell centres of a SAMPLES_X by SAMPLES_Y grid over the view. */
function sampleView(view: Bounds): Array<{ lon: number; lat: number }> {
  const points: Array<{ lon: number; lat: number }> = [];
  for (let j = 0; j < SAMPLES_Y; j += 1) {
    for (let i = 0; i < SAMPLES_X; i += 1) {
      points.push({
        lon: view.west + ((i + 0.5) / SAMPLES_X) * (view.east - view.west),
        lat: view.south + ((j + 0.5) / SAMPLES_Y) * (view.north - view.south),
      });
    }
  }
  return points;
}

/** Is the point inside the scene's data footprint? Falls back to its bbox. */
function inFootprint(scene: Scene, point: { lon: number; lat: number }): boolean {
  const geometry = scene.geometry;
  if (geometry?.type === 'Polygon') return inPolygon(geometry.coordinates, point);
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => inPolygon(polygon, point));
  if (scene.bbox.length < 4) return true;
  const [west, south, east, north] = scene.bbox;
  return point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
}

/** Even-odd rule over all rings, so holes count as outside. */
function inPolygon(rings: number[][][], point: { lon: number; lat: number }): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > point.lat) !== (yj > point.lat) && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Thin frames to `maxFrames` without uneven jumps, preferring clear dates.
 *
 * The range is cut into `maxFrames` equal time slots and each slot keeps its
 * least cloudy date (catalog cloud cover; unknown counts as fully cloudy).
 * Taking every n-th date instead keeps the spacing but ignores clouds, and
 * taking the n clearest ignores spacing -- a month of clear weather would
 * crowd out the rest of the timelapse. Slots without a date stay empty.
 */
export function pickBySlots(frames: readonly FrameScene[], from: string, to: string, maxFrames: number): FrameScene[] {
  if (frames.length <= maxFrames) return [...frames];
  const start = Date.parse(`${from}T00:00:00Z`);
  const span = Math.max(1, Date.parse(`${to}T23:59:59Z`) - start);
  const best = new Map<number, FrameScene>();
  for (const frame of frames) {
    const t = Date.parse(frame.datetime);
    const slot = Math.min(maxFrames - 1, Math.max(0, Math.floor(((t - start) / span) * maxFrames)));
    const current = best.get(slot);
    if (!current || (frame.cloudCover ?? 100) < (current.cloudCover ?? 100)) best.set(slot, frame);
  }
  return [...best.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
}

/**
 * The order frames are fetched in.
 *
 * The first frame goes first, alone, because it is what the user is waiting
 * for. After that, sequential frames (what playback needs next) alternate with
 * a bisection of the range (what scrubbing needs), so both playing from the
 * start and dragging to the middle find something loaded early.
 */
export function loadOrder(count: number): number[] {
  if (count <= 0) return [];
  const spread: number[] = [];
  if (count > 1) spread.push(count - 1);
  const queue: Array<[number, number]> = [[0, count - 1]];
  while (queue.length > 0) {
    const [lo, hi] = queue.shift()!;
    if (hi - lo < 2) continue;
    const mid = (lo + hi) >> 1;
    spread.push(mid);
    queue.push([lo, mid], [mid, hi]);
  }
  const seen = new Set<number>([0]);
  const out = [0];
  let next = 1;
  let s = 0;
  while (out.length < count) {
    while (next < count && seen.has(next)) next += 1;
    if (next < count) {
      seen.add(next);
      out.push(next);
    }
    while (s < spread.length && seen.has(spread[s])) s += 1;
    if (s < spread.length) {
      seen.add(spread[s]);
      out.push(spread[s]);
    }
  }
  return out;
}

export interface FramePlan {
  /** [left, bottom, right, top] in EPSG:3857 metres. */
  bounds3857: [number, number, number, number];
  width: number;
  height: number;
}

/**
 * The grid a frame is read on: exactly the view's bounds, sampled at the
 * coarsest of three limits --
 *
 *  - the view's own CSS pixels (more would be invisible),
 *  - the sensor's native 10 m (finer adds pixels, not detail), and
 *  - the frame pixel budget (the EOT1 payload cap).
 *
 * The native limit matters when zoomed in: it spends the budget on the view
 * instead of on resampling the same 10 m samples into more pixels.
 *
 * Dimensions are multiples of 4 because the GPU mask kernels pack four pixels
 * per word. The bottom edge is derived from the width's pixel size so pixels
 * stay square after rounding.
 */
export function planFrame(
  bounds: { west: number; south: number; east: number; north: number },
  viewport: { width: number; height: number },
): FramePlan {
  const left = lonToX(bounds.west);
  const right = lonToX(bounds.east);
  const top = latToY(bounds.north);
  const midLat = ((bounds.north + bounds.south) / 2) * Math.PI / 180;
  // Web Mercator metres per ground metre grow as 1/cos(latitude).
  const nativeMercatorM = NATIVE_GSD_M / Math.cos(midLat);
  const byBudget = Math.sqrt(MAX_FRAME_PIXELS / Math.max(1, viewport.width * viewport.height));
  const byNative = (right - left) / nativeMercatorM / Math.max(1, viewport.width);
  const k = Math.min(1, byBudget, byNative);
  const width = Math.max(4, Math.floor((viewport.width * k) / 4) * 4);
  const height = Math.max(4, Math.floor((viewport.height * k) / 4) * 4);
  const res = (right - left) / width;
  return { bounds3857: [left, top - res * height, right, top], width, height };
}

function lonToX(lon: number): number {
  return (lon * Math.PI / 180) * EARTH_RADIUS;
}

function latToY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * EARTH_RADIUS;
}
