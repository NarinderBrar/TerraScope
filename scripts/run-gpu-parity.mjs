/**
 * Run the WebGPU parity suite in a real browser.
 *
 * `tests/parity/gpu-runtime.test.ts` compiles the same harness but under Node,
 * where `navigator.gpu` does not exist, so it skips. This script bundles the
 * harness with the project's real modules -- the production WGSL, bind group
 * layout, uniform packing, and readback path -- and runs it in a headless
 * Chrome, then reports the result. That is what makes the CPU/GPU parity claim
 * in the plan actually tested rather than asserted.
 *
 * Chrome's SwiftShader backend is used, so this works on a machine with no GPU.
 * The arithmetic under test is float32 in every conformant WebGPU
 * implementation, so the backend does not change what is being verified.
 *
 *   node scripts/run-gpu-parity.mjs
 *
 * Overridable: CHROME, CDP_PORT, GPU_TIMEOUT_MS.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const harness = join(repo, 'apps/web/tests/parity/gpu-harness.ts');

const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT ?? 9222);
const TIMEOUT_MS = Number(process.env.GPU_TIMEOUT_MS ?? 120000);

const CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  // SwiftShader gives a conformant software WebGPU implementation, so the run
  // does not need a discrete GPU or a working Vulkan driver.
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-extensions',
  '--mute-audio',
];

async function fetchJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`devtools endpoint never came up at ${url}`);
}

/** Minimal DevTools protocol client over the browser-level socket. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #sessionId = null;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
      else entry.resolve(message.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId = this.#sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS).unref?.();
    });
  }

  attach(sessionId) {
    this.#sessionId = sessionId;
  }

  close() {
    this.#ws.close();
  }
}

const profile = await mkdtemp(join(tmpdir(), 'terrascope-gpu-parity-'));
const chrome = spawn(
  CHROME,
  [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let chromeStderr = '';
chrome.stderr.on('data', (chunk) => {
  chromeStderr += chunk.toString();
});

let exitCode = 1;
try {
  const pagePath = join(profile, 'parity.html');
  const scriptPath = join(profile, 'parity.js');

  // Bundle the real modules. `?raw` shader imports are inlined by a plugin
  // rather than re-implemented, so the WGSL under test is the file on disk.
  await build({
    entryPoints: [harness],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: scriptPath,
    sourcemap: 'inline',
    logLevel: 'warning',
    plugins: [
      {
        name: 'wgsl-raw',
        setup(b) {
          b.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: join(args.resolveDir, args.path.replace(/\?raw$/, '')),
            namespace: 'wgsl',
          }));
          b.onLoad({ filter: /.*/, namespace: 'wgsl' }, async (args) => ({
            contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
            loader: 'js',
          }));
        },
      },
    ],
  });

  await writeFile(
    pagePath,
    `<!doctype html>
<html><head><meta charset="utf-8"><title>TerraScope GPU parity</title></head>
<body><pre id="out">running</pre>
<script type="module" src="./parity.js"></script>
<script type="module">
  // Surface module-level failures (import errors, syntax) that would otherwise
  // leave the runner polling an undefined global until it times out.
  window.addEventListener('error', (e) => {
    window.__parity ??= { pass: false, checks: [], adapter: null, error: 'page error: ' + e.message };
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__parity ??= { pass: false, checks: [], adapter: null, error: 'rejection: ' + String(e.reason) };
  });
</script>
</body></html>`,
    'utf8',
  );

  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  console.log(`connected to ${version.Browser}`);

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, null);
  cdp.attach(sessionId);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // file:// pages are treated as opaque origins, which can block module
  // loading. A loopback static server gives a normal secure-ish origin without
  // needing a certificate.
  const origin = await serveLocal([pagePath, scriptPath]);
  await cdp.send('Page.navigate', { url: `${origin}/parity.html` });

  const deadline = Date.now() + TIMEOUT_MS;
  let parity = null;
  while (Date.now() < deadline) {
    // returnByValue hands back the object directly; stringifying it first and
    // re-parsing was only adding a place to fail.
    const { result: evaluated, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: 'window.__parity ?? null',
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.text}`);
    if (evaluated?.value) {
      parity = evaluated.value;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const result = parity;

  if (!result) {
    const { result: text } = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('out').textContent",
      returnByValue: true,
    });
    throw new Error(`the page never reported a result; last status: ${text}`);
  }

  console.log('');
  if (result.adapter) {
    const a = result.adapter;
    const parts = [a.vendor, a.architecture, a.description, a.device].filter(Boolean);
    console.log(`adapter: ${parts.join(' ') || 'unnamed'}`);
    if (a.features) {
      console.log(`features: ${Object.entries(a.features).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
    }
  }
  console.log('');
  for (const check of result.checks ?? []) {
    console.log(`  ${check.pass ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? `  [${check.detail}]` : ''}`);
  }
  if (result.error) console.log(`\nerror: ${result.error}`);
  console.log('');
  console.log(
    result.pass
      ? 'WebGPU parity passed in a real browser.'
      : 'WebGPU parity FAILED in a real browser.',
  );
  exitCode = result.pass ? 0 : 1;
  cdp.close();
} catch (error) {
  console.error(`\n${error.message}`);
  if (chromeStderr.trim()) {
    console.error(`\nchrome stderr (last lines):\n${chromeStderr.trim().split('\n').slice(-10).join('\n')}`);
  }
  exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(exitCode);

/**
 * Serve the page and its bundle over loopback HTTP.
 *
 * A single-page static server, kept inline so the runner has no dependency
 * beyond esbuild. Returns the origin.
 */
async function serveLocal(paths) {
  const { createServer } = await import('node:http');
  const { readFile: read } = await import('node:fs/promises');
  const byName = new Map(paths.map((p) => [p.split('/').pop(), p]));

  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\//, '') || 'parity.html';
    const file = byName.get(name);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await read(file);
      res.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.unref();
  return `http://127.0.0.1:${port}`;
}

async function readFile(path, encoding) {
  const { readFile: read } = await import('node:fs/promises');
  return read(path, encoding);
}
