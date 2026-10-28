import { Mat4, Vec3 } from 'playcanvas';
import type { Camera } from '../splat/supersplat/camera';
import { MERCATOR_CIRCUMFERENCE, modelToGeographic, type SplatGeoreference } from '../data/splatGeoreference';
import { MAX_ZOOM, MIN_ZOOM } from './MapCamera';
import { SKYFALL_SCENES, type SplatSceneMeta } from '../data/splatScenes';

/** Heading relative to geographic north, independent of a scene's model rotation. */
export interface GeographicOrientation { azimuth: number; elevation: number }
export interface GeographicView { center: { lon: number; lat: number }; zoom: number; orientation?: GeographicOrientation }
export const EARTH_RADIUS = 6371008.8;
/** Inverse of globePoint for a normalized radial direction. */
export function globeDirectionToGeographic(hit: Vec3, anchor: { lon: number; lat: number }) {
  const p0 = anchor.lat * Math.PI / 180, north = -hit.z;
  const lat = Math.asin(Math.max(-1, Math.min(1, hit.y * Math.sin(p0) + north * Math.cos(p0)))) * 180 / Math.PI;
  const lon = ((anchor.lon + Math.atan2(hit.x, hit.y * Math.cos(p0) - north * Math.sin(p0)) * 180 / Math.PI + 540) % 360) - 180;
  return { lon, lat };
}
export function globeBlend(distance: number): number {
  const t = Math.max(0, Math.min(1, (distance - 150000) / 650000));
  return t * t * (3 - 2 * t);
}
export function captureMapView(camera: Camera, root: { getWorldTransform(): Mat4 }, reference: SplatGeoreference,
  height: number): GeographicView | null {
  const inverse = new Mat4().copy(root.getWorldTransform()).invert();
  const origin = inverse.transformPoint(camera.mainCamera.getPosition());
  const direction = inverse.transformVector(camera.mainCamera.forward);
  const t = (reference.groundZ - origin.z) / direction.z;
  if (!Number.isFinite(t) || t <= 0 || height <= 0) return null;
  const point = origin.clone().add(direction.mulScalar(t));
  const center = modelToGeographic(reference, point.x, point.y);
  const [a, b, c, d] = reference.modelToMercator;
  const mercatorPerPixel = 2 * t * Math.tan(camera.camera.fov * Math.PI / 360) * Math.sqrt(Math.abs(a * d - b * c)) / height;
  const zoom = Math.log2(MERCATOR_CIRCUMFERENCE / (256 * mercatorPerPixel));
  if (![center.lon, center.lat, zoom].every(Number.isFinite)) return null;
  return { center, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)),
    orientation: { azimuth: camera.azim - Math.atan2(b, a) * 180 / Math.PI, elevation: camera.elevation } };
}
export function pickGroundFootprint(x: number, y: number, camera: Camera, root: { getWorldTransform(): Mat4 },
  reference: SplatGeoreference): SplatSceneMeta | undefined {
  const origin = camera.mainCamera.getPosition();
  const direction = camera.camera.screenToWorld(x, y, 1).sub(origin).normalize();
  const inverse = new Mat4().copy(root.getWorldTransform()).invert();
  const o = inverse.transformPoint(origin), v = inverse.transformVector(direction);
  const t = (reference.groundZ - o.z) / v.z;
  if (!Number.isFinite(t) || t <= 0) return;
  const p = o.add(v.mulScalar(t));
  const geo = modelToGeographic(reference, p.x, p.y);
  return SKYFALL_SCENES.filter(s => geo.lon >= s.bounds.west && geo.lon <= s.bounds.east
    && geo.lat >= s.bounds.south && geo.lat <= s.bounds.north)
    .sort((a, b) => Math.hypot(a.center.lon - geo.lon, a.center.lat - geo.lat)
      - Math.hypot(b.center.lon - geo.lon, b.center.lat - geo.lat))[0];
}
/** Globe positions in the same east/up/south tangent frame as the local map. */
export function globePoint(lon: number, lat: number, anchor: { lon: number; lat: number }): Vec3 {
  const r = Math.PI / 180, dl = (lon - anchor.lon) * r, p = lat * r, p0 = anchor.lat * r;
  return new Vec3(EARTH_RADIUS * Math.cos(p) * Math.sin(dl),
    EARTH_RADIUS * (Math.sin(p) * Math.sin(p0) + Math.cos(p) * Math.cos(p0) * Math.cos(dl) - 1),
    -EARTH_RADIUS * (Math.sin(p) * Math.cos(p0) - Math.cos(p) * Math.sin(p0) * Math.cos(dl)));
}
export function captureEarthView(camera: Camera, anchor: { lon: number; lat: number }, height: number, worldToEarth?: Mat4): GeographicView | null {
  const origin = worldToEarth ? worldToEarth.transformPoint(camera.mainCamera.getPosition()) : camera.mainCamera.getPosition();
  const direction = worldToEarth ? worldToEarth.transformVector(camera.mainCamera.forward).normalize() : camera.mainCamera.forward;
  const offset = origin.clone().add(new Vec3(0, EARTH_RADIUS, 0));
  const b = offset.dot(direction), discriminant = b * b - offset.lengthSq() + EARTH_RADIUS ** 2;
  if (discriminant < 0 || height <= 0) return null;
  const t = -b - Math.sqrt(discriminant);
  if (t <= 0) return null;
  const hit = origin.clone().add(direction.clone().mulScalar(t)).add(new Vec3(0, EARTH_RADIUS, 0)).mulScalar(1 / EARTH_RADIUS);
  const { lon, lat } = globeDirectionToGeographic(hit, anchor);
  const metresPerPixel = 2 * t * Math.tan(camera.camera.fov * Math.PI / 360) / height;
  return { center: { lon, lat }, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
    Math.log2(MERCATOR_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / (256 * metresPerPixel)))) };
}
