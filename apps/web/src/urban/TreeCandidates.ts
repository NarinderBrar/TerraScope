import { Color, Vec3, type Entity } from 'playcanvas';
import type { PCApp } from '../splat/supersplat/pc-app';
import type { SplatSceneMeta } from '../data/splatScenes';
import { metricFrame } from './model';

const SOURCE_SHA = 'a4febf9866e1edddcfd24c1cde9c6ca529436a5259980640cd78b5d52c0c95a4';
export interface TreeCandidateData {
  schemaVersion: number;
  scene: string;
  kind: string;
  coordinateFrame: string;
  sourceSha256: string;
  points: [number, number, number, number][];
}

export function parseTreeCandidates(value: unknown, sceneId: string): TreeCandidateData {
  const data = value as TreeCandidateData | null;
  if (sceneId !== 'NYC_010' || !data || data.schemaVersion !== 1 || data.scene !== sceneId
      || data.kind !== 'tree-candidates' || data.coordinateFrame !== 'registered-model-local'
      || data.sourceSha256 !== SOURCE_SHA || !Array.isArray(data.points) || data.points.length > 1200
      || data.points.some(p => !Array.isArray(p) || p.length !== 4 || !p.every(Number.isFinite) || p[3] < 0 || p[3] > 1)) {
    throw new Error('Tree candidate data does not match this registered scene.');
  }
  return data;
}

/** Mark original source centers under the existing model transform, without a height lift. */
export function createTreeCandidates(app: PCApp, root: Entity, scene: SplatSceneMeta, signal: AbortSignal) {
  let visible = false;
  let pending: Promise<number> | undefined;
  const positions: Vec3[] = [], colors: Color[] = [];
  const color = new Color(.35, 1, .45);
  const radius = 1.5 / metricFrame(scene).metresPerUnit;
  return {
    async setVisible(next: boolean): Promise<number> {
      visible = next;
      if (!next || scene.id !== 'NYC_010') return 0;
      if (!pending) {
        pending = (async () => {
          const response = await fetch(`${import.meta.env.BASE_URL}semantics/NYC_010-trees.json`, { signal });
          if (!response.ok) throw new Error('Tree candidates could not be loaded. Try again.');
          const data = parseTreeCandidates(await response.json(), scene.id);
          signal.throwIfAborted();
          const matrix = root.getWorldTransform();
          for (const [x, y, z] of data.points) {
            for (const p of [[x - radius, y, z], [x + radius, y, z], [x, y - radius, z], [x, y + radius, z]]) {
              positions.push(matrix.transformPoint(new Vec3(...p)));
              colors.push(color);
            }
          }
          return data.points.length;
        })().catch((error: unknown) => { pending = undefined; throw error; });
      }
      return pending;
    },
    update(): void {
      if (visible && !signal.aborted && positions.length) app.drawLines(positions, colors, true);
    },
  };
}
