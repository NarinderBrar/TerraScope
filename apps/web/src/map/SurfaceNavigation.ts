import { Mat4, Quat, Vec3 } from 'playcanvas';
import { modelToGeographic, type SplatGeoreference } from '../data/splatGeoreference';
import type { Camera, SurfaceControls } from '../splat/supersplat/camera';
import { EARTH_RADIUS, globeBlend, globeDirectionToGeographic, globePoint } from './navigation3D';

type GeographicPoint = { lon: number; lat: number };
type Transform = { getWorldTransform(): Mat4 };

/** Near the surface allow 85° from nadir; distant views stay nearly nadir. */
export function maximumSurfaceTilt(distanceMetres: number): number {
  const t = Math.max(0, Math.min(1, Math.log(Math.max(30000, distanceMetres) / 30000) / Math.log(2000000 / 30000)));
  const blend = t * t * (3 - 2 * t);
  return 85 * (1 - blend) + blend;
}

/** Keep physical world units constant as the Mercator reference moves in latitude. */
export function referenceAtFocus(original: SplatGeoreference, focus: GeographicPoint): SplatGeoreference {
  const factor = Math.cos(original.origin.lat * Math.PI / 180) / Math.cos(focus.lat * Math.PI / 180);
  const [a, b, c, d] = original.modelToMercator;
  return { origin: { ...focus }, modelToMercator: [a * factor, b * factor, c * factor, d * factor], groundZ: original.groundZ };
}

/** Geographic panning changes the floating frame, never the camera's XY pivot. */
export function createSurfaceNavigation(camera: Camera, original: SplatGeoreference, initial: GeographicPoint,
  groundRoot: Transform, earth: Transform, metresPerUnit: number,
  onFocus: (focus: GeographicPoint, reference: SplatGeoreference) => void) {
  let focus = { ...initial };
  let reference = referenceAtFocus(original, focus);
  const distance = () => camera.distance * camera.sceneRadius / camera.fovFactor * metresPerUnit;
  const setFocus = (point: GeographicPoint) => {
    if (![point.lon, point.lat].every(Number.isFinite)) return;
    focus = { lon: ((point.lon + 540) % 360) - 180, lat: Math.max(-85.05112878, Math.min(85.05112878, point.lat)) };
    reference = referenceAtFocus(original, focus);
    onFocus(focus, reference);
  };
  const ray = (x: number, y: number) => {
    const origin = camera.mainCamera.getPosition().clone();
    const target = camera.camera.screenToWorld(x, y, Math.max(1, EARTH_RADIUS / metresPerUnit * .001));
    return { origin, direction: target.sub(origin).normalize() };
  };
  const planeHit = (x: number, y: number) => {
    const { origin, direction } = ray(x, y);
    const t = (original.groundZ - origin.y) / direction.y;
    return Number.isFinite(t) && t > 0 ? origin.add(direction.mulScalar(t)) : null;
  };
  const sphereDirection = (x: number, y: number) => {
    const r = ray(x, y), inverse = new Mat4().copy(earth.getWorldTransform()).invert();
    const origin = inverse.transformPoint(r.origin).add(new Vec3(0, EARTH_RADIUS, 0));
    const direction = inverse.transformVector(r.direction).normalize();
    const b = origin.dot(direction), discriminant = b * b - origin.lengthSq() + EARTH_RADIUS ** 2;
    // Outside the silhouette, use the virtual trackball's rim so a continued
    // drag rotates the planet rather than translating its center off screen.
    const t = discriminant >= 0 ? -b - Math.sqrt(discriminant) : -b;
    return t > 0 ? origin.add(direction.mulScalar(t)).normalize() : null;
  };
  const controls: SurfaceControls = {
    pan(x, y, dx, dy) {
      if (globeBlend(distance()) < .5) {
        const before = planeHit(x - dx, y - dy), after = planeHit(x, y);
        if (before && after) {
          const inverse = new Mat4().copy(groundRoot.getWorldTransform()).invert();
          const delta = inverse.transformVector(before.sub(after));
          setFocus(modelToGeographic(reference, delta.x, delta.y));
          return;
        }
      }
      const before = sphereDirection(x - dx, y - dy), after = sphereDirection(x, y);
      if (!before || !after) return;
      const rotation = new Quat().setFromDirections(after, before);
      const normal = globePoint(focus.lon, focus.lat, original.origin).add(new Vec3(0, EARTH_RADIUS, 0)).normalize();
      setFocus(globeDirectionToGeographic(rotation.transformVector(normal).normalize(), original.origin));
    },
    orbit(dx, dy) {
      const damping = Math.max(.02, maximumSurfaceTilt(distance()) / 85);
      const sensitivity = camera.scene.config.controls.orbitSensitivity;
      camera.setAzimElev(camera.azim - dx * sensitivity, camera.elevation - dy * sensitivity * damping);
    },
    focus(x, y) {
      const canvas = camera.scene.app.graphicsDevice.canvas as HTMLCanvasElement;
      const px = x * canvas.clientWidth, py = y * canvas.clientHeight;
      if (globeBlend(distance()) < .5) {
        const point = planeHit(px, py);
        if (point) {
          const local = new Mat4().copy(groundRoot.getWorldTransform()).invert().transformPoint(point);
          setFocus(modelToGeographic(reference, local.x, local.y)); return;
        }
      }
      const normal = sphereDirection(px, py);
      if (normal) setFocus(globeDirectionToGeographic(normal, original.origin));
    },
    constrainElevation(elevation) {
      return Math.max(-90, Math.min(-90 + maximumSurfaceTilt(distance()), elevation));
    },
    reset() { setFocus(initial); },
  };
  camera.surfaceControls = controls;
  setFocus(initial);
  camera.setAzimElev(camera.azim, camera.elevation);
  return {
    get focus() { return { ...focus }; },
    goTo: setFocus,
    dispose() { if (camera.surfaceControls === controls) camera.surfaceControls = undefined; },
  };
}
