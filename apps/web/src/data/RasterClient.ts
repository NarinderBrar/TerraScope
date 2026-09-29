/**
 * Raster service client.
 *
 * Every request is a POST of a *descriptor* -- identifiers plus a tile
 * coordinate -- and the response is binary EOT1. The client never accepts a URL
 * from the caller and never constructs one from unvalidated input: that
 * constraint belongs here as well as on the server, so a future caller cannot
 * turn the service into a fetch proxy.
 *
 * Requests are bounded by a concurrency limit. A panned map issues a burst of
 * tile requests, and without a cap a single fast pan will open thirty sockets
 * and starve the ones the user is actually looking at.
 */

import { MAX_TILE_BYTES, decode } from './eot1';
import type {
  DatasetConfig,
  HealthResponse,
  NumericTile,
  SceneDetail,
  SearchRequest,
  SearchResponse,
  RegionStatsRequest,
  RegionStatsResponse,
} from '@terrascope/contracts';

export const DEFAULT_BASE_URL = '/raster';

export interface TileDescriptor {
  collection: string;
  itemId: string;
  profile: string;
  z: number;
  x: number;
  y: number;
  qualityMask?: boolean;
}

export class RasterError extends Error {
  override readonly name = 'RasterError';
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface RasterMetrics {
  requests: number;
  downloadedBytes: number;
  decodeMs: number;
  edgeHits: number;
  r2Hits: number;
  misses: number;
}

export class RasterClient {
  readonly baseUrl: string;

  #inFlight = new Map<string, Promise<NumericTile>>();
  #active = 0;
  #queue: Array<() => void> = [];
  #maxConcurrent: number;
  #metrics: RasterMetrics = { requests: 0, downloadedBytes: 0, decodeMs: 0, edgeHits: 0, r2Hits: 0, misses: 0 };

  constructor(baseUrl: string = DEFAULT_BASE_URL, maxConcurrent = 6) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#maxConcurrent = maxConcurrent;
  }

  /** Number of requests currently in flight. Exposed for the status readout. */
  get inFlightCount(): number {
    return this.#active;
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  get metrics(): Readonly<RasterMetrics> {
    return { ...this.#metrics };
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.#fetchJson<HealthResponse>('/api/health', 'GET', signal);
  }

  /** Collections, profiles, bands, and the calibration in force. */
  async config(signal?: AbortSignal): Promise<DatasetConfig> {
    return this.#fetchJson<DatasetConfig>('/api/config', 'GET', signal);
  }

  async search(body: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    return this.#fetchJson<SearchResponse>('/api/scenes/search', 'POST', signal, body);
  }

  async scene(collection: string, itemId: string, signal?: AbortSignal): Promise<SceneDetail> {
    return this.#fetchJson<SceneDetail>(
      `/api/scenes/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}`,
      'GET',
      signal,
    );
  }

  async regionStats(body: RegionStatsRequest, signal?: AbortSignal): Promise<RegionStatsResponse> {
    return this.#fetchJson<RegionStatsResponse>('/api/analysis/region', 'POST', signal, body);
  }

  /**
   * Output pixel size at a latitude and zoom.
   *
   * The UI shows this next to the sensor's native GSD, so zooming in past the
   * native resolution is visibly a resample rather than a gain in detail.
   */
  async groundResolution(
    lat: number,
    z: number,
    signal?: AbortSignal,
  ): Promise<{ groundResolutionM: number; z: number; lat: number }> {
    const query = new URLSearchParams({ lat: String(lat), z: String(z) });
    return this.#fetchJson(`/api/ground-resolution?${query}`, 'GET', signal);
  }

  /**
   * Fetch one tile.
   *
   * Concurrent requests for the same key share a single promise. A pan that
   * sweeps back and forth over the same tiles would otherwise re-fetch work
   * that is already in flight.
   */
  async tile(descriptor: TileDescriptor, options: RequestOptions = {}): Promise<NumericTile> {
    const key = `${descriptor.collection}/${descriptor.itemId}/${descriptor.profile}/${descriptor.z}/${descriptor.x}/${descriptor.y}/${descriptor.qualityMask === false ? 'raw' : 'masked'}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;

    const promise = this.#schedule(key, options.signal);
    this.#inFlight.set(key, promise);
    // Clear the entry on settle, but only if it is still ours: a later request
    // for the same key must not be evicted by an earlier one's cleanup.
    void promise.catch(() => undefined).finally(() => {
      if (this.#inFlight.get(key) === promise) this.#inFlight.delete(key);
    });
    return promise;
  }

  #schedule(key: string, signal: AbortSignal | undefined): Promise<NumericTile> {
    const descriptor = descriptorFromKey(key);
    return new Promise<NumericTile>((resolve, reject) => {
      let queued = false;
      const abortQueued = (): void => {
        if (!queued) return;
        const index = this.#queue.indexOf(start);
        if (index >= 0) this.#queue.splice(index, 1);
        queued = false;
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      const start = async (): Promise<void> => {
        queued = false;
        signal?.removeEventListener('abort', abortQueued);
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        this.#active += 1;
        try {
          const response = await fetch(
            `${this.baseUrl}/api/tiles/${encodeURIComponent(descriptor.collection)}` +
              `/${encodeURIComponent(descriptor.itemId)}` +
              `/${descriptor.z}/${descriptor.x}/${descriptor.y}` +
              `?profile=${encodeURIComponent(descriptor.profile)}` +
              `&qualityMask=${descriptor.qualityMask === false ? 'false' : 'true'}`,
            { headers: { accept: 'application/x-eot1' }, signal },
          );
          if (!response.ok) {
            throw new RasterError(
              `tile request failed with ${response.status}`,
              response.status,
              await response.text().catch(() => undefined),
            );
          }
          this.#metrics.requests += 1;
          const cache = response.headers.get('x-terrascope-cache');
          if (cache === 'edge') this.#metrics.edgeHits += 1;
          else if (cache === 'r2') this.#metrics.r2Hits += 1;
          else this.#metrics.misses += 1;
          const buffer = await response.arrayBuffer();
          this.#metrics.downloadedBytes += buffer.byteLength;
          if (buffer.byteLength > MAX_TILE_BYTES) {
            throw new RasterError(
              `tile is ${buffer.byteLength}B, over the ${MAX_TILE_BYTES}B cap`,
              502,
            );
          }
          const decodeStarted = performance.now();
          const decoded = decode(buffer);
          this.#metrics.decodeMs += performance.now() - decodeStarted;
          resolve(decoded);
        } catch (error) {
          reject(error);
        } finally {
          this.#active -= 1;
          const next = this.#queue.shift();
          next?.();
        }
      };

      if (this.#active < this.#maxConcurrent) {
        void start();
      } else {
        queued = true;
        this.#queue.push(start);
        if (signal?.aborted) abortQueued();
        else signal?.addEventListener('abort', abortQueued, { once: true });
      }
    });
  }

  async #fetchJson<T>(
    path: string,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = await response.json() as { detail?: string; error?: string };
        detail = payload.detail ?? payload.error;
      } catch {
        detail = await response.text().catch(() => undefined);
      }
      throw new RasterError(detail ?? `request to ${path} failed with ${response.status}`, response.status, detail);
    }
    return (await response.json()) as T;
  }
}

function descriptorFromKey(key: string): TileDescriptor {
  const [collection, itemId, profile, zs, xs, ys, quality] = key.split('/');
  return {
    collection,
    itemId,
    profile,
    z: Number(zs),
    x: Number(xs),
    y: Number(ys),
    qualityMask: quality !== 'raw',
  };
}
