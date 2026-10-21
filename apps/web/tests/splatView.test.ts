// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplatView } from '../src/splat/SplatView';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { createSplatSession } from '../src/splat/session';

vi.mock('../src/splat/session', () => ({ createSplatSession: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
const session = { dispose: vi.fn(), reset: vi.fn(), reloadMap: vi.fn(), setMapVisible: vi.fn(), retryDetail: vi.fn() };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
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
  it.each(SKYFALL_SCENES)('waits for aligned imagery before revealing $id', async (scene) => {
    vi.mocked(createSplatSession).mockResolvedValue(session);
    await act(async () => root.render(createElement(SplatView, {
      active: true, sceneMeta: scene, entryBounds: scene.bounds, onClose: vi.fn(),
    })));
    await settle();
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('false');
    expect(container.querySelector('.splat-map-toggle')).not.toBeNull();
    await act(async () => vi.mocked(createSplatSession).mock.calls[0][5]('ready'));
    expect(container.querySelector('.splat-view-direct')?.getAttribute('data-ready')).toBe('true');
    expect(container.querySelector('[data-map-status]')?.getAttribute('data-map-status')).toBe('ready');
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
