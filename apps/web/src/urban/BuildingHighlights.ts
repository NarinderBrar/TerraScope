import { Color, Vec3, type Entity } from 'playcanvas';
import type { PCApp } from '../splat/supersplat/pc-app';
import type { SplatSceneMeta } from '../data/splatScenes';
import type { UrbanData } from './types';
import { loadUrbanData } from './osm';
import { metricFrame } from './model';

export function buildingOutlineVertices(data: UrbanData, scene: SplatSceneMeta): Vec3[] {
  const vertices: Vec3[] = [];
  const unit = metricFrame(scene).metresPerUnit;
  const ground = scene.georeference.groundZ + .2 / unit;
  for (const feature of data.features) {
    if (feature.kind !== 'building' || feature.tags.building === 'no' || feature.points.length < 4) continue;
    const points = feature.points;
    if (!points.every(p => p.every(Number.isFinite))) continue;
    // Use actual closed mapped footprints; never join unrelated open geometry.
    if (Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) > .01) continue;
    // Missing height stays a footprint. Do not turn the generic 9 m urban-model
    // fallback into an invented building outline height.
    const hasHeight = !feature.heightAssumed || Number(feature.tags['building:levels']) > 0;
    const height = hasHeight && Number.isFinite(feature.height) && feature.height > 0 ? feature.height / unit : 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      vertices.push(new Vec3(a[0], a[1], ground), new Vec3(b[0], b[1], ground));
      if (height) {
        vertices.push(new Vec3(a[0], a[1], ground + height), new Vec3(b[0], b[1], ground + height),
          new Vec3(a[0], a[1], ground), new Vec3(a[0], a[1], ground + height));
      }
    }
  }
  return vertices;
}

/** Clean mapped outlines over the normal full-detail splats; no Gaussian replacement. */
export function createBuildingHighlights(app: PCApp, root: Entity, scene: SplatSceneMeta, signal: AbortSignal) {
  let enabled = false;
  let pending: Promise<void> | undefined;
  let positions: Vec3[] = [], colors: Color[] = [];
  return {
    async setEnabled(value: boolean): Promise<void> {
      enabled = value;
      if (!value || signal.aborted) return;
      if (!pending) pending = loadUrbanData(scene, signal).then(data => {
        signal.throwIfAborted();
        const vertices = buildingOutlineVertices(data, scene);
        if (!vertices.length) throw new Error('No mapped building outlines are available here.');
        positions = vertices.map(p => root.getWorldTransform().transformPoint(p));
        const orange = new Color(1, .65, .22);
        colors = positions.map(() => orange);
      }).catch((error: unknown) => { pending = undefined; throw error; });
      await pending;
    },
    update(): void {
      // These are schematic mapped outlines, visible through splats. Depth is
      // deliberately disabled so ground footprints do not disappear under roofs.
      if (enabled && !signal.aborted && positions.length) app.drawLines(positions, colors, false);
    },
  };
}
