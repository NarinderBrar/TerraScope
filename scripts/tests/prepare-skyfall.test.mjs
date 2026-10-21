import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryFileSystem, ZipFileSystem } from '@playcanvas/splat-transform';
import { inspectSog, prepareScene, selectScenes } from '../prepare-skyfall.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'terrascope-prepare-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { cache: join(directory, 'cache'), output: join(directory, 'output') };
  await mkdir(options.cache);
  await mkdir(options.output);
  return options;
}

async function sogFixture(count = 5) {
  const memory = new MemoryFileSystem();
  const zip = new ZipFileSystem(memory.createWriter('test.sog'));
  const writer = await zip.createWriter('meta.json');
  await writer.write(new TextEncoder().encode(JSON.stringify({ version: 2, count })));
  await writer.close();
  await zip.close();
  return memory.results.get('test.sog');
}

const noFetch = () => { throw new Error('Unexpected network request'); };

test('selects all 12 published models or an explicit deduplicated batch', () => {
  assert.equal(selectScenes(['--all']).length, 12);
  assert.deepEqual(selectScenes([]).map((scene) => scene.id), ['JAX_068', 'NYC_004', 'JAX_004', 'NYC_010', 'JAX_164', 'JAX_175', 'JAX_214', 'JAX_260', 'JAX_168', 'JAX_264', 'NYC_219', 'NYC_336']);
  assert.deepEqual(selectScenes(['JAX_004', 'NYC_010', 'JAX_004']).map((scene) => scene.id), ['JAX_004', 'NYC_010']);
  for (const args of [['../bad'], ['JAX_004', 'bad'], ['--all', 'JAX_004']]) assert.throws(() => selectScenes(args));
});

test('removes interrupted downloads and does not cache an error page', async (t) => {
  const options = await fixture(t);
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    pull(controller) { controller.error(new Error('connection interrupted')); },
  });
  await assert.rejects(prepareScene('JAX_004', {
    ...options, fetchImpl: async () => new Response(stream), convert: noFetch,
  }), /connection interrupted/);
  assert.deepEqual(await readdir(options.cache), []);
  await assert.rejects(prepareScene('JAX_004', {
    ...options, fetchImpl: async () => new Response('<html>missing</html>', { headers: { 'content-type': 'text/html' } }), convert: noFetch,
  }), /HTML/);
  assert.deepEqual(await readdir(options.cache), []);
});

test('retries failed conversions from cached sources without promoting partial outputs', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.cache, 'NYC_010_final.ply'), 'cached source');
  await assert.rejects(prepareScene('NYC_010', {
    ...options, fetchImpl: noFetch,
    convert: async (_input, output) => { await writeFile(output, 'incomplete'); throw new Error('GPU unavailable'); },
  }), /GPU unavailable/);
  assert.deepEqual(await readdir(options.output), []);
  const asset = await prepareScene('NYC_010', {
    ...options, fetchImpl: noFetch, convert: async (_input, output) => writeFile(output, await sogFixture()),
  });
  assert.equal(asset.splats, 5);
  assert.equal(asset.sogVersion, 2);
  assert.equal(asset.file, 'NYC_010.sog');
  assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal((await readdir(options.output)).length, 1);
  const reused = await prepareScene('NYC_010', { ...options, fetchImpl: noFetch, convert: noFetch, previous: asset });
  assert.deepEqual(reused, asset);
  await writeFile(join(options.cache, 'NYC_010_final.ply'), 'different source with the same filename');
  const unknown = await prepareScene('NYC_010', { ...options, fetchImpl: noFetch, convert: noFetch });
  assert.equal(unknown.sourceSha256, undefined, 'A same-named cache file cannot establish an existing output\'s provenance');
});

test('rejects invalid converted assets before they can be reused', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.cache, 'JAX_004_final.ply'), 'cached source');
  await assert.rejects(prepareScene('JAX_004', {
    ...options, fetchImpl: noFetch, convert: async (_input, output) => writeFile(output, await sogFixture(0)),
  }), /nonempty SOG/);
  assert.deepEqual(await readdir(options.output), []);
});

test('retains provenance for unchanged assets when the source cache is missing', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.output, 'JAX_068.sog'), await sogFixture());
  const metadata = await inspectSog(join(options.output, 'JAX_068.sog'));
  const previous = { ...metadata, sourceSha256: 'known-source-hash' };
  const asset = await prepareScene('JAX_068', { ...options, previous, fetchImpl: noFetch, convert: noFetch });
  assert.equal(asset.sourceSha256, previous.sourceSha256);
  const changed = await prepareScene('JAX_068', { ...options, previous: { ...previous, sha256: 'changed' }, fetchImpl: noFetch, convert: noFetch });
  assert.equal(changed.sourceSha256, undefined);
  assert.ok((await readFile(join(options.output, 'JAX_068.sog'))).length > 0);
});
