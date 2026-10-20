/** Download and compress the two published city models. Node 22+, npm install first. */
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = resolve(process.env.SKYFALL_CACHE_DIR ?? join(tmpdir(), 'terrascope-skyfall'));
const output = join(root, 'apps/web/public/splats');
const cli = join(root, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs');
const exists = (path) => access(path).then(() => true, () => false);
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
for (const id of ['JAX_068', 'NYC_004']) {
  const target = join(output, `${id}.sog`);
  if (await exists(target)) { console.log(`${id}: already prepared`); continue; }
  const input = join(cache, `${id}_final.ply`);
  if (!await exists(input)) {
    const url = `https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/${id}_final.ply`;
    console.log(`Downloading ${url}`);
    const part = `${input}.part`;
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      await rename(part, input);
    } finally { await rm(part, { force: true }); }
  }
  const args = [cli];
  // Set SKYFALL_GPU=cpu on machines without a hardware compute adapter.
  if (process.env.SKYFALL_GPU) args.push('--gpu', process.env.SKYFALL_GPU);
  args.push(input, target);
  console.log(`Compressing ${id} (all source splats and SH bands retained)`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Conversion exited ${code}`)));
  });
}
