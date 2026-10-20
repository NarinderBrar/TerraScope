import { lonLatToWorldPx, worldPxToLonLat } from '@terrascope/contracts';
import type { GeoBounds } from '../data/splatScenes';
import { geographicToModel, MERCATOR_CIRCUMFERENCE, type SplatGeoreference } from '../data/splatGeoreference';

/** Ground-plane frame of the current map, measured at the registered ground plane. */
export function mapViewFrame(bounds: GeoBounds, reference: SplatGeoreference) {
  const nw = lonLatToWorldPx({ lon: bounds.west, lat: bounds.north }, 0);
  const se = lonLatToWorldPx({ lon: bounds.east, lat: bounds.south }, 0);
  const center = worldPxToLonLat((nw.px + se.px) / 2, (nw.py + se.py) / 2, 0);
  const [x, y] = geographicToModel(reference, center.lon, center.lat);
  const [a, b] = reference.modelToMercator;
  const scale = Math.hypot(a, b);
  return {
    focalPoint: [x, reference.groundZ, -y] as const,
    halfHeight: (se.py - nw.py) * MERCATOR_CIRCUMFERENCE / 512 / scale,
    azimuth: Math.atan2(b, a) * 180 / Math.PI,
  };
}
