import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureReference, parseAuthorLocation, planReference, resolveReferenceArea, selectAreas } from '../prepare-skyfall-reference.mjs';

test('reference search covers the author location without claiming a registration', () => {
  for (const area of selectAreas([]).filter((area) => Number.isFinite(area.lon))) {
    const plan = planReference(area);
    assert.equal(plan.scene, area.id);
    assert.equal(plan.tileOrigin.z, 18);
    assert.ok(plan.width >= 2500 && plan.width <= 4096);
    assert.ok(plan.height >= 2500 && plan.height <= 4096);
    assert.equal(plan.tiles.length * 256 * 256, plan.width * plan.height);
    assert.equal(plan.modelToMercator, undefined);
    assert.equal(plan.searchHint.source, area.source);
    assert.equal(new Set(plan.tiles.map((tile) => tile.file)).size, plan.tiles.length);
  }
  assert.throws(() => selectAreas(['../unknown']), /Unknown reference area/);
});

test('final scene batch requires real author coordinates and rejects missing or ambiguous locations', () => {
  const areas = selectAreas(['JAX_168', 'JAX_264', 'NYC_219', 'NYC_336']);
  assert.equal(areas.length, 4);
  for (const area of areas.filter((area) => !Number.isFinite(area.lon))) {
    assert.throws(() => planReference(area), /resolve the author location/);
    const pair = area.id.startsWith('JAX_') ? '30.33000000, -81.66000000' : '40.73000000, -73.98000000';
    const resolved = parseAuthorLocation(area, `<h1>${area.id}</h1><p>${pair}</p>`);
    assert.ok(Number.isFinite(resolved.lon) && Number.isFinite(resolved.lat));
    assert.equal(resolved.source, area.source);
    assert.equal(parseAuthorLocation(area, `${area.id} ${pair} / ${pair}`).lon, resolved.lon);
    assert.throws(() => parseAuthorLocation(area, `${area.id} has no coordinates`), /found 0/);
    assert.throws(() => parseAuthorLocation(area, `${area.id} ${pair} / ${area.id.startsWith('JAX_') ? '30.34000000, -81.65000000' : '40.74000000, -73.99000000'}`), /found 2/);
    assert.throws(() => parseAuthorLocation(area, `<h1>Another scene</h1>${pair}`), /does not identify/);
  }
});

test('author location lookup retains its source page and reuses it offline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'terrascope-author-location-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const area = selectAreas(['JAX_168'])[0];
  const html = '<h1>Villa (JAX_168)</h1><p>30.33000000, -81.66000000</p>';
  const resolved = await resolveReferenceArea(area, { directory, fetchImpl: async (url) => {
    assert.equal(url, area.source); return new Response(html);
  } });
  assert.equal(resolved.lat, 30.33);
  assert.equal(await readFile(join(directory, area.id, 'author-location.html'), 'utf8'), html);
  assert.deepEqual(await resolveReferenceArea(area, { directory, fetchImpl: async () => { throw new Error('Offline'); } }), resolved);
});

test('identifies the E 12th St. author page by canonical URL and accepts its tab-separated coordinates', () => {
  const area = selectAreas(['NYC_219'])[0];
  for (const separator of ['\t', '\\t']) {
    const html = `<title>E 12th St., NYC</title><link href="${area.source}" rel="canonical"><p>40.73187188${separator}-73.9869</p>`;
    const resolved = parseAuthorLocation(area, html);
    assert.equal(resolved.lat, 40.73187188);
    assert.equal(resolved.lon, -73.9869);
    assert.throws(() => parseAuthorLocation(area, html.replace(area.source, 'https://superspl.at/scene/other')), /does not identify/);
  }
});

test('error responses cannot be saved as reference imagery or a complete reference manifest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'terrascope-reference-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = planReference(selectAreas(['JAX_004'])[0]);
  for (const response of [new Response('missing', { status: 404 }), new Response('<html>fallback</html>')]) {
    await assert.rejects(captureReference(plan, { directory, fetchImpl: async () => response.clone() }));
    assert.deepEqual(await readdir(join(directory, plan.scene)), []);
  }
});
