import { closeDecodedChunk, type DecodedSogChunk } from './sogChunk';

export class SplatWorkerClient {
  private sequence = 0;
  private closed = false;
  private jobs = new Map<number, { resolve: (chunk: DecodedSogChunk) => void; reject: (error: unknown) => void; clean: () => void }>();
  constructor(private worker = new Worker(new URL('./splat.worker.ts', import.meta.url), { type: 'module' })) {
    worker.onmessage = ({ data }: MessageEvent<{ id: number; type: string; chunk?: DecodedSogChunk; message?: string }>) => {
      const job = this.jobs.get(data.id);
      if (!job) { if (data.chunk) closeDecodedChunk(data.chunk); return; }
      this.jobs.delete(data.id);
      job.clean();
      if (data.type === 'loaded' && data.chunk) job.resolve(data.chunk);
      else job.reject(new Error(data.message ?? 'Splat decoding failed'));
    };
    worker.onerror = (event) => { event.preventDefault(); this.fail(new Error('The splat loading worker stopped unexpectedly.')); };
    worker.onmessageerror = () => this.fail(new Error('Unable to transfer decoded splat data.'));
  }
  load(url: string, signal: AbortSignal): Promise<DecodedSogChunk> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('The splat loading worker is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.jobs.delete(id);
        signal.removeEventListener('abort', abort);
        try { this.worker.postMessage({ id, type: 'cancel' }); }
        catch { /* A stopped worker has no remaining request to cancel. */ }
        finally { reject(signal.reason); }
      };
      this.jobs.set(id, { resolve, reject, clean: () => signal.removeEventListener('abort', abort) });
      signal.addEventListener('abort', abort, { once: true });
      try { this.worker.postMessage({ id, type: 'load', url }); }
      catch (error) {
        this.jobs.delete(id);
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    });
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const job of this.jobs.values()) { job.clean(); job.reject(error); }
    this.jobs.clear();
    this.worker.terminate();
  }
  destroy(): void { if (!this.closed) this.fail(new DOMException('Splat loading cancelled', 'AbortError')); }
}
