import { Container, getRandom } from '@cloudflare/containers';

const MAX_JSON_BODY = 64 * 1024;
const MAX_TILE_BODY = 8 * 1024 * 1024;
const TILE_PATH = /^\/api\/tiles\/[^/]+\/[^/]+\/\d+\/\d+\/\d+$/;

export class RasterContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;
  pingEndpoint = '/api/health';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const incoming = new URL(request.url);
    try {
      if (!incoming.pathname.startsWith('/raster/api/')) return secure(await env.ASSETS.fetch(request));
      if (request.method !== 'GET' && request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405, { allow: 'GET, POST' });
      }
      const length = Number(request.headers.get('content-length') ?? 0);
      if (request.method === 'POST' && (!Number.isFinite(length) || length > MAX_JSON_BODY)) {
        return json({ error: 'request body too large' }, 413);
      }

      const upstreamUrl = new URL(request.url);
      upstreamUrl.pathname = incoming.pathname.slice('/raster'.length);
      const upstreamRequest = new Request(upstreamUrl, request);
      const tileRequest = request.method === 'GET' && TILE_PATH.test(upstreamUrl.pathname);
      const cacheRequest = new Request(request.url, { method: 'GET' });

      if (tileRequest) {
        const edgeHit = await caches.default.match(cacheRequest);
        if (edgeHit) return secure(withCache(edgeHit, 'edge'));
        const key = tileKey(upstreamUrl);
        const stored = await env.TILE_CACHE.get(key);
        if (stored?.body) {
          const headers = new Headers();
          stored.writeHttpMetadata(headers);
          headers.set('etag', stored.httpEtag);
          headers.set('x-terrascope-cache', 'r2');
          const response = new Response(stored.body, { headers });
          ctx.waitUntil(caches.default.put(cacheRequest, response.clone()));
          return secure(response);
        }
      }

      const container = await getRandom(env.RASTER_CONTAINER, 3);
      const upstream = await container.fetch(upstreamRequest);
      if (!tileRequest || !upstream.ok || !upstream.body) return secure(upstream);
      const responseLength = Number(upstream.headers.get('content-length') ?? 0);
      if (!Number.isFinite(responseLength) || responseLength <= 0 || responseLength > MAX_TILE_BODY) {
        return json({ error: 'invalid raster response size' }, 502);
      }
      const [toClient, toR2] = upstream.body.tee();
      const headers = new Headers(upstream.headers);
      headers.set('x-terrascope-cache', 'miss');
      const response = new Response(toClient, { status: upstream.status, headers });
      const key = tileKey(upstreamUrl);
      ctx.waitUntil(Promise.all([
        env.TILE_CACHE.put(key, toR2, {
          httpMetadata: { contentType: upstream.headers.get('content-type') ?? 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' },
          customMetadata: { processingVersion: upstream.headers.get('x-eot-version') ?? 'unknown' },
        }),
        caches.default.put(cacheRequest, response.clone()),
      ]).then(() => undefined));
      return secure(response);
    } catch (error) {
      console.error(JSON.stringify({ message: 'request failed', path: incoming.pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'service temporarily unavailable' }, 503, { 'retry-after': '5' });
    } finally {
      console.log(JSON.stringify({ message: 'request', method: request.method, path: incoming.pathname, durationMs: Date.now() - started }));
    }
  },
} satisfies ExportedHandler<Env>;

function tileKey(url: URL): string {
  const query: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => query.push([key, value]));
  query.sort(([a], [b]) => a.localeCompare(b));
  return `eot-1${url.pathname}?${new URLSearchParams(query).toString()}`;
}

function withCache(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-terrascope-cache', value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return secure(Response.json(body, { status, headers: { ...extra, 'cache-control': 'no-store' } }));
}
