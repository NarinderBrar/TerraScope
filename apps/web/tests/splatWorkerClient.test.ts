import { describe, expect, it, vi } from 'vitest';
import { SplatWorkerClient } from '../src/splat/SplatWorkerClient';
import type { DecodedSogChunk } from '../src/splat/sogChunk';
function setup() {
  const worker = { onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], onmessageerror: null as Worker['onmessageerror'], postMessage: vi.fn(), terminate: vi.fn() };
  const client = new SplatWorkerClient(worker as unknown as Worker);
  const chunk = { images: [{ name: 'means_l', bitmap: { close: vi.fn() } }], centers: new Float32Array(3) } as unknown as DecodedSogChunk;
  const send = (data: unknown) => worker.onmessage!.call(worker as unknown as Worker, { data } as MessageEvent);
  return { client, worker, chunk, send };
}
describe('splat worker ownership', () => {
  it('receives a transferred chunk without copying its position buffer', async () => {
    const { client, worker, chunk, send } = setup();
    const loaded = client.load('https://models.test/0_0/meta.json', new AbortController().signal);
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, type: 'load', url: 'https://models.test/0_0/meta.json' });
    send({ id: 1, type: 'loaded', chunk });
    expect(await loaded).toBe(chunk);
    expect(chunk.images[0].bitmap.close).not.toHaveBeenCalled();
    client.destroy();
  });
  it('cancels an obsolete request and closes any bitmap arriving after cancellation', async () => {
    const { client, worker, chunk, send } = setup();
    const controller = new AbortController();
    const loaded = client.load('/chunk/meta.json', controller.signal);
    const cancelled = expect(loaded).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, type: 'cancel' });
    send({ id: 1, type: 'loaded', chunk });
    expect(chunk.images[0].bitmap.close).toHaveBeenCalledOnce();
    client.destroy();
  });
  it('rejects every pending job and terminates once on scene close', async () => {
    const { client, worker } = setup();
    const a = expect(client.load('/a/meta.json', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    const b = expect(client.load('/b/meta.json', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    client.destroy(); client.destroy();
    await Promise.all([a, b]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(client.load('/c/meta.json', new AbortController().signal)).rejects.toThrow('closed');
  });
  it('cleans request ownership when posting to a stopped worker throws', async () => {
    const { client, worker, chunk, send } = setup();
    worker.postMessage.mockImplementation(() => { throw new Error('Worker stopped'); });
    await expect(client.load('/a/meta.json', new AbortController().signal)).rejects.toThrow('Worker stopped');
    send({ id: 1, type: 'loaded', chunk });
    expect(chunk.images[0].bitmap.close).toHaveBeenCalledOnce();
    client.destroy();
  });
});
