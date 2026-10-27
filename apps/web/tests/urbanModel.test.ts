import { describe, expect, it } from 'vitest';
import { computeShade, metricFrame, shadeAt, simulateTraffic, solarPosition } from '../src/urban/model';
import { parseOsm } from '../src/urban/osm';
import { DEFAULT_URBAN_OPTIONS, type UrbanData, type UrbanFeature, type XY } from '../src/urban/types';
import type { SplatSceneMeta } from '../src/data/splatScenes';
import { geographicToModel } from '../src/data/splatGeoreference';

const scene: SplatSceneMeta = { id: 'test', name: 'test', city: 'JAX', center: { lon: 0, lat: 0 },
  bounds: { west: -.001, south: -.001, east: .001, north: .001 },
  georeference: { origin: { lon: 0, lat: 0 }, modelToMercator: [1, 0, 0, 1], groundZ: 0 },
  splatUrl: '', lodUrl: '', upVector: [0, 0, 1] };
const road = (id: string, points: XY[], tags: Record<string, string> = {}): UrbanFeature => ({ id, name: id, kind: 'road', points,
  height: 0, heightAssumed: true, tags: { highway: 'residential', ...tags } });
const data = (features: UrbanFeature[]): UrbanData => ({ sceneId: 'test', fetchedAt: '', features });
const square = data([road('south', [[-60, -60], [60, -60]]), road('east', [[60, -60], [60, 60]]),
  road('north', [[60, 60], [-60, 60]]), road('west', [[-60, 60], [-60, -60]])]);

