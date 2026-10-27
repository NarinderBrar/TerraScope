// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createGraphicsDevice } from 'playcanvas';
import { createSplatSession } from '../src/splat/session';
import { SKYFALL_SCENES } from '../src/data/splatScenes';

vi.mock('playcanvas', async (original) => ({ ...await original<typeof import('playcanvas')>(), createGraphicsDevice: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('starts fetching the index during GPU initialization and cancels it if initialization fails', async () => {
  let rejectDevice!: (reason: unknown) => void;
  vi.mocked(createGraphicsDevice).mockImplementation(() => new Promise((_, reject) => { rejectDevice = reject; }));
  const fetcher = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetcher);
  const scene = SKYFALL_SCENES[0];
  const loading = createSplatSession(document.createElement('canvas'), scene, new AbortController().signal,
    vi.fn(), vi.fn(), vi.fn(), scene.bounds);
  const failed = expect(loading).rejects.toThrow('GPU initialization failed');
  expect(createGraphicsDevice).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toContain('/streamed/');
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  rejectDevice(new Error('GPU initialization failed'));
  await failed;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
