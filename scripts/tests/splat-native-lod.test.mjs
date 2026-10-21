/** Contract check against the web app's installed native LOD selector. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const build = dirname(requireWeb.resolve('playcanvas'));
const native = (file) => import(pathToFileURL(join(build, 'playcanvas/src/scene/gsplat-unified', file)));
const { GSplatOctree } = await native('gsplat-octree.js');
const { GSplatOctreeInstance } = await native('gsplat-octree-instance.js');

test('native underfill requests coarse first and advances one level while retaining loaded fallback', async () => {
  const meta = JSON.parse(await readFile(new URL('../../apps/web/public/splats/streamed/JAX_004/lod-meta.json', import.meta.url), 'utf8'));
  const octree = new GSplatOctree('https://models.test/JAX_004/lod-meta.json', meta);
  const instance = new GSplatOctreeInstance({ on: () => ({ off() {} }) }, octree, { lodRangeMin: 0, lodRangeMax: 2 });
  instance.resolveLodRange();
  const nodeIndex = octree.nodes.findIndex((node) => node.lods.every((lod) => lod.count > 0));
  assert.ok(nodeIndex >= 0);
  const node = octree.nodes[nodeIndex];
  assert.equal(instance.selectDesiredLodIndex(nodeIndex, 0, 2), 2, 'Start with viewer LOD 3');
  octree.fileResources.set(node.lods[2].fileIndex, {});
  assert.equal(instance.selectDesiredLodIndex(nodeIndex, 0, 2), 2, 'Keep coarse while medium is missing');
  instance.prefetchNextLod(nodeIndex, 2, 0, 1);
  assert.ok(instance._fileRequests.has(node.lods[1].fileIndex), 'Prefetch viewer LOD 2');
  assert.ok(!instance._fileRequests.has(node.lods[0].fileIndex), 'Advance one level at a time');
  octree.fileResources.set(node.lods[1].fileIndex, {});
  assert.equal(instance.selectDesiredLodIndex(nodeIndex, 0, 2), 1, 'Advance to loaded medium');
  instance.prefetchNextLod(nodeIndex, 1, 0, 1);
  assert.ok(instance._fileRequests.has(node.lods[0].fileIndex), 'Prefetch viewer LOD 1');
  octree.fileResources.set(node.lods[0].fileIndex, {});
  assert.equal(instance.selectDesiredLodIndex(nodeIndex, 0, 2), 0, 'Advance to loaded full detail');
  instance.destroy(); octree.destroy();
});
