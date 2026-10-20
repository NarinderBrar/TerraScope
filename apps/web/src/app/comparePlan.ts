/**
 * Comparison planning: which two scenes to compare, and what grid both dates
 * are read on. Pure functions, so the rules are testable without a GPU or a
 * network.
 */

import type { Scene } from '@terrascope/contracts';

/** Preferred when two collections carry the same acquisition. */
const PREFERRED_COLLECTION = 'sentinel-2-c1-l2a';

/**
 * Pixel budget for one read. The server caps a read at 320k pixels, which a
 * 4-band EOT1 payload (25 bytes a pixel) only just fits under its 8 MiB limit.
 * Staying below that keeps a margin for the header.
 */
export const MAX_FRAME_PIXELS = 300_000;

const EARTH_RADIUS = 6378137;

/** Sentinel-2's finest bands (red, green, blue, NIR) are 10 m. */
export const NATIVE_GSD_M = 10;

/** A date's scene, plus same-pass granules that fill the parts of the view it misses. */
export type FrameScene = Scene & {
  mosaicIds?: readonly string[];
  /** Fraction of the view with data on this date (0..1), from footprints. */
  coverage?: number;
};

type Bounds = { west: number; south: number; east: number; north: number };

/** Extra granules one date's read may composite (the server enforces the same cap). */
const MAX_MOSAIC_GRANULES = 3;

/**
 * Dates whose footprints cover less of the view than this are skipped. A
 * view on the boundary between two orbit tracks is only half imaged on each
 * track's dates; comparing those gives an image that is half empty.
 */
export const MIN_VIEW_COVERAGE = 0.8;

/** Points sampled across the view to measure footprint coverage. */
const SAMPLES_X = 16;
const SAMPLES_Y = 10;

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

export interface ComparisonPair {
  /** The earlier date. Always drawn left of the divider. */
  a: FrameScene;
  /** The later date. Always drawn right of the divider. */
  b: FrameScene;
  /** Whole days between the requested date and the date actually chosen. */
  fromGapDays: number;
  toGapDays: number;
}

/**
 * The two dates to compare: the one nearest `from` and the one nearest `to`.
 *
 * Dates are rarely available exactly where asked, so the nearest is used rather
 * than refusing to compare -- the gaps come back with the pair so the caller can
 * say how far off it had to settle. Two acquisitions of one day are still one
 * date, so the pair is forced onto two distinct items: a date compared with
 * itself is a difference of zero, which looks broken rather than empty.
 *
 * Null when the search found fewer than two dates, which the caller has to
 * report rather than paper over.
 */
export function pickComparisonPair(
  frames: readonly FrameScene[],
  from: string,
  to: string,
): ComparisonPair | null {
  if (frames.length < 2) return null;
  const wanted = [Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`)];
  const first = nearestTo(frames, wanted[0], null);
  const second = nearestTo(frames, wanted[1], first?.id ?? null);
  if (!first || !second) return null;
  // Older on the left, so dragging the divider right always moves forward in
  // time rather than jumping back to the earlier date.
  const [a, b] = Date.parse(first.datetime) <= Date.parse(second.datetime) ? [first, second] : [second, first];
  return {
    a,
    b,
    fromGapDays: gapDays(a.datetime, wanted[0]),
    toGapDays: gapDays(b.datetime, wanted[1]),
  };
}

/** The frame whose date is closest to `target`, optionally skipping one id. */
function nearestTo(
  frames: readonly FrameScene[],
  target: number,
  excludeId: string | null,
): FrameScene | null {
  let best: FrameScene | null = null;
  let bestGap = Infinity;
  for (const frame of frames) {
    if (excludeId != null && frame.id === excludeId) continue;
    const gap = Math.abs(Date.parse(frame.datetime) - target);
    // Ties go to the clearer date: two acquisitions on one day, one of them
    // under cloud, is a comparison nobody asked for.
    const clearer = best != null && (frame.cloudCover ?? 100) < (best.cloudCover ?? 100);
    if (gap < bestGap || (gap === bestGap && clearer)) {
      best = frame;
      bestGap = gap;
    }
  }
  return best;
}

function gapDays(datetime: string, target: number): number {
  return Math.round(Math.abs(Date.parse(datetime) - target) / 86_400_000);
}

export interface FramePlan {
  /** [left, bottom, right, top] in EPSG:3857 metres. */
  bounds3857: [number, number, number, number];
  width: number;
  height: number;
}

/**
 * The grid both dates are read on: exactly the view's bounds, sampled at the
 * coarsest of three limits --
 *
 *  - the view's own CSS pixels (more would be invisible),
 *  - the sensor's native 10 m (finer adds pixels, not detail), and
 *  - the frame pixel budget (the EOT1 payload cap).
 *
 * One plan serves both dates, which is the whole point: the swipe seam and the
 * difference layer are only exact if A and B are sampled on the same grid. Two
 * plans would leave a half-pixel offset between them, which reads as a real
 * edge in the difference.
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
