/** Build three spatial LOD levels from the registered, already prepared SOGs. */
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { selectScenes } from './prepare-skyfall.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exists = (path) => access(path).then(() => true, () => false);
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
export function inspectLodTree(meta) {
  if (meta.lodLevels !== 3 || meta.environment || !Array.isArray(meta.filenames) || !meta.filenames.length) throw new Error('Expected a three-level spatial LOD tree');
  const counts = [0, 0, 0], files = new Map();
  let leaves = 0;
  const visit = (node) => {
    if (!node?.bound || [...node.bound.min, ...node.bound.max].some((value) => !Number.isFinite(value))) throw new Error('Invalid LOD bounds');
    if (node.children) { node.children.forEach(visit); return; }
    leaves++;
    for (const [level, range] of Object.entries(node.lods ?? {})) {
      if (![0, 1, 2].includes(Number(level)) || !Number.isSafeInteger(range.count) || range.count < 0
        || !Number.isSafeInteger(range.file) || !meta.filenames[range.file] || !Number.isSafeInteger(range.offset) || range.offset < 0) throw new Error('Invalid LOD range');
      counts[Number(level)] += range.count;
      const path = meta.filenames[range.file];
      if (!/^\d+_\d+\/meta\.json$/.test(path)) throw new Error('Unsafe LOD chunk path');
      files.set(path, Math.max(files.get(path) ?? 0, range.offset + range.count));
    }
  };
  visit(meta.tree);
  if (!(counts[0] > counts[1] && counts[1] > counts[2] && counts[2] > 0)) throw new Error('LOD counts must decrease toward coarser levels');
  if ([...files.values()].some((count) => count > 131072)) throw new Error('LOD chunk exceeds the upload budget');
  return { counts, leaves, chunks: files.size, maxChunkSplats: Math.max(...files.values()) };
}
async function validate(directory, expectedCount) {
  const meta = JSON.parse(await readFile(join(directory, 'lod-meta.json'), 'utf8'));
  const details = inspectLodTree(meta);
  if (details.counts[0] !== expectedCount) throw new Error('Full-detail splats were dropped');
  for (const filename of meta.filenames) {
    const part = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    if (part.version !== 2 || !Number.isSafeInteger(part.count) || part.count <= 0 || part.count > 131072) throw new Error(`Invalid chunk ${filename}`);
    for (const channel of ['means', 'quats', 'scales', 'sh0', 'shN']) {
      for (const image of part[channel]?.files ?? []) {
        if (image.includes('/') || image.includes('..') || !(await stat(join(directory, filename, '..', image))).size) throw new Error('Missing or unsafe chunk image');
      }
    }
  }
  return details;
}
async function main() {
  const scenes = selectScenes(process.argv.slice(2));
  const publicRoot = join(root, 'apps/web/public/splats');
  const output = join(publicRoot, 'streamed');
  const cache = resolve(process.env.SKYFALL_CACHE_DIR ?? join(tmpdir(), 'terrascope-skyfall'), 'lod');
  const manifest = JSON.parse(await readFile(join(publicRoot, 'manifest.json'), 'utf8'));
  const cli = join(root, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs');
  await mkdir(output, { recursive: true });
  await mkdir(cache, { recursive: true });
  const convert = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--gpu', process.env.SKYFALL_GPU ?? 'cpu', '--quiet', ...args], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`LOD conversion exited ${code}`)));
  });
  for (const { id } of scenes) {
    const source = join(publicRoot, `${id}.sog`), asset = manifest.assets.find((asset) => asset.id === id);
    const sourceSha256 = await hash(source);
    if (sourceSha256 !== asset?.sha256) throw new Error(`${id}: source differs from the registered asset`);
    const target = join(output, id), provenancePath = join(target, 'provenance.json');
    if (await exists(provenancePath)) {
      const previous = JSON.parse(await readFile(provenancePath, 'utf8'));
      if (previous.sourceSha256 !== sourceSha256) throw new Error(`${id}: stale LOD output; remove ${target} to regenerate`);
      await validate(target, asset.splats);
      console.log(`${id}: verified cached streaming LODs`);
      continue;
    }
    const medium = join(cache, `${id}-${sourceSha256}-medium.ply`), coarse = join(cache, `${id}-${sourceSha256}-coarse.ply`);
    for (const [input, destination] of [[source, medium], [medium, coarse]]) {
      if (await exists(destination)) continue;
      console.log(`${id}: merging ${input === source ? 'LOD 2' : 'LOD 3'} Gaussians on the CPU`);
      const temporary = `${destination}.partial.ply`;
      try { await convert([input, '--decimate', '25%', temporary]); await rename(temporary, destination); }
      finally { await rm(temporary, { force: true }); }
    }
    const staging = await mkdtemp(join(output, `.prepare-${id}-`));
    try {
      console.log(`${id}: writing bounded spatial chunks (LOD 3 → 2 → 1)`);
      await convert([source, '--lod', '0', medium, '--lod', '1', coarse, '--lod', '2', join(staging, 'lod-meta.json'), '--lod-chunk-count', '64', '--lod-chunk-extent', '128', '--iterations', '4']);
      const details = await validate(staging, asset.splats);
      await writeFile(join(staging, 'provenance.json'), `${JSON.stringify({ id, converter: '@playcanvas/splat-transform@2.3.1', sourceSha256,
        levels: { '1': 'full source detail (engine 0)', '2': '25% merged (engine 1)', '3': '6.25% merged (engine 2)' }, ...details }, null, 2)}\n`);
      await rename(staging, target);
      console.log(`${id}: ready · ${details.counts.join(' / ')} splats · ${details.chunks} chunks`);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