describe('urban network assignment', () => {
  it('routes the same demand around a closure and reports closed-link capacity', () => {
    const baseline = simulateTraffic(square, scene, DEFAULT_URBAN_OPTIONS);
    const proposed = simulateTraffic(square, scene, { ...DEFAULT_URBAN_OPTIONS, scenario: 'diversion', selectedRoad: 'south' });
    expect(baseline.unserved).toBe(0); expect(proposed.unserved).toBe(0);
    expect(proposed.trips).toBe(baseline.trips);
    expect(proposed.roads[0].volume).toBe(0); expect(proposed.roads[0].capacity).toBe(0);
    expect(proposed.roads.slice(1).some((r, i) => r.volume > baseline.roads[i + 1].volume)).toBe(true);
  });
  it('reports unroutable trips when closing the only connection', () => {
    const isolated = simulateTraffic(data([road('only', [[0, 0], [100, 0]])]), scene,
      { ...DEFAULT_URBAN_OPTIONS, scenario: 'diversion', selectedRoad: 'only' });
    expect(isolated.unserved).toBe(isolated.trips);
  });
  it('respects one-way roads, including reversed ways', () => {
    for (const oneway of ['yes', '-1']) {
      const result = simulateTraffic(data([road('only', [[0, 0], [100, 0]], { oneway })]), scene, DEFAULT_URBAN_OPTIONS);
      expect(result.unserved).toBe(result.trips / 2);
    }
  });
  it('increases delay with demand and uses a fixed bus-mode-shift assumption', () => {
    const low = simulateTraffic(square, scene, { ...DEFAULT_URBAN_OPTIONS, demand: 100 });
    const high = simulateTraffic(square, scene, { ...DEFAULT_URBAN_OPTIONS, demand: 5000 });
    expect(high.delay).toBeGreaterThan(low.delay);
    const bus = simulateTraffic(square, scene, { ...DEFAULT_URBAN_OPTIONS, scenario: 'bus-lane', selectedRoad: 'south' });
    expect(bus.trips).toBe(DEFAULT_URBAN_OPTIONS.demand * .8);
    expect(bus.roads[0].capacity).toBe(simulateTraffic(square, scene, DEFAULT_URBAN_OPTIONS).roads[0].capacity / 2);
  });
  it('converts mph and measures road lengths in ground metres', () => {
    const result = simulateTraffic(data([road('r', [[0, 0], [100, 0]], { maxspeed: '20 mph' })]), scene, DEFAULT_URBAN_OPTIONS);
    expect(result.roads[0].freeSpeed).toBeCloseTo(32.18688);
    expect(result.roads[0].length).toBeCloseTo(100);
  });
});
describe('sun and shadow geometry', () => {
  const building = { points: [[5, -3], [8, -3], [8, 3], [5, 3], [5, -3]] as XY[], height: 12 };
  it('casts shadows away from the sun and shortens them as elevation rises', () => {
    expect(shadeAt([0, 0], 30, 90, [building], [])).toBe(true);
    expect(shadeAt([0, 0], 30, 270, [building], [])).toBe(false);
    expect(shadeAt([0, 0], 85, 90, [building], [])).toBe(false);
  });
  it('intersects elevated tree crowns rather than treating a tree as a solid column', () => {
    const trees = [{ point: [6.5, 0] as XY, height: 11, radius: 3 }];
    expect(shadeAt([0, 0], 45, 90, [], trees)).toBe(true);
    expect(shadeAt([0, 0], 5, 90, [], trees)).toBe(false);
  });
  it('places the sun east in the morning, west in the afternoon, and high at equatorial noon', () => {
    expect(solarPosition('2026-03-21', 9, 0).azimuth).toBeLessThan(180);
    expect(solarPosition('2026-03-21', 15, 0).azimuth).toBeGreaterThan(180);
    expect(solarPosition('2026-03-21', 12, 0).altitude).toBeGreaterThan(88);
  });
  it('compares trees using the same pedestrian samples and does not reduce shade', () => {
    const opts = { ...DEFAULT_URBAN_OPTIONS, hour: 12, date: '2026-03-21' };
    const before = computeShade(square, scene, opts), after = computeShade(square, scene, { ...opts, scenario: 'trees' });
    expect(before.cells.length).toBeGreaterThan(0);
    expect(after.cells.map(c => c.point)).toEqual(before.cells.map(c => c.point));
    expect(after.percent!).toBeGreaterThan(before.percent!);
    expect(after.plannedTrees.length).toBeGreaterThan(0);
    expect(after.canopyPercent!).toBeGreaterThan(before.canopyPercent!);
    expect(computeShade(data([]), scene, opts).percent).toBeNull();
    expect(computeShade(square, scene, { ...opts, hour: 0 }).percent).toBeNull();
  });
});
describe('mapped data registration', () => {
  it('places OSM points through the existing registration, including rotation and scale', () => {
    const rotated = { ...scene, center: { lon: -74, lat: 40 }, georeference: {
      origin: { lon: -74, lat: 40 }, modelToMercator: [0, -2, 2, 0] as const, groundZ: 15 } };
    const parsed = parseOsm([{ type: 'node', id: 1, lon: -73.9999, lat: 40, tags: { natural: 'tree' } }], rotated);
    expect(parsed.features[0].points[0]).toEqual(geographicToModel(rotated.georeference, -73.9999, 40));
    const metric = metricFrame(rotated).point(parsed.features[0].points[0]);
    expect(metric[0]).toBeCloseTo(8.5276, 2); expect(metric[1]).toBeCloseTo(0);
  });
  it('keeps tagged heights distinct from defaults and skips invalid geometry', () => {
    const parsed = parseOsm([{ type: 'node', id: 1, lon: 0, lat: 0, tags: { natural: 'tree', height: '12 m' } },
      { type: 'node', id: 2, lon: 0, lat: 0, tags: { natural: 'tree' } },
      { type: 'way', id: 3, tags: { highway: 'residential' } }], scene);
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].height).toBe(12); expect(parsed.features[0].heightAssumed).toBe(false);
    expect(parsed.features[1].height).toBe(8); expect(parsed.features[1].heightAssumed).toBe(true);
  });
});
