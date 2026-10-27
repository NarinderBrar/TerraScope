import { describe, expect, it } from 'vitest';
import { lonLatToWorldPx, worldPxToLonLat } from '@terrascope/contracts';
import { readFileSync } from 'node:fs';
import manifest from '../public/splats/manifest.json';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { geographicToModel, modelToGeographic } from '../src/data/splatGeoreference';
import { planGroundMap } from '../src/splat/groundMapPlan';

describe('satellite ground registration', () => {
  it('uses level-20 ground imagery for small footprints when it fits the texture budget', () => {
    const scene = SKYFALL_SCENES[0];
    const detail = { ...scene, bounds: {
      west: scene.center.lon - .0001, east: scene.center.lon + .0001,
      south: scene.center.lat - .0001, north: scene.center.lat + .0001,
    } };
    const plan = planGroundMap(detail, 1024);
    expect(plan.tiles[0].z).toBe(20);
    expect(plan.width).toBeLessThanOrEqual(1024);
    expect(plan.height).toBeLessThanOrEqual(1024);
    const first = plan.tiles[0];
    const expected = worldPxToLonLat(first.x * 256, first.y * 256, first.z);
    const actual = modelToGeographic(scene.georeference, plan.corners[0][0], plan.corners[0][1]);
    expect(actual.lon).toBeCloseTo(expected.lon, 9);
    expect(actual.lat).toBeCloseTo(expected.lat, 9);
  });
  it.each(SKYFALL_SCENES)('requires measured map-registration evidence for $id', (scene) => {
    const evidence = JSON.parse(readFileSync(new URL(`../../../docs/splat-registration/${scene.id}.json`, import.meta.url), 'utf8')) as {
      scene: string;
      tileOrigin: { z: number; x0: number; y0: number };
      modelRaster: { left: number; top: number; unitsPerPixel: number };
      matchedFeatures: { model: [number, number]; satellite: [number, number] }[];
      validationFeatures?: { model: [number, number]; satellite: [number, number] }[];
      sourceAssetSha256?: string;
      georeference?: typeof scene.georeference;
      groundSamples?: { modelXY: [number, number]; medianZ: number }[];
      verticalAlignment: { previousGroundZ: number; groundZ: number; medianStreetZ: number; clearanceGroundMetres: number; groundMetresPerModelUnit: number; sourceSha256: string };
    };
    expect(evidence.scene).toBe(scene.id);
    expect(evidence.matchedFeatures.length).toBeGreaterThanOrEqual(6);
    expect(evidence.georeference).toEqual(scene.georeference);
    const vertical = evidence.verticalAlignment;
    expect(vertical.sourceSha256).toBe(manifest.assets.find(asset => asset.id === scene.id)?.sha256);
    const streetHeights = evidence.groundSamples!.map(s => s.medianZ).sort((a, b) => a - b);
    const midpoint = Math.floor(streetHeights.length / 2);
    const median = streetHeights.length % 2 ? streetHeights[midpoint] : (streetHeights[midpoint - 1] + streetHeights[midpoint]) / 2;
    expect(vertical.medianStreetZ).toBeCloseTo(median, 8);
    expect((median - scene.georeference.groundZ) * vertical.groundMetresPerModelUnit).toBeCloseTo(.2, 8);
    if (evidence.validationFeatures) {
      expect(evidence.validationFeatures.length).toBeGreaterThanOrEqual(3);
      expect(evidence.sourceAssetSha256).toBe(manifest.assets.find((asset) => asset.id === scene.id)?.sha256);
      expect(evidence.georeference).toEqual(scene.georeference);
    }
    // Includes withheld reference points that did not participate in the fitted transform.
    for (const feature of [...evidence.matchedFeatures, ...(evidence.validationFeatures ?? [])]) {
      const geo = worldPxToLonLat(evidence.tileOrigin.x0 * 256 + feature.satellite[0],
        evidence.tileOrigin.y0 * 256 + feature.satellite[1], evidence.tileOrigin.z);
      const actual = geographicToModel(scene.georeference, geo.lon, geo.lat);
      const x = evidence.modelRaster.left + feature.model[0] * evidence.modelRaster.unitsPerPixel;
      const y = evidence.modelRaster.top - feature.model[1] * evidence.modelRaster.unitsPerPixel;
      expect(Math.hypot(actual[0] - x, actual[1] - y)).toBeLessThan(6);
    }
  });
  it.each(SKYFALL_SCENES)('covers $id with bounded imagery and fixed ground height', (scene) => {
    const plan = planGroundMap(scene);
    expect(plan.width).toBeLessThanOrEqual(4096);
    expect(plan.height).toBeLessThanOrEqual(4096);
    expect(plan.tiles.length).toBeLessThanOrEqual(256);
    expect(plan.tiles[0].z).toBeGreaterThanOrEqual(17);
    expect(plan.corners.every(p => p[2] === scene.georeference.groundZ)).toBe(true);
    const [nw, ne, , sw] = plan.corners;
    for (const [x, y] of [[-300, -350], [0, 0], [300, 300]]) {
      const geo = modelToGeographic(scene.georeference, x, y);
      const px = lonLatToWorldPx(geo, plan.tiles[0].z);
      const u = (px.px - plan.tiles[0].x * 256) / plan.width;
      const v = (px.py - plan.tiles[0].y * 256) / plan.height;
      expect(nw[0] + u * (ne[0] - nw[0]) + v * (sw[0] - nw[0])).toBeCloseTo(x, 5);
      expect(nw[1] + u * (ne[1] - nw[1]) + v * (sw[1] - nw[1])).toBeCloseTo(y, 5);
    }
  });
  it('changing tile coverage does not move or stretch the georeference', () => {
    const scene = SKYFALL_SCENES[0];
    const larger = { ...scene, bounds: { west: scene.bounds.west - .01, east: scene.bounds.east + .01,
      south: scene.bounds.south - .01, north: scene.bounds.north + .01 } };
    for (const variant of [scene, larger]) {
      const p = planGroundMap(variant);
      const point = lonLatToWorldPx(scene.center, p.tiles[0].z);
      const u = (point.px - p.tiles[0].x * 256) / p.width;
      const v = (point.py - p.tiles[0].y * 256) / p.height;
      for (const axis of [0, 1]) expect(p.corners[0][axis] + u * (p.corners[1][axis] - p.corners[0][axis])
        + v * (p.corners[3][axis] - p.corners[0][axis])).toBeCloseTo(0, 5);
    }
  });
  it('supports a rotated data frame without treating north as local +Y', () => {
    const reference = { origin: { lon: 0, lat: 0 }, modelToMercator: [0, -1, 1, 0] as const, groundZ: 0 };
    const east = geographicToModel(reference, .001, 0);
    const north = geographicToModel(reference, 0, .001);
    expect(east[0]).toBeCloseTo(0); expect(east[1]).toBeCloseTo(-111.31949, 4);
    expect(north[0]).toBeCloseTo(111.31949, 4); expect(north[1]).toBeCloseTo(0);
  });
});

