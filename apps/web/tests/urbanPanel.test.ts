// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UrbanPanel } from '../src/urban/UrbanPanel';
import { loadUrbanData } from '../src/urban/osm';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import type { UrbanData, UrbanOverlayState } from '../src/urban/types';

vi.mock('../src/urban/osm', () => ({ loadUrbanData: vi.fn() }));
const scene = SKYFALL_SCENES[0];
const fixture: UrbanData = { sceneId: scene.id, fetchedAt: '2026-10-21T12:00:00Z', features: [
  { id: 'way/1', kind: 'road', name: 'Test Street', points: [[-50, 0], [50, 0]], tags: { highway: 'residential' }, height: 0, heightAssumed: true },
] };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('loads mapped data, reroutes scenario demand, pauses particles, and clears overlays on exit', async () => {
  vi.mocked(loadUrbanData).mockResolvedValue(fixture);
  const onChange = vi.fn<(state: UrbanOverlayState | null) => void>();
  await act(async () => root.render(createElement(UrbanPanel, { scene, onChange })));
  expect(loadUrbanData).toHaveBeenCalledOnce();
  const latest = () => onChange.mock.calls.at(-1)![0]!;
  expect(latest().data.sceneId).toBe(scene.id);
  expect(latest().traffic.unserved).toBe(0);
  const scenario = [...container.querySelectorAll('select')].find(s => s.querySelector('option[value=diversion]'))!;
  await act(async () => { scenario.value = 'diversion'; scenario.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(latest().options.selectedRoad).toBe('way/1');
  expect(latest().traffic.unserved).toBe(latest().traffic.trips);
  expect(container.textContent).toContain('Unroutable trips/h');
  const pause = [...container.querySelectorAll('button')].find(b => b.textContent === 'Pause traffic')!;
  await act(async () => pause.click());
  expect(latest().options.playing).toBe(false);
  await act(async () => root.render(null));
  expect(onChange.mock.calls.at(-1)![0]).toBeNull();
});

it('shows a fetch failure and retries without substituting invented city data', async () => {
  vi.mocked(loadUrbanData).mockRejectedValueOnce(new Error('Overpass unavailable')).mockResolvedValueOnce(fixture);
  await act(async () => root.render(createElement(UrbanPanel, { scene, onChange: vi.fn() })));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Overpass unavailable');
  expect(container.querySelector('table')).toBeNull();
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  expect(loadUrbanData).toHaveBeenCalledTimes(2);
  expect(container.querySelector('table')).not.toBeNull();
});

it('aborts requests on unmount and ignores a response that arrives after cancellation', async () => {
  let finish!: (data: UrbanData) => void;
  vi.mocked(loadUrbanData).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onChange = vi.fn();
  await act(async () => root.render(createElement(UrbanPanel, { scene, onChange })));
  const signal = vi.mocked(loadUrbanData).mock.calls[0][1];
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(fixture));
  expect(onChange.mock.calls.every(([state]) => state === null)).toBe(true);
});
