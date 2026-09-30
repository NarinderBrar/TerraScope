import { describe, expect, it } from 'vitest';
import type { Scene } from '@terrascope/contracts';
import { MAX_FRAME_PIXELS, loadOrder, pickBySlots, planFrame, selectFrames, selectFramesForView } from '../src/app/timelapsePlan';
import { monthChunks } from '../src/app/sceneSearch';

function scene(id: string, datetime: string, extra: Partial<Scene> = {}): Scene {
  return {
    id,
    collection: 'sentinel-2-l2a',
    datetime,
    bbox: [-122, 37.8, -120.8, 38.8],
    geometry: { type: 'Point', coordinates: [0, 0] },
    cloudCover: 10,
    bands: {},
    attribution: '',
    processingVersion: 'eot-1',
    qualityAvailable: true,
    ...extra,
  };
}

const centre = { lon: -121.3, lat: 38.1 };

describe('selectFrames', () => {
  it('keeps one scene per date, oldest first', () => {
    const frames = selectFrames(
      [scene('b', '2024-06-12T18:00:00Z'), scene('a', '2024-06-02T18:00:00Z'), scene('a2', '2024-06-02T18:00:05Z')],
      centre,
      100,
    );
    expect(frames.map((f) => f.datetime.slice(0, 10))).toEqual(['2024-06-02', '2024-06-12']);
  });

  it('prefers the newer collection for the same acquisition, then the clearer scene', () => {
    const frames = selectFrames(
      [
        scene('old', '2024-06-02T18:00:00Z', { cloudCover: 1 }),
        scene('new', '2024-06-02T18:00:00Z', { collection: 'sentinel-2-c1-l2a', cloudCover: 5 }),
      ],
      centre,
      100,
    );
    expect(frames.map((f) => f.id)).toEqual(['new']);
  });

  it('drops scenes that miss the view centre or exceed the cloud limit', () => {
    const frames = selectFrames(
      [
        scene('elsewhere', '2024-06-02T18:00:00Z', { bbox: [10, 10, 11, 11] }),
        scene('cloudy', '2024-06-07T18:00:00Z', { cloudCover: 80 }),
        scene('unknown-cloud', '2024-06-12T18:00:00Z', { cloudCover: null }),
      ],
      centre,
      50,
    );
    expect(frames.map((f) => f.id)).toEqual(['unknown-cloud']);
  });
});