// Independently geolocated reference-image features, not computed from the runtime transform.
it.each([["JAX_068", -387.9471435546875, 101.06179809570312, -81.66777971002375, 30.349736031790414], ["JAX_068", -299.809326171875, 114.7652587890625, -81.66687462999107, 30.34982271770641], ["JAX_068", -28.94610595703125, -205.82977294921875, -81.6640847583767, 30.346955075518828], ["NYC_004", 0.165283203125, -256.12994384765625, -74.01489469521039, 40.713232587135714], ["NYC_004", -180.6065673828125, -149.95751953125, -74.01680622457206, 40.714118167952265], ["NYC_004", 138.1700439453125, 141.24740600585938, -74.01326797407819, 40.71644431001327]])('keeps reference feature %s within 5 model units', (id, x, y, lon, lat) => {
  const scene = SKYFALL_SCENES.find(s => s.id === id)!;
  const local = geographicToModel(scene.georeference, Number(lon), Number(lat));
  expect(Math.hypot(local[0] - Number(x), local[1] - Number(y))).toBeLessThan(5);
});

it.each([1024, 2048, 4096])('respects a %i pixel GPU texture limit without shifting the map', (limit) => {
  for (const scene of SKYFALL_SCENES) {
    const plan = planGroundMap(scene, limit);
    expect(plan.width).toBeLessThanOrEqual(limit);
    expect(plan.height).toBeLessThanOrEqual(limit);
    expect(plan.tiles.length).toBeLessThanOrEqual((limit / 256) ** 2);
  }
});
