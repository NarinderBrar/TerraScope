import { lonLatToWorldPx, TILE_SIZE } from '@terrascope/contracts';
import { SKYFALL_SCENES, type ScreenPoint, type SplatSceneMeta } from '../data/splatScenes';
import type { CameraState, Viewport } from './MapCamera';

export interface ScreenFootprint {
  key: string;
  scene: SplatSceneMeta;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Registered coverage in CSS pixels, including every visible repeated world. */
export function projectSplatFootprints(
  camera: CameraState, viewport: Viewport, scenes: readonly SplatSceneMeta[] = SKYFALL_SCENES,
): ScreenFootprint[] {
  if (viewport.width <= 0 || viewport.height <= 0 || !Number.isFinite(camera.zoom) || camera.zoom < 0) return [];
  const center = lonLatToWorldPx(camera.center, 0);
  const scale = 2 ** camera.zoom;
  const worldWidth = TILE_SIZE * scale;
  const footprints: ScreenFootprint[] = [];
  for (const scene of scenes) {
    const nw = lonLatToWorldPx({ lon: scene.bounds.west, lat: scene.bounds.north }, 0);
    const se = lonLatToWorldPx({ lon: scene.bounds.east, lat: scene.bounds.south }, 0);
    const baseLeft = (nw.px - center.px) * scale + viewport.width / 2;
    const baseTop = (nw.py - center.py) * scale + viewport.height / 2;
    const width = (se.px - nw.px) * scale;
    const height = (se.py - nw.py) * scale;
    const top = Math.max(0, baseTop);
    const bottom = Math.min(viewport.height, baseTop + height);
    if (bottom <= top) continue;
    const firstWorld = Math.ceil((-width - baseLeft) / worldWidth);
    const lastWorld = Math.floor((viewport.width - baseLeft) / worldWidth);
    for (let world = firstWorld; world <= lastWorld; world++) {
      const x = baseLeft + world * worldWidth;
      const left = Math.max(0, x);
      const right = Math.min(viewport.width, x + width);
      if (right > left) footprints.push({ key: `${scene.id}:${world}`, scene, left, top, width: right - left, height: bottom - top });
    }
  }
  return footprints;
}

/** Match the exact highlighted coverage without expanding small boxes into unrelated areas. */
export function hitSplatFootprint(camera: CameraState, viewport: Viewport, point: ScreenPoint): SplatSceneMeta | undefined {
  const center = lonLatToWorldPx(camera.center, 0), scale = 2 ** camera.zoom, worldWidth = TILE_SIZE * scale;
  let closest: SplatSceneMeta | undefined;
  let distance = Infinity;
  for (const box of projectSplatFootprints(camera, viewport)) {
    if (point.x < box.left || point.x > box.left + box.width || point.y < box.top || point.y > box.top + box.height) continue;
    // Overlapping models remain reachable: choose the nearest registered scene
    // centre among footprints containing the click, including repeated worlds.
    const origin = lonLatToWorldPx(box.scene.center, 0);
    const x = (origin.px - center.px) * scale + viewport.width / 2;
    const dx = x + Math.round((point.x - x) / worldWidth) * worldWidth - point.x;
    const dy = (origin.py - center.py) * scale + viewport.height / 2 - point.y;
    const squared = dx * dx + dy * dy;
    if (squared < distance) { closest = box.scene; distance = squared; }
  }
  return closest;
}
