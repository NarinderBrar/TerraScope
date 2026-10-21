import { describe, expect, it, vi } from 'vitest';
import type { GraphicsDevice, GSplatSogResource } from 'playcanvas';
import { SplatChunkLoader } from '../src/splat/SplatChunkLoader';
import type { SplatWorkerClient } from '../src/splat/SplatWorkerClient';
import type { DecodedSogChunk } from '../src/splat/sogChunk';
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function setup() {
  const requests: { url: string; signal: AbortSignal; resolve: (value: DecodedSogChunk) => void; reject: (error: unknown) => void }[] = [];
  const resources = new Map<string, { destroy: ReturnType<typeof vi.fn> }>();
  const client = { load: vi.fn((url: string, signal: AbortSignal) => new Promise<DecodedSogChunk>((resolve, reject) => requests.push({ url, signal, resolve, reject }))), destroy: vi.fn() };
  const changed = vi.fn();
  const levels = new Map([['coarse-a', 2], ['coarse-b', 2], ['medium', 1], ['fine', 0]]);
  const create = vi.fn(async (_device: GraphicsDevice, url: string) => {
    const resource = { destroy: vi.fn() }; resources.set(url, resource); return resource as unknown as GSplatSogResource;
  });
  const loader = new SplatChunkLoader({} as GraphicsDevice, levels, changed, client as unknown as SplatWorkerClient, create);
  const chunk = { images: [{ bitmap: { close: vi.fn() } }] } as unknown as DecodedSogChunk;
  return { loader, requests, resources, client, changed, chunk, create };
}
describe('progressive spatial splat streaming', () => {
  it('bounds concurrency, honours priorities, and keeps coarse data while finer chunks load', async () => {
    const { loader, requests, resources, changed, chunk } = setup();
    loader.load('coarse-a', 3); loader.load('coarse-b', 3); loader.load('fine', 1); loader.load('medium', 2);
    expect(requests).toHaveLength(2);
    requests[0].resolve(chunk); await settle(); await loader.firstReady;
    expect(requests[2].url).toBe('medium');
    expect(loader.getResource('coarse-a')).toBe(resources.get('coarse-a'));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ bestLod: 3 }));
    requests[2].resolve(chunk); await settle();
    expect(requests[3].url).toBe('fine');
    requests[3].resolve(chunk); requests[1].resolve(chunk); await settle();
    expect(changed).toHaveBeenLastCalledWith({ loaded: 4, pending: 0, failed: 0, bestLod: 1 });
    loader.unload('coarse-a');
    expect(resources.get('coarse-a')!.destroy).toHaveBeenCalledOnce();
    loader.destroy();
    for (const resource of resources.values()) expect(resource.destroy).toHaveBeenCalledOnce();
  });
  it('retains the coarse scene on failed refinement and allows a detail retry', async () => {
    const { loader, requests, resources, chunk, changed } = setup();
    loader.load('coarse-a'); requests[0].resolve(chunk); await settle();
    loader.load('fine');
    for (let i = 1; i <= 3; i++) { requests[i].reject(new Error('Offline')); await settle(); }
    expect(changed).toHaveBeenLastCalledWith({ loaded: 1, pending: 0, failed: 1, bestLod: 3 });
    expect(resources.get('coarse-a')!.destroy).not.toHaveBeenCalled();
    loader.retry();
    requests[4].resolve(chunk); await settle();
    expect(changed).toHaveBeenLastCalledWith({ loaded: 2, pending: 0, failed: 0, bestLod: 1 });
    loader.destroy();
  });
  it('discards late decoded chunks after their region is unloaded', async () => {
    const { loader, requests, chunk, create } = setup();
    loader.load('fine'); loader.unload('fine');
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve(chunk); await settle();
    expect(chunk.images[0].bitmap.close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    loader.destroy();
  });
  it('fails initial readiness when no coarse tile can load', async () => {
    const { loader, requests } = setup();
    const failed = expect(loader.firstReady).rejects.toThrow('Offline');
    loader.load('coarse-a');
    for (let i = 0; i < 3; i++) { requests[i].reject(new Error('Offline')); await settle(); }
    await failed;
    loader.destroy();
  });
  it('reloads a region revisited before its cancelled request settles', async () => {
    const { loader, requests, chunk, resources } = setup();
    loader.load('fine'); loader.unload('fine'); loader.load('fine', 3);
    requests[0].resolve(chunk); await settle();
    expect(requests).toHaveLength(2);
    expect(requests[1].signal.aborted).toBe(false);
    requests[1].resolve(chunk); await settle();
    expect(loader.getResource('fine')).toBe(resources.get('fine'));
    loader.destroy();
  });
});
