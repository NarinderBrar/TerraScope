import { describe, expect, it, vi } from 'vitest';
import { GroundTileStream } from '../src/splat/GroundTileStream';
import { groundTileKey, type GroundTile } from '../src/splat/groundTilePlan';

const tile: GroundTile = { z: 18, x: 71570, y: 107850 };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('streaming imagery residency', () => {
  it('loads overview and parents before detail and uses them until detail is available', async () => {
    const requests: { tile: GroundTile; finish: (value: string) => void }[] = [];
    const release = vi.fn();
    const changed = vi.fn();
    const stream = new GroundTileStream<string>((tile) => new Promise((finish) => requests.push({ tile, finish })), release, changed, 256, 1);
    stream.setTiles([tile]);
    expect(requests[0].tile.z).toBe(0);
    expect(stream.find(tile)).toBeUndefined();
    requests[0].finish('overview');
    await settle();
    expect(stream.find(tile)?.value).toBe('overview');
    expect(requests[1].tile.z).toBe(14);
    requests[1].finish('parent');
    await settle();
    expect(stream.find(tile)?.value).toBe('parent');
    expect(requests[2].tile).toEqual(tile);
    requests[2].finish('detail');
    await settle();
    expect(stream.find(tile)?.value).toBe('detail');
    expect(stream.pending).toBe(false);
    stream.dispose();
    expect(release.mock.calls.flat().sort()).toEqual(['detail', 'overview', 'parent']);
  });
  it('aborts stale requests and disposes a resource that completes after cancellation', async () => {
    const requests: { signal: AbortSignal; finish: (value: string) => void }[] = [];
    const release = vi.fn();
    const stream = new GroundTileStream<string>((_, signal) => new Promise((finish) => requests.push({ signal, finish })), release, vi.fn(), 256, 1);
    stream.setTiles([tile]);
    stream.setTiles([]);
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].finish('stale');
    await settle();
    expect(release).toHaveBeenCalledWith('stale');
    expect(stream.find(tile)).toBeUndefined();
    stream.dispose();
  });
  it('keeps concurrency and residency bounded while travelling and reuses loaded coverage', async () => {
    const alive = new Set<string>();
    const release = vi.fn((key: string) => { alive.delete(key); });
    let active = 0, peak = 0;
    const load = vi.fn(async (tile: GroundTile) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      const key = groundTileKey(tile);
      alive.add(key);
      return key;
    });
    const stream = new GroundTileStream(load, release, vi.fn(), 8, 2);
    for (let i = 0; i < 25; i++) {
      const current = { ...tile, x: tile.x + i * 32 };
      stream.setTiles([current]);
      await settle();
      expect(stream.find(current)?.tile).toEqual(current);
      expect(alive.size).toBeLessThanOrEqual(8);
      const calls = load.mock.calls.length;
      stream.setTiles([current]);
      await settle();
      expect(load).toHaveBeenCalledTimes(calls);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(release).toHaveBeenCalled();
    stream.dispose();
    stream.dispose();
    expect(alive.size).toBe(0);
  });
  it('backs off failures, permits retry, and disposes pending work safely', async () => {
    const release = vi.fn();
    const changed = vi.fn();
    const load = vi.fn(async () => null as string | null);
    const stream = new GroundTileStream<string>(load, release, changed);
    stream.setTiles([tile]);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    stream.setTiles([tile]);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    load.mockResolvedValue('recovered');
    stream.retry();
    await settle();
    expect(stream.find(tile)?.value).toBe('recovered');
    expect(changed).toHaveBeenCalled();
    stream.dispose();
    expect(release).toHaveBeenCalledTimes(3);
  });
});
