import { Mat4, Quat, Vec3, type Entity } from 'playcanvas';
import { afterEach, expect, it, vi } from 'vitest';
import { buildingOutlineVertices, createBuildingHighlights } from '../src/urban/BuildingHighlights';
import { loadUrbanData } from '../src/urban/osm';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { metricFrame } from '../src/urban/model';
import type { PCApp } from '../src/splat/supersplat/pc-app';
import type { UrbanData, UrbanFeature } from '../src/urban/types';

vi.mock('../src/urban/osm', () => ({ loadUrbanData: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const scene = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!;
const building: UrbanFeature = { id: 'way/1', kind: 'building', name: 'Building',
  points: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
  tags: { building: 'yes' }, height: 9, heightAssumed: true };
const data = (features: UrbanFeature[]): UrbanData => ({ sceneId: scene.id, fetchedAt: '', features });

it('outlines only closed building footprints and never invents missing heights', () => {
  const vertices = buildingOutlineVertices(data([building, { ...building, kind: 'road' },
    { ...building, kind: 'tree' }, { ...building, points: building.points.slice(0, -1) },
    { ...building, tags: { building: 'no' } }]), scene);
  expect(vertices).toHaveLength(8);
  const ground = scene.georeference.groundZ + .2 / metricFrame(scene).metresPerUnit;
  expect(vertices.every(p => Math.abs(p.z - ground) < 1e-6)).toBe(true);
  const raised = buildingOutlineVertices(data([{ ...building, height: 30, heightAssumed: false }]), scene);
  expect(raised).toHaveLength(24);
  expect(Math.max(...raised.map(p => p.z)) - ground).toBeCloseTo(30 / metricFrame(scene).metresPerUnit);
});

it('loads on demand, uses the registered root and stops drawing on hide or abort', async () => {
  vi.mocked(loadUrbanData).mockResolvedValue(data([building]));
  const matrix = new Mat4().setTRS(Vec3.ZERO, new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP), Vec3.ONE);
  const root = { getWorldTransform: () => matrix } as Entity;
  const drawLines = vi.fn(), controller = new AbortController();
  const overlay = createBuildingHighlights({ drawLines } as unknown as PCApp, root, scene, controller.signal);
  overlay.update(); expect(loadUrbanData).not.toHaveBeenCalled();
  await overlay.setEnabled(true); overlay.update();
  const expected = matrix.transformPoint(buildingOutlineVertices(data([building]), scene)[0]);
  expect(drawLines.mock.calls[0][0][0].distance(expected)).toBeLessThan(1e-5);
  await overlay.setEnabled(false); drawLines.mockClear(); overlay.update();
  expect(drawLines).not.toHaveBeenCalled();
  await overlay.setEnabled(true); expect(loadUrbanData).toHaveBeenCalledOnce();
  controller.abort(); overlay.update(); expect(drawLines).not.toHaveBeenCalled();
});

it('permits retry after data failure', async () => {
  vi.mocked(loadUrbanData).mockRejectedValueOnce(new Error('OSM unavailable')).mockResolvedValueOnce(data([building]));
  const root = { getWorldTransform: () => new Mat4() } as Entity;
  const overlay = createBuildingHighlights({} as PCApp, root, scene, new AbortController().signal);
  await expect(overlay.setEnabled(true)).rejects.toThrow('OSM unavailable');
  await expect(overlay.setEnabled(true)).resolves.toBeUndefined();
});
