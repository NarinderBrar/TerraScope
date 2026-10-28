import { Mat4, Vec3 } from 'playcanvas';
import { SKYFALL_SCENES, type SplatSceneMeta } from '../data/splatScenes';
import { geographicToModel, type SplatGeoreference } from '../data/splatGeoreference';
import type { Camera } from '../splat/supersplat/camera';
import { EARTH_RADIUS, globePoint } from './navigation3D';

export interface Coverage3D {
  scene: SplatSceneMeta;
  points: { x: number; y: number }[];
  center: { x: number; y: number };
  marker: boolean;
}
type Transform = { getWorldTransform(): Mat4 };

/** Project actual registered coverage through the live floating camera frame. */
export function projectCoverage3D(camera: Camera, ground: Transform, reference: SplatGeoreference,
  earth: Transform, earthAnchor: { lon: number; lat: number }, blend: number,
  width: number, height: number): Coverage3D[] {
  if (width <= 0 || height <= 0) return [];
  const groundMatrix = ground.getWorldTransform(), earthMatrix = earth.getWorldTransform();
  const eye = new Mat4().copy(earthMatrix).invert().transformPoint(camera.mainCamera.getPosition())
    .add(new Vec3(0, EARTH_RADIUS, 0));
  const position = (lon: number, lat: number) => {
    const [x, y] = geographicToModel(reference, lon, lat);
    const flat = groundMatrix.transformPoint(new Vec3(x, y, reference.groundZ + .2));
    const sphere = earthMatrix.transformPoint(globePoint(lon, lat, earthAnchor));
    return flat.lerp(flat, sphere, blend);
  };
  const project = (point: Vec3) => {
    const depth = point.clone().sub(camera.mainCamera.getPosition()).dot(camera.mainCamera.forward);
    if (depth <= camera.camera.nearClip) return null;
    const screen = camera.camera.worldToScreen(point);
    return Number.isFinite(screen.x) && Number.isFinite(screen.y) ? { x: screen.x, y: screen.y } : null;
  };
  const boxes: Coverage3D[] = [];
  for (const scene of SKYFALL_SCENES) {
    if (blend >= .5) {
      const normal = globePoint(scene.center.lon, scene.center.lat, earthAnchor)
        .add(new Vec3(0, EARTH_RADIUS, 0)).normalize();
      if (normal.dot(eye) <= EARTH_RADIUS) continue;
    }
    const b = scene.bounds;
    const world = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]]
      .map(([lon, lat]) => position(lon, lat));
    const clipped: Vec3[] = [];
    const depth = (p: Vec3) => p.clone().sub(camera.mainCamera.getPosition()).dot(camera.mainCamera.forward);
    const near = camera.camera.nearClip * 1.001;
    for (let i = 0; i < world.length; i++) {
      const a = world[(i + world.length - 1) % world.length], point = world[i];
      const da = depth(a), db = depth(point);
      if ((da >= near) !== (db >= near)) clipped.push(new Vec3().lerp(a, point, (near - da) / (db - da)));
      if (db >= near) clipped.push(point);
    }
    const polygon = clipped.map(project).filter((p): p is { x: number; y: number } => p !== null);
    if (polygon.length < 3) continue;
    const center = project(position(scene.center.lon, scene.center.lat)) ?? {
      x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length,
      y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length,
    };
    const left = Math.min(...polygon.map(p => p.x)), right = Math.max(...polygon.map(p => p.x));
    const top = Math.min(...polygon.map(p => p.y)), bottom = Math.max(...polygon.map(p => p.y));
    if (right < -10 || left > width + 10 || bottom < -10 || top > height + 10) continue;
    boxes.push({ scene, points: polygon, center, marker: right - left < 12 && bottom - top < 12 });
  }
  return boxes;
}

export function hitCoverage3D(boxes: Coverage3D[], point: { x: number; y: number }): Coverage3D | undefined {
  return boxes.filter(box => {
    if (box.marker) return Math.hypot(point.x - box.center.x, point.y - box.center.y) <= 9;
    let inside = false;
    for (let i = 0, j = box.points.length - 1; i < box.points.length; j = i++) {
      const a = box.points[i], b = box.points[j];
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }).sort((a, b) => Math.hypot(point.x - a.center.x, point.y - a.center.y)
    - Math.hypot(point.x - b.center.x, point.y - b.center.y))[0];
}
