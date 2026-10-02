/** A small, abortable priority queue for raster work. Lower scores run first. */

export interface ScheduledRequest {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<void>;
}

interface QueueEntry extends ScheduledRequest {
  sequence: number;
}

export class TileRequestScheduler {
  readonly maxConcurrent: number;

  #queued = new Map<string, QueueEntry>();
  #active = new Map<string, AbortController>();
  #sequence = 0;

  constructor(maxConcurrent = 6) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    this.maxConcurrent = maxConcurrent;
  }

  get size(): number {
    return this.#queued.size + this.#active.size;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#queued.size;
  }

  has(key: string): boolean {
    return this.#queued.has(key) || this.#active.has(key);
  }

  enqueue(request: ScheduledRequest): void {
    if (this.#active.has(request.key)) return;
    const existing = this.#queued.get(request.key);
    if (existing) {
      existing.priority = request.priority;
      existing.run = request.run;
    } else {
      this.#queued.set(request.key, { ...request, sequence: this.#sequence++ });
    }
    this.#pump();
  }

  cancel(key: string): void {
    this.#queued.delete(key);
    this.#active.get(key)?.abort();
  }

  cancelExcept(keys: ReadonlySet<string>): void {
    for (const key of this.#queued.keys()) if (!keys.has(key)) this.#queued.delete(key);
    for (const [key, controller] of this.#active) if (!keys.has(key)) controller.abort();
  }

  clear(): void {
    this.#queued.clear();
    for (const controller of this.#active.values()) controller.abort();
  }

  #pump(): void {
    while (this.#active.size < this.maxConcurrent && this.#queued.size > 0) {
      let next: QueueEntry | undefined;
      for (const entry of this.#queued.values()) {
        if (!next || entry.priority < next.priority ||
          (entry.priority === next.priority && entry.sequence < next.sequence)) next = entry;
      }
      if (!next) return;
      this.#queued.delete(next.key);
      const controller = new AbortController();
      this.#active.set(next.key, controller);
      void next.run(controller.signal).catch(() => undefined).finally(() => {
        if (this.#active.get(next!.key) === controller) this.#active.delete(next!.key);
        this.#pump();
      });
    }
  }
}
