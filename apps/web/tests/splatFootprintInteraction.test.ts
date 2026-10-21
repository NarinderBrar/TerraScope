// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanvasAndScene } from '../src/App';
import { IDLE_COMPARE, type MapScene } from '../src/app/MapScene';
import { SKYFALL_SCENES, selectionBounds } from '../src/data/splatScenes';
import { createCamera, panBy } from '../src/map/MapCamera';
import { SplatView } from '../src/splat/SplatView';
import { lonLatToWorldPx } from '@terrascope/contracts';

vi.mock('../src/map/Basemap', () => ({ Basemap: () => null, BASEMAP_ATTRIBUTION: 'Esri' }));
vi.mock('../src/globe/GlobeView', () => ({ GlobeView: () => null }));
vi.mock('../src/splat/SplatView', () => ({ SplatView: vi.fn(({ onClose }: { onClose: () => void }) => createElement('button', { onClick: onClose, className: 'test-close' }, 'Return')) }));

let container: HTMLDivElement;
let root: Root;
let canvas: HTMLCanvasElement;
let scene: MapScene;
const target = SKYFALL_SCENES[1];
const viewport = { width: 1024, height: 768, dpr: 1 };

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.clearAllMocks();
  let view = { camera: createCamera(target.center, 16), viewport };
  const listeners = new Set<() => void>();
  scene = {
    status: { phase: 'ready', message: 'Ready' }, stats: { failed: 0 }, compare: IDLE_COMPARE, settings: { layer: 'natural' },
    get view() { return view; }, get camera() { return view.camera; },
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    resize: vi.fn(), fitBounds: vi.fn(), zoomAroundPixels: vi.fn(),
    viewBounds: vi.fn(() => selectionBounds(view.camera, viewport, { x: 0, y: 0 }, { x: 1024, y: 768 })),
    panByPixels: vi.fn((dx: number, dy: number) => { view = { ...view, camera: panBy(view.camera, dx, dy) }; listeners.forEach((cb) => cb()); }),
  } as unknown as MapScene;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(CanvasAndScene, { canvasRef: createRef<HTMLCanvasElement>(), scene })));
  canvas = container.querySelector('canvas')!;
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1024, 768);
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  canvas.releasePointerCapture = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(selector: string) {
  await act(async () => (container.querySelector(selector) as HTMLButtonElement).click());
}
async function pointer(type: string, x = 512, y = 384, shiftKey = false) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } });
  await act(async () => canvas.dispatchEvent(event));
}
const toggle = '[aria-label="3D Footprints"]';

it('toggles registered coverage and opens a clicked area using the current map frame', async () => {
  expect(container.querySelector('.splat-footprints')).toBeNull();
  await click(toggle);
  expect(container.querySelector(toggle)?.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector(`[data-scene-id="${target.id}"]`)).not.toBeNull();
  const bounds = scene.viewBounds();
  await pointer('pointerdown');
  await pointer('pointerup');
  expect(vi.mocked(SplatView).mock.calls.at(-1)?.[0]).toMatchObject({ sceneMeta: target, entryBounds: bounds });
  expect(scene.fitBounds).not.toHaveBeenCalled();
  expect(container.querySelector('.splat-footprints')).toBeNull();
  await click('.test-close');
  expect(container.querySelector(toggle)?.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('.splat-footprints')).not.toBeNull();
});

it('preserves map dragging even when a drag returns to its start', async () => {
  await click(toggle);
  await pointer('pointerdown');
  await pointer('pointermove', 570, 420);
  await pointer('pointermove');
  await pointer('pointerup');
  expect(scene.panByPixels).toHaveBeenCalledTimes(2);
  expect(SplatView).not.toHaveBeenCalled();
});

it('opens each of the overlapping East 12th St. and Union Square scenes from its own centre', async () => {
  await click(toggle);
  for (const id of ['NYC_219', 'NYC_010']) {
    const target = SKYFALL_SCENES.find((item) => item.id === id)!;
    const current = lonLatToWorldPx(scene.camera.center, 0), next = lonLatToWorldPx(target.center, 0);
    await act(async () => scene.panByPixels((current.px - next.px) * 2 ** scene.camera.zoom, (current.py - next.py) * 2 ** scene.camera.zoom));
    await pointer('pointermove');
    const highlighted = container.querySelector('.splat-footprint[data-hovered="true"]');
    expect(highlighted?.getAttribute('data-scene-id')).toBe(id);
    expect(container.querySelector('.splat-footprints')?.lastElementChild).toBe(highlighted);
    await pointer('pointerdown');
    await pointer('pointerup');
    expect(vi.mocked(SplatView).mock.calls.at(-1)?.[0].sceneMeta.id).toBe(id);
    await click('.test-close');
  }
});

it.each(['pointercancel', 'lostpointercapture', 'Escape', 'wheel'])('does not open after %s cancels a press', async (cancel) => {
  await click(toggle);
  await pointer('pointerdown');
  if (cancel === 'Escape') await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  else if (cancel === 'wheel') await act(async () => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 })));
  else await pointer(cancel);
  await pointer('pointerup');
  expect(SplatView).not.toHaveBeenCalled();
  if (cancel === 'wheel') expect(scene.zoomAroundPixels).toHaveBeenCalledOnce();
});

it('allows Shift-drag area selection through coverage', async () => {
  await click(toggle);
  await pointer('pointerdown', 500, 380, true);
  await pointer('pointermove', 560, 420, true);
  await pointer('pointerup', 560, 420, true);
  expect(container.querySelector('.aoi-marquee')).not.toBeNull();
  expect(scene.panByPixels).not.toHaveBeenCalled();
  expect(SplatView).not.toHaveBeenCalled();
});

it('provides native keyboard activation and does not activate when coverage is off', async () => {
  await pointer('pointerdown');
  await pointer('pointerup');
  expect(SplatView).not.toHaveBeenCalled();
  await click(toggle);
  const button = container.querySelector(`[data-scene-id="${target.id}"]`)!;
  expect(button.tagName).toBe('BUTTON');
  await click(`[data-scene-id="${target.id}"]`);
  expect(vi.mocked(SplatView).mock.calls.at(-1)?.[0].sceneMeta.id).toBe(target.id);
});
