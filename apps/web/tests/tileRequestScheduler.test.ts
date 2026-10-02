import { describe, expect, it } from 'vitest';
import { TileRequestScheduler } from '../src/map/TileRequestScheduler';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TileRequestScheduler', () => {
  it('caps concurrency and runs queued work by score', async () => {
    const scheduler = new TileRequestScheduler(2);
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const add = (key: string, priority: number): void => scheduler.enqueue({
      key,
      priority,
      run: () => new Promise<void>((resolve) => {
        started.push(key);
        releases.push(resolve);
      }),
    });

    add('active-a', 10);
    add('active-b', 10);
    add('last', 30);
    add('first', 1);
    expect(started).toEqual(['active-a', 'active-b']);
    expect(scheduler.activeCount).toBe(2);

    releases.shift()!();
    await tick();
    expect(started).toEqual(['active-a', 'active-b', 'first']);
    releases.shift()!();
    await tick();
    expect(started).toEqual(['active-a', 'active-b', 'first', 'last']);
  });

  it('cancels queued and active work outside the wanted set', async () => {
    const scheduler = new TileRequestScheduler(1);
    let activeAborted = false;
    let queuedStarted = false;
    scheduler.enqueue({
      key: 'active', priority: 0,
      run: (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        activeAborted = true;
        resolve();
      })),
    });
    scheduler.enqueue({ key: 'obsolete', priority: 1, run: async () => { queuedStarted = true; } });
    scheduler.enqueue({ key: 'kept', priority: 2, run: async () => undefined });

    scheduler.cancelExcept(new Set(['kept']));
    await tick();
    expect(activeAborted).toBe(true);
    expect(queuedStarted).toBe(false);
    expect(scheduler.has('obsolete')).toBe(false);
  });

  it('deduplicates keys and accepts a queued priority update', async () => {
    const scheduler = new TileRequestScheduler(1);
    let release!: () => void;
    const started: string[] = [];
    scheduler.enqueue({ key: 'block', priority: 0, run: () => new Promise<void>((resolve) => { release = resolve; }) });
    scheduler.enqueue({ key: 'same', priority: 50, run: async () => { started.push('old'); } });
    scheduler.enqueue({ key: 'other', priority: 10, run: async () => { started.push('other'); } });
    scheduler.enqueue({ key: 'same', priority: 1, run: async () => { started.push('same'); } });
    expect(scheduler.queuedCount).toBe(2);
    release();
    await tick();
    await tick();
    expect(started).toEqual(['same', 'other']);
  });
});
