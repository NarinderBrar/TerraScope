// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplatView } from '../src/splat/SplatView';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { createSplatSession } from '../src/splat/session';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('../src/splat/session', () => ({ createSplatSession: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
const session = { dispose: vi.fn(), reset: vi.fn(), reloadMap: vi.fn(), setMapVisible: vi.fn(), retryDetail: vi.fn(), setSegmentedEnabled: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = `public/semantics/${url.split('/').at(-1)}`;
    return existsSync(path) ? new Response(readFileSync(path, 'utf8')) : new Response('', { status: 404 });
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Flush the lazy session import and the mocked load without timers or real GPU access.
async function settle() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

describe('map-aligned scene lifecycle', () => {
  it('holds the 3D handoff through loading and failure, then presents an opaque frame on retry', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(createSplatSession).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const scene = SKYFALL_SCENES[0], onReady = vi.fn();
    await act(async () => root.render(createElement(SplatView, {
      active: true, sceneMeta: scene, entryBounds: scene.bounds,
      entryOrientation: { azimuth: 37, elevation: -42 }, onReady, onClose: vi.fn(),
    })));
    await settle();
    expect(onReady).not.toHaveBeenCalled();
    expect(container.querySelector('.splat-canvas')?.classList.contains('ready')).toBe(false);
    await act(async () => reject(new Error('Tile load failed')));
    expect(onReady).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    vi.mocked(createSplatSession).mockResolvedValue(session);
    await act(async () => (container.querySelector('[role="alert"] button') as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector('.splat-canvas.from-3d.ready')).not.toBeNull();
    expect(onReady).toHaveBeenCalledOnce();
  });
  it('passes the 3D entry orientation to the scene session', async () => {
    vi.mocked(createSplatSession).mockResolvedValue(session);
    const scene = SKYFALL_SCENES[0];
    const entryOrientation = { azimuth: 37, elevation: -42 };
    await act(async () => root.render(createElement(SplatView, {
      active: true, sceneMeta: scene, entryBounds: scene.bounds, entryOrientation, onClose: vi.fn(),
    })));
    await settle();
    expect(vi.mocked(createSplatSession).mock.calls[0][8]).toEqual(entryOrientation);
  });
  it('disables segmented view when classifications are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    vi.mocked(createSplatSession).mockResolvedValue(session);
    const scene = SKYFALL_SCENES[0];
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn() })));
    await settle();
    expect((container.querySelector('[role="switch"]') as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('Classifications unavailable');
  });
  it('docks scene controls on the right without a 2D/3D switch', async () => {
    const view = { center: { lon: -73.99, lat: 40.73 }, zoom: 17 };
    vi.mocked(createSplatSession).mockResolvedValue({ ...session, getMapView: () => view });
    const scene = SKYFALL_SCENES.find(s => s.id === 'NYC_010')!, onClose = vi.fn();
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose })));
    await settle();
    const panel = container.querySelector('.splat-right-panel')!;
    expect(panel.textContent).toContain(scene.name); expect(panel.textContent).not.toContain('Reset view');
    expect(panel.textContent).not.toContain('Urban Lab');
    expect(panel.textContent).toContain('Back to Map');
    expect(panel.querySelectorAll('[role="switch"]')).toHaveLength(1);
    await act(async () => (panel.querySelector('button.primary') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledWith(view);
  });
  it('returns the current camera to the map through Back to Map and Escape', async () => {
    const view = { center: { lon: -73.99, lat: 40.73 }, zoom: 18,
      orientation: { azimuth: 71, elevation: -28 } };
    vi.mocked(createSplatSession).mockResolvedValue({ ...session, getMapView: () => view });
    const scene = SKYFALL_SCENES[0], onClose = vi.fn();
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose })));
    await settle();
    await act(async () => (container.querySelector('button.primary') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenLastCalledWith(view);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenLastCalledWith(view);
  });
  it.each(SKYFALL_SCENES)('toggles all classifications for $id without restarting the session or camera', async (scene) => {
    vi.mocked(createSplatSession).mockResolvedValue(session);
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn() })));
    await settle();
    const toggle = container.querySelector('[role="switch"]') as HTMLInputElement;
    expect(toggle.disabled).toBe(false); expect(toggle.checked).toBe(false);
    expect(container.querySelector('select')).toBeNull();
    await act(async () => vi.mocked(createSplatSession).mock.calls[0][5]('ready'));
    await act(async () => toggle.click());
    expect(session.setSegmentedEnabled).toHaveBeenLastCalledWith(true);
    expect(toggle.checked).toBe(true);
    expect(container.querySelector('.splat-map-toggle')?.textContent).toContain('Dark vector map');
    expect(container.querySelector('.splat-map-attribution')?.textContent).toContain('OpenStreetMap contributors');
    expect(container.querySelector('[aria-label="Segment colours"]')).not.toBeNull();
    expect(container.textContent).toContain('Not detected:');
    expect(container.textContent).toContain('AC units');
    await act(async () => toggle.click());
    expect(session.setSegmentedEnabled).toHaveBeenLastCalledWith(false);
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('.splat-map-toggle')?.textContent).toContain('Satellite map');
    expect(container.querySelector('[aria-label="Segment colours"]')).toBeNull();
    expect(session.reset).not.toHaveBeenCalled();
    expect(createSplatSession).toHaveBeenCalledOnce();
  });
  it('keeps normal colours after a failed segment load and allows retry', async () => {
    session.setSegmentedEnabled.mockRejectedValueOnce(new Error('Download failed'));
    vi.mocked(createSplatSession).mockResolvedValue(session);
    const scene = SKYFALL_SCENES[0];
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn() })));
    await settle();
    const toggle = container.querySelector('[role="switch"]') as HTMLInputElement;
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false); expect(toggle.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Download failed');
    expect(container.querySelector('.splat-map-toggle')?.textContent).toContain('Satellite map');
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
  });
  it('keeps the coarse viewer interactive while refinement runs and fails', async () => {
    vi.mocked(createSplatSession).mockResolvedValue(session);
    const scene = SKYFALL_SCENES[0];
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn() })));
    await settle();
    const call = vi.mocked(createSplatSession).mock.calls[0];
    await act(async () => { call[5]('ready'); call[7]!({ loaded: 1, pending: 2, failed: 0, bestLod: 3 }); });
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
    expect(container.querySelector('.splat-message[role=status]')).toBeNull();
    expect(container.querySelector('.splat-detail-status')?.textContent).toContain('LOD 3');
    expect(container.querySelector('.splat-detail-status')?.textContent).toContain('Refining');
    await act(async () => call[7]!({ loaded: 1, pending: 0, failed: 1, bestLod: 3 }));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
    await act(async () => (container.querySelector('.splat-detail-status button') as HTMLButtonElement).click());
    expect(session.retryDetail).toHaveBeenCalledOnce();
    await act(async () => call[7]!({ loaded: 3, pending: 0, failed: 0, bestLod: 1 }));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-splat-lod')).toBe('1');
  });
  it.each(SKYFALL_SCENES)('reveals coarse splats for $id while aligned imagery is still loading', async (scene) => {
    vi.mocked(createSplatSession).mockResolvedValue(session);
    await act(async () => root.render(createElement(SplatView, {
      active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn(),
    })));
    await settle();
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
    expect(container.querySelector('.splat-canvas')?.classList.contains('ready')).toBe(true);
    expect(container.querySelector('[data-map-status]')?.getAttribute('data-map-status')).toBe('loading');
    expect(container.querySelector('.splat-map-toggle')).not.toBeNull();
    await act(async () => vi.mocked(createSplatSession).mock.calls[0][5]('ready'));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
    expect(container.querySelector('[data-map-status]')?.getAttribute('data-map-status')).toBe('ready');
  });

  it('keeps the map visible until coarse loading completes, even if imagery arrives first', async () => {
    let complete!: (value: typeof session) => void;
    vi.mocked(createSplatSession).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const scene = SKYFALL_SCENES[0];
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn() })));
    await settle();
    await act(async () => vi.mocked(createSplatSession).mock.calls[0][5]('ready'));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('false');
    await act(async () => complete(session));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
  });

  it('aborts an unfinished aligned scene and disposes its eventual session', async () => {
    let complete!: (value: typeof session) => void;
    vi.mocked(createSplatSession).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => root.render(createElement(SplatView, { active: true, sceneMeta: SKYFALL_SCENES[0], entryBounds: SKYFALL_SCENES[0].bounds, onClose: vi.fn() })));
    await settle();
    const signal = vi.mocked(createSplatSession).mock.calls[0][2];
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => complete(session));
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