describe('selectFramesForView', () => {
  const view = { west: -121.5, south: 37.95, east: -121.1, north: 38.25 };
  const square = (w: number, s2: number, e: number, n: number): Scene['geometry'] => ({
    type: 'Polygon', coordinates: [[[w, s2], [e, s2], [e, n], [w, n], [w, s2]]],
  });

  it('composites same-date granules, led by the one covering most of the view', () => {
    const { frames } = selectFramesForView(
      [
        scene('east', '2024-06-02T18:00:00Z', { collection: 'sentinel-2-c1-l2a', bbox: [-121.2, 37.8, -120.0, 38.8], geometry: square(-121.2, 37.8, -120.0, 38.8) }),
        scene('west', '2024-06-02T18:00:00Z', { collection: 'sentinel-2-c1-l2a', bbox: [-122.4, 37.8, -121.2, 38.8], geometry: square(-122.4, 37.8, -121.2, 38.8) }),
        scene('old-copy', '2024-06-02T18:00:00Z', { bbox: [-122.4, 37.8, -121.2, 38.8], geometry: square(-122.4, 37.8, -121.2, 38.8) }),
        scene('far', '2024-06-02T18:00:00Z', { collection: 'sentinel-2-c1-l2a', bbox: [10, 10, 11, 11], geometry: square(10, 10, 11, 11) }),
      ],
      view,
      100,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('west');
    expect(frames[0].mosaicIds).toEqual(['east']);
    expect(frames[0].coverage).toBe(1);
  });

  it('judges coverage by footprint, skipping dates the swath only half imaged', () => {
    // The bbox covers the whole view, but the data footprint is a triangle:
    // the edge of the imaging swath cuts the granule diagonally.
    const triangle: Scene['geometry'] = { type: 'Polygon', coordinates: [[[-122, 37.8], [-120, 38.8], [-120, 37.8], [-122, 37.8]]] };
    const result = selectFramesForView(
      [
        scene('swath-edge', '2024-06-02T18:00:00Z', { bbox: [-122, 37.8, -120, 38.8], geometry: triangle }),
        scene('full', '2024-06-07T18:00:00Z', { bbox: [-122, 37.8, -120, 38.8], geometry: square(-122, 37.8, -120, 38.8) }),
      ],
      view,
      100,
    );
    expect(result.frames.map((f) => f.id)).toEqual(['full']);
    expect(result.partial).toBe(1);
  });

  it('counts cloudy dates separately', () => {
    const result = selectFramesForView(
      [scene('cloudy', '2024-06-02T18:00:00Z', { cloudCover: 90, geometry: square(-122, 37.8, -120, 38.8) })],
      view,
      50,
    );
    expect(result).toMatchObject({ frames: [], cloudy: 1, partial: 0 });
  });
});

describe('pickBySlots', () => {
  it('keeps the clearest date in each time slot and the spacing even', () => {
    // Two slots over June: the first half has a cloudy and a clear date.
    const frames = [
      scene('cloudy', '2024-06-03T18:00:00Z', { cloudCover: 80 }),
      scene('clear', '2024-06-08T18:00:00Z', { cloudCover: 2 }),
      scene('late', '2024-06-25T18:00:00Z', { cloudCover: 40 }),
    ];
    expect(pickBySlots(frames, '2024-06-01', '2024-06-30', 2).map((f) => f.id)).toEqual(['clear', 'late']);
  });

  it('returns everything when already under the limit', () => {
    const frames = [scene('a', '2024-06-03T18:00:00Z'), scene('b', '2024-06-08T18:00:00Z')];
    expect(pickBySlots(frames, '2024-06-01', '2024-06-30', 60)).toHaveLength(2);
  });
});

describe('monthChunks', () => {
  it('splits a range at calendar months, inclusive at both ends', () => {
    expect(monthChunks('2026-04-15', '2026-06-10')).toEqual([
      { start: '2026-04-15', end: '2026-04-30' },
      { start: '2026-05-01', end: '2026-05-31' },
      { start: '2026-06-01', end: '2026-06-10' },
    ]);
  });

  it('handles a range inside one month and leap Februaries', () => {
    expect(monthChunks('2024-02-10', '2024-02-29')).toEqual([{ start: '2024-02-10', end: '2024-02-29' }]);
  });
});

describe('loadOrder', () => {
  it('starts with the first frame and covers every frame exactly once', () => {
    for (const n of [0, 1, 2, 3, 7, 16, 40]) {
      const order = loadOrder(n);
      expect(order).toHaveLength(n);
      expect(new Set(order).size).toBe(n);
      if (n > 0) expect(order[0]).toBe(0);
    }
  });

  it('reaches the last and middle frames early', () => {
    const order = loadOrder(20);
    expect(order.indexOf(19)).toBeLessThan(4);
    expect(order.indexOf(9)).toBeLessThan(6);
  });
});

describe('planFrame', () => {
  it('stays within the pixel budget, in multiples of 4, with square pixels', () => {
    const plan = planFrame({ west: -121.6, south: 37.9, east: -121.0, north: 38.3 }, { width: 1100, height: 850 });
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_FRAME_PIXELS);
    expect(plan.width % 4).toBe(0);
    expect(plan.height % 4).toBe(0);
    const [left, bottom, right, top] = plan.bounds3857;
    expect((top - bottom) / plan.height).toBeCloseTo((right - left) / plan.width, 6);
  });

  it('never samples finer than the sensor when zoomed in', () => {
    // ~0.02 deg wide at 38N is ~1.75 km: 10 m pixels give ~175 across, far
    // fewer than the 1100 CSS pixels showing it.
    const plan = planFrame({ west: -121.31, south: 38.095, east: -121.29, north: 38.105 }, { width: 1100, height: 850 });
    const [left, , right] = plan.bounds3857;
    const groundM = ((right - left) / plan.width) * Math.cos((38.1 * Math.PI) / 180);
    expect(groundM).toBeGreaterThanOrEqual(9.5);
    expect(plan.width).toBeLessThan(1100);
  });

  it('never samples finer than the viewport', () => {
    const plan = planFrame({ west: -121.6, south: 37.9, east: -121.0, north: 38.3 }, { width: 400, height: 300 });
    expect(plan.width).toBeLessThanOrEqual(400);
    expect(plan.height).toBeLessThanOrEqual(300);
  });
});
