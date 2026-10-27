import { expect, it } from 'vitest';
import { map3DReference } from '../src/map/Map3DView';
import { geographicToModel, modelToGeographic } from '../src/data/splatGeoreference';

it.each([{ lon: 77.2, lat: 28.6 }, { lon: -73.99, lat: 40.73 }, { lon: 0, lat: 80 }])('keeps a geographic local frame at $lat latitude without splat assets', center => {
  const reference = map3DReference(center);
  expect(geographicToModel(reference, center.lon, center.lat)).toEqual([0, 0]);
  const source = { lon: center.lon + .002, lat: center.lat + .001 };
  const xy = geographicToModel(reference, source.lon, source.lat);
  const recovered = modelToGeographic(reference, ...xy);
  expect(recovered.lon).toBeCloseTo(source.lon, 8); expect(recovered.lat).toBeCloseTo(source.lat, 8);
  expect(reference.modelToMercator[0] * Math.cos(center.lat * Math.PI / 180)).toBeCloseTo(1);
});
