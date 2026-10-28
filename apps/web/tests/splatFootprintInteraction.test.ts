// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanvasAndScene } from '../src/App';
import { IDLE_COMPARE, type MapScene } from '../src/app/MapScene';
import { SKYFALL_SCENES, selectionBounds } from '../src/data/splatScenes';
import { createCamera } from '../src/map/MapCamera';
import { SplatView } from '../src/splat/SplatView';
import { Map3DView } from '../src/map/Map3DView';
import { PlaceSearch } from '../src/ui/PlaceSearch';

vi.mock('../src/map/Basemap', () => ({ Basemap: () => null, BASEMAP_ATTRIBUTION: 'Esri' }));
vi.mock('../src/globe/GlobeView', () => ({ GlobeView: () => null }));
vi.mock('../src/map/Map3DView', () => ({ Map3DView: vi.fn(() => createElement('div', { className: 'test-map-3d' })) }));
vi.mock('../src/splat/SplatView', () => ({ SplatView: vi.fn(({ onClose }: { onClose: () => void }) => createElement('button', { onClick: () => onClose(), className: 'test-close' }, 'Return')) }));
vi.mock('../src/ui/PlaceSearch', () => ({ PlaceSearch: vi.fn(() => null), zoomForKind: () => 16 }));

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
    setView: vi.fn((center, zoom) => { view = { ...view, camera: createCamera(center, zoom) }; listeners.forEach(cb => cb()); }),
    viewBounds: vi.fn(() => selectionBounds(view.camera, viewport, { x: 0, y: 0 }, { x: 1024, y: 768 })),
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
const toggle = '[aria-label="3D Footprints"]';


const mapProps = () => vi.mocked(Map3DView).mock.calls.at(-1)![0];
const splatProps = () => vi.mocked(SplatView).mock.calls.at(-1)![0];
const entry = { center: target.center, zoom: 17, orientation: { azimuth: 37, elevation: -42 } };
async function open() { await act(async () => mapProps().onOpenFootprint?.(target, entry)); }

it('starts in continuous navigation without a view switch or interactive 2D layer', () => {
  expect(vi.mocked(scene.resize).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(scene.viewBounds).mock.invocationCallOrder[0]);
  expect(mapProps()).toMatchObject({ bounds: scene.viewBounds(), center: scene.camera.center, orbit: { x: 0, y: 0 } });
  expect(container.querySelector('[role="switch"][aria-label="3D view"]')).toBeNull();
  expect(container.querySelector('.map-view-2d')?.getAttribute('inert')).not.toBeNull();
  expect(container.querySelector('.map-view-2d')?.classList.contains('inactive')).toBe(true);
  expect(container.textContent).toContain('zoom out to Earth');
  expect(SplatView).not.toHaveBeenCalled();
});

it('keeps coverage in the same map renderer', async () => {
  const bounds = mapProps().bounds;
  await click(toggle);
  expect(mapProps().showFootprints).toBe(true);
  expect(mapProps().bounds).toBe(bounds);
  await click(toggle);
  expect(mapProps().showFootprints).toBe(false);
});

it('keeps the geographic camera while zooming out to Earth and back', async () => {
  const initial = mapProps();
  for (const zoom of [12, 8, 5, 2, 5, 8, 12, 17]) {
    await act(async () => mapProps().onViewChange?.({ ...entry, zoom }));
    expect(mapProps().bounds).toBe(initial.bounds);
    expect(mapProps().center).toBe(initial.center);
    expect(container.querySelector('.test-map-3d')).not.toBeNull();
  }
  expect(scene.setView).not.toHaveBeenCalled();
});

it('preserves the live camera and old map until the selected scene is rendered', async () => {
  await open();
  expect(scene.setView).toHaveBeenLastCalledWith(entry.center, entry.zoom);
  expect(splatProps()).toMatchObject({ sceneMeta: target, entryBounds: scene.viewBounds(), entryOrientation: entry.orientation });
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
  await act(async () => splatProps().onReady?.());
  expect(container.querySelector('.test-map-3d')).toBeNull();
  expect(container.querySelector('.map-view-2d')?.classList.contains('inactive')).toBe(true);
});

it('keeps the original camera when returning before the selected scene is ready', async () => {
  const initial = mapProps();
  await open(); await click('.test-close');
  expect(container.querySelector('.test-close')).toBeNull();
  expect(mapProps().bounds).toBe(initial.bounds);
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
});

it('returns to the current scene camera and holds the scene until the map has rendered', async () => {
  await open(); await act(async () => splatProps().onReady?.());
  const moved = { center: { lon: target.center.lon + .001, lat: target.center.lat + .002 }, zoom: 18.25,
    orientation: { azimuth: 71, elevation: -28 } };
  await act(async () => splatProps().onClose(moved));
  expect(mapProps()).toMatchObject({ center: moved.center, bounds: scene.viewBounds(), orientation: moved.orientation, orbit: { x: 0, y: 0 } });
  expect(container.querySelector('.test-close')).not.toBeNull();
  await act(async () => mapProps().onReady?.());
  expect(container.querySelector('.test-close')).toBeNull();
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
  expect(container.querySelector('[role="switch"]')).toBeNull();
});

it('does not leave continuous navigation on Escape', async () => {
  const initial = mapProps();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(mapProps().bounds).toBe(initial.bounds);
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
});

it('flies search results into the continuous map', async () => {
  await act(async () => mapProps().onViewChange?.(entry));
  const place = { name: 'Test place', context: '', kind: 'city', lon: 77.2, lat: 28.6, bounds: null };
  await act(async () => vi.mocked(PlaceSearch).mock.calls.at(-1)![0].onPick(place));
  expect(mapProps().center).toEqual({ lon: place.lon, lat: place.lat });
  expect(mapProps().orientation).toEqual(entry.orientation);
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
});

it('keeps native scene selection available without exposing 2D while loading', async () => {
  await act(async () => {
    const select = container.querySelector('[aria-label="Choose 3D scene"]') as HTMLSelectElement;
    select.value = target.id; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(splatProps().sceneMeta).toBe(target);
  expect(splatProps().entryOrientation).toEqual({ azimuth: 0, elevation: -90 });
  expect(container.querySelector('.test-map-3d')).not.toBeNull();
});
