/** Download and compress published Skyfall scenes. Node 22+, npm install first. */
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryReadFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';
import catalog from '../apps/web/src/data/skyfallCatalog.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const exists = (path) => access(path).then(() => true, () => false);
const sourceUrl = (id) => `https://huggingface.co/jayinnn/Skyfall-GS-ply/resolve/main/${id}_final.ply`;

export function selectScenes(args) {
  if (args.includes('--all')) {
    if (args.length !== 1) throw new Error('Use --all alone, or supply scene IDs.');
    return catalog;
  }
  // Prepare all currently integrated scenes. Other catalog entries need registration.
  const ids = args.length ? args : ['JAX_068', 'NYC_004', 'JAX_004', 'NYC_010', 'JAX_164', 'JAX_175', 'JAX_214', 'JAX_260', 'JAX_168', 'JAX_264', 'NYC_219', 'NYC_336'];
  return [...new Set(ids)].map((id) => {
    const scene = catalog.find((candidate) => candidate.id === id);
    if (!scene) throw new Error(`Unknown scene: ${id}. Run npm run prepare:skyfall -- --list.`);
    return scene;
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inspectSog(path) {
  const data = await readFile(path);
  const memory = new MemoryReadFileSystem();
  memory.set('model.sog', data);
  const zip = new ZipReadFileSystem(await memory.createSource('model.sog'));
  try {
    const source = await zip.createSource('meta.json');
    const stream = source.read();
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(await stream.readAll())); }
    finally { stream.close(); source.close(); }
    if (meta.version !== 2 || !Number.isSafeInteger(meta.count) || meta.count <= 0) {
      throw new Error('Expected a nonempty SOG v2 model.');
    }
    return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), splats: meta.count, sogVersion: meta.version };
  } finally { zip.close(); }
}

/** Download/conversion are injectable so interrupted work can be tested offline. */
export async function prepareScene(id, { cache, output, convert, fetchImpl = fetch, previous }) {
  await mkdir(cache, { recursive: true });
  await mkdir(output, { recursive: true });
  const input = join(cache, `${id}_final.ply`);
  const target = join(output, `${id}.sog`);
  let converted = false;
  if (!await exists(target)) {
    if (!await exists(input)) {
      const url = sourceUrl(id);
      console.log(`Downloading ${url}`);
      const part = `${input}.part`;
      try {
        const response = await fetchImpl(url);
        if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
        if (response.headers.get('content-type')?.includes('text/html')) throw new Error('Download returned HTML instead of PLY.');
        await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
        await rename(part, input);
      } finally { await rm(part, { force: true }); }
    }
    // A failed conversion must never become an output that a retry skips.
    const staging = await mkdtemp(join(output, `.prepare-${id}-`));
    try {
      const temporary = join(staging, `${id}.sog`);
      console.log(`Compressing ${id} (all source splats and SH bands retained)`);
      await convert(input, temporary);
      await inspectSog(temporary);
      await rename(temporary, target);
      converted = true;
    } finally { await rm(staging, { recursive: true, force: true }); }
  } else {
    console.log(`${id}: reusing prepared asset`);
  }
  const metadata = await inspectSog(target);
  // A cached PLY with the same name does not prove it produced a reused SOG.
  // Only a fresh conversion or a matching previous output can attest provenance.
  const sourceSha256 = converted ? await sha256(input) : previous?.sha256 === metadata.sha256 ? previous.sourceSha256 : undefined;
  return { id, source: sourceUrl(id), ...(sourceSha256 && { sourceSha256 }), file: `${id}.sog`, ...metadata };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    for (const scene of catalog) console.log(`${scene.id}\t${scene.name}`);
    return;
  }
  const scenes = selectScenes(args); // Validate everything before writing or downloading.
  const cache = resolve(process.env.SKYFALL_CACHE_DIR ?? join(tmpdir(), 'terrascope-skyfall'));
  const output = join(root, 'apps/web/public/splats');
  const cli = join(root, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs');
  const manifestPath = join(output, 'manifest.json');
  const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { converter: '@playcanvas/splat-transform@2.3.1', assets: [] };
  const convert = (input, target) => new Promise((resolve, reject) => {
    const cliArgs = [cli];
    if (process.env.SKYFALL_GPU) cliArgs.push('--gpu', process.env.SKYFALL_GPU);
    cliArgs.push(input, target);
    const child = spawn(process.execPath, cliArgs, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Conversion exited ${code}`)));
  });
  for (const { id } of scenes) {
    const index = manifest.assets.findIndex((asset) => asset.id === id);
    const asset = await prepareScene(id, { cache, output, convert, previous: manifest.assets[index] });
    if (index < 0) manifest.assets.push(asset); else manifest.assets[index] = asset;
    const part = `${manifestPath}.part`;
    try {
      await writeFile(part, `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(part, manifestPath);
    } finally { await rm(part, { force: true }); }
    console.log(`${id}: ${asset.splats.toLocaleString()} splats, ${asset.bytes.toLocaleString()} bytes`);
  }
  console.log('Assets prepared. Only scenes with verified geographic registration belong in SKYFALL_SCENES; see docs/SKYFALL_EXPANSION.md.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message, error.cause?.message ?? ''); process.exitCode = 1; });
}
