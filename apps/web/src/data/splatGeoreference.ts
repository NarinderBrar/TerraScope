import { lonLatToWorldPx, worldPxToLonLat } from '@terrascope/contracts';

/** Fixed horizontal registration in EPSG:3857 metres, independent of asset bounds. */
export interface SplatGeoreference {
  origin: { lon: number; lat: number };
  /** [east per X, east per Y, north per X, north per Y]. Includes Mercator scale. */
  modelToMercator: readonly [number, number, number, number];
  /** Local Z just below the reconstructed streets, excluding subsurface floaters. */
  groundZ: number;
}
export const MERCATOR_CIRCUMFERENCE = 40075016.68557849;

export function geographicToModel(reference: SplatGeoreference, lon: number, lat: number): [number, number] {
  const origin = lonLatToWorldPx(reference.origin, 0);
  const point = lonLatToWorldPx({ lon, lat }, 0);
  const east = (point.px - origin.px) * MERCATOR_CIRCUMFERENCE / 256;
  const north = (origin.py - point.py) * MERCATOR_CIRCUMFERENCE / 256;
  const [a, b, c, d] = reference.modelToMercator;
  const determinant = a * d - b * c;
  return [(d * east - b * north) / determinant, (a * north - c * east) / determinant];
}

export function modelToGeographic(reference: SplatGeoreference, x: number, y: number): { lon: number; lat: number } {
  const origin = lonLatToWorldPx(reference.origin, 0);
  const [a, b, c, d] = reference.modelToMercator;
  return worldPxToLonLat(origin.px + (a * x + b * y) * 256 / MERCATOR_CIRCUMFERENCE,
    origin.py - (c * x + d * y) * 256 / MERCATOR_CIRCUMFERENCE, 0);
}
