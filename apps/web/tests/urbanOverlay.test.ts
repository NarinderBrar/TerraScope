import { Mat4, Quat, Vec3, type Entity } from 'playcanvas';
import { expect, it, vi } from 'vitest';
import { createUrbanOverlay } from '../src/urban/UrbanOverlay';
import type { PCApp } from '../src/splat/supersplat/pc-app';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { DEFAULT_URBAN_OPTIONS, type UrbanOverlayState } from '../src/urban/types';
import { metricFrame } from '../src/urban/model';

it('draws through the registered model root, animates/pause particles and clears lines', () => {
  const matrix = new Mat4().setTRS(Vec3.ZERO, new Quat().setFromDirections(new Vec3(0, 0, 1), Vec3.UP), Vec3.ONE);
  const root = { getWorldTransform: () => matrix } as Entity;
  const drawLines = vi.fn();
  const scene = SKYFALL_SCENES[0];
  const overlay = createUrbanOverlay({ drawLines } as unknown as PCApp, root, scene);
  const feature = { id: 'way/1', name: 'Road', kind: 'road' as const, points: [[0, 0], [100, 0]] as [number, number][], tags: { highway: 'residential' }, height: 0, heightAssumed: true };
  const state: UrbanOverlayState = { data: { features: [feature], fetchedAt: '', sceneId: scene.id },
    options: { ...DEFAULT_URBAN_OPTIONS }, selectedFeature: '',
    traffic: { roads: [{ feature, a: [0, 0], b: [100, 0], length: 100, capacity: 1000, volume: 200, speed: 20, freeSpeed: 30, load: .2 }], delay: 0, peakLoad: .2, trips: 200, unserved: 0 },
    shade: { cells: [], percent: null, canopyPercent: 0, sunAltitude: 45, sunAzimuth: 90, plannedTrees: [] } };
  overlay.setState(state); overlay.update(.1);
  const roadStart = drawLines.mock.calls[0][0][0] as Vec3;
  expect(roadStart.y).toBeCloseTo(scene.georeference.groundZ + .3 / metricFrame(scene).metresPerUnit, 5);
  expect(roadStart.z).toBeCloseTo(0);
  const particle = () => (drawLines.mock.calls.at(-1)![0][0] as Vec3).clone();
  const moving = particle(); overlay.update(.1); expect(particle().x).toBeGreaterThan(moving.x);
  overlay.setState({ ...state, options: { ...state.options, playing: false } });
  const stopped = particle(); overlay.update(.1); expect(particle().x).toBeCloseTo(stopped.x);
  drawLines.mockClear(); overlay.setState(null); overlay.update(.1); expect(drawLines).not.toHaveBeenCalled();
});
