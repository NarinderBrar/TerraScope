import { Mat4, Quat, Vec3, type Entity } from 'playcanvas';
import { afterEach, expect, it, vi } from 'vitest';
import { createTreeCandidates, parseTreeCandidates } from '../src/urban/TreeCandidates';
import type { PCApp } from '../src/splat/supersplat/pc-app';
import { SKYFALL_SCENES } from '../src/data/splatScenes';

const data = { schemaVersion: 1, scene: 'NYC_010', kind: 'tree-candidates', coordinateFrame: 'registered-model-local',
  sourceSha256: 'a4febf9866e1edddcfd24c1cde9c6ca529436a5259980640cd78b5d52c0c95a4', points: [[10, 20, -25, .7]] };
afterEach(() => vi.unstubAllGlobals());

it('rejects unregistered frames, another source model and invalid marker values', () => {
  expect(parseTreeCandidates(data, 'NYC_010').points).toHaveLength(1);
  for (const invalid of [{ ...data, sourceSha256: 'other' }, { ...data, coordinateFrame: 'world' },
    { ...data, points: [[NaN, 0, 0, .7]] }, { ...data, points: [[0, 0, 0, 1.1]] }]) {
    expect(() => parseTreeCandidates(invalid, 'NYC_010')).toThrow();
  }
  expect(() => parseTreeCandidates(data, 'NYC_004')).toThrow();
});

it('loads only on demand, preserves original center height and stops drawing on hide/abort', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
  vi.stubGlobal('fetch', fetcher);
  const drawLines = vi.fn();
  const matrix = new Mat4().setTRS(Vec3.ZERO, new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP), Vec3.ONE);
  const root = { getWorldTransform: () => matrix } as Entity;
  const controller = new AbortController();
  const scene = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!;
  const overlay = createTreeCandidates({ drawLines } as unknown as PCApp, root, scene, controller.signal);
  overlay.update(); expect(fetcher).not.toHaveBeenCalled();
  expect(await overlay.setVisible(true)).toBe(1);
  overlay.update();
  const [positions, , depthTest] = drawLines.mock.calls[0];
  const center = positions[0].clone().add(positions[1]).mulScalar(.5);
  const expected = matrix.transformPoint(new Vec3(10, 20, -25));
  expect(center.distance(expected)).toBeLessThan(1e-5);
  expect(depthTest).toBe(true);
  await overlay.setVisible(false); drawLines.mockClear(); overlay.update();
  expect(drawLines).not.toHaveBeenCalled();
  await overlay.setVisible(true); expect(fetcher).toHaveBeenCalledOnce();
  controller.abort(); overlay.update(); expect(drawLines).not.toHaveBeenCalled();
});

it('allows retry after a fetch failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => data }));
  const root = { getWorldTransform: () => new Mat4() } as Entity;
  const scene = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!;
  const overlay = createTreeCandidates({} as PCApp, root, scene, new AbortController().signal);
  await expect(overlay.setVisible(true)).rejects.toThrow('could not be loaded');
  expect(await overlay.setVisible(true)).toBe(1);
});
