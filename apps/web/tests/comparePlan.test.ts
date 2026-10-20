import { describe, expect, it } from 'vitest';
import type { Scene } from '@terrascope/contracts';
import {
  MAX_FRAME_PIXELS,
  planFrame,
  selectFramesForView,
  pickComparisonPair,
  type FrameScene,
} from '../src/app/comparePlan';

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

const square = (w: number, s2: number, e: number, n: number): Scene['geometry'] => ({
  type: 'Polygon',
  coordinates: [[[w, s2], [e, s2], [e, n], [w, n], [w, s2]]],
});

const view = { west: -121.5, south: 37.95, east: -121.1, north: 38.25 };

describe('selectFramesForView', () => {
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

  it('filters out scenes exceeding maxCloud threshold and counts cloudy dates', () => {
    const scenes = [
      scene('clear', '2024-06-02T18:00:00Z', { cloudCover: 15, geometry: square(-122, 37.8, -120, 38.8) }),
      scene('partly-cloudy', '2024-06-10T18:00:00Z', { cloudCover: 45, geometry: square(-122, 37.8, -120, 38.8) }),
      scene('heavy-cloud', '2024-06-18T18:00:00Z', { cloudCover: 85, geometry: square(-122, 37.8, -120, 38.8) }),
    ];

    const strict = selectFramesForView(scenes, view, 20);
    expect(strict.frames.map((f) => f.id)).toEqual(['clear']);
    expect(strict.cloudy).toBe(2);

    const moderate = selectFramesForView(scenes, view, 50);
    expect(moderate.frames.map((f) => f.id)).toEqual(['clear', 'partly-cloudy']);
    expect(moderate.cloudy).toBe(1);

    const all = selectFramesForView(scenes, view, 100);
    expect(all.frames.map((f) => f.id)).toEqual(['clear', 'partly-cloudy', 'heavy-cloud']);
    expect(all.cloudy).toBe(0);
  });
});

describe('pickComparisonPair', () => {
  it('returns null if there are fewer than 2 frames', () => {
    expect(pickComparisonPair([], '2024-06-01', '2024-07-01')).toBeNull();
    const one = [scene('a', '2024-06-01T18:00:00Z')] as FrameScene[];
    expect(pickComparisonPair(one, '2024-06-01', '2024-07-01')).toBeNull();
  });

  it('selects 2 distinct scenes nearest to the requested dates and orders older on left', () => {
    const frames: FrameScene[] = [
      scene('early-june', '2024-06-03T18:00:00Z'),
      scene('mid-june', '2024-06-15T18:00:00Z'),
      scene('late-july', '2024-07-28T18:00:00Z'),
    ];

    const pair = pickComparisonPair(frames, '2024-06-01', '2024-07-30');
    expect(pair).not.toBeNull();
    expect(pair!.a.id).toBe('early-june');
    expect(pair!.b.id).toBe('late-july');
    expect(pair!.fromGapDays).toBe(3); // 2024-06-03 18:00 vs 2024-06-01 00:00: 66h = 2.75d -> 3
    expect(pair!.toGapDays).toBe(1);   // 2024-07-28 18:00 vs 2024-07-30 00:00: 30h = 1.25d -> 1
  });

  it('ensures distinct scenes even if target dates point to the same closest scene', () => {
    const frames: FrameScene[] = [
      scene('date1', '2024-06-05T18:00:00Z'),
      scene('date2', '2024-06-10T18:00:00Z'),
    ];

    // both from and to are closest to date1
    const pair = pickComparisonPair(frames, '2024-06-04', '2024-06-06');
    expect(pair).not.toBeNull();
    expect(pair!.a.id).toBe('date1');
    expect(pair!.b.id).toBe('date2');
  });

  it('breaks ties by picking the clearer scene', () => {
    const frames: FrameScene[] = [
      scene('cloudy', '2024-06-05T12:00:00Z', { cloudCover: 60 }),
      scene('clear', '2024-06-05T12:00:00Z', { cloudCover: 5 }),
      scene('later', '2024-07-01T12:00:00Z', { cloudCover: 10 }),
    ];

    const pair = pickComparisonPair(frames, '2024-06-05', '2024-07-01');
    expect(pair).not.toBeNull();
    expect(pair!.a.id).toBe('clear');
    expect(pair!.b.id).toBe('later');
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
