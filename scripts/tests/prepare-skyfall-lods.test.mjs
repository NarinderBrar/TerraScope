import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLodTree } from '../prepare-skyfall-lods.mjs';
const fixture = () => ({ lodLevels: 3, environment: null, filenames: ['0_0/meta.json', '1_0/meta.json', '2_0/meta.json'], tree: {
  bound: { min: [-100, -100, -30], max: [100, 100, 60] }, lods: {
    0: { file: 0, offset: 0, count: 100 }, 1: { file: 1, offset: 0, count: 25 }, 2: { file: 2, offset: 0, count: 6 },
  },
} });
test('validates decreasing LOD counts, registration bounds, and bounded safe chunks', () => {
  assert.deepEqual(inspectLodTree(fixture()), { counts: [100, 25, 6], leaves: 1, chunks: 3, maxChunkSplats: 100 });
  const unsafe = fixture(); unsafe.filenames[0] = '../outside/meta.json';
  assert.throws(() => inspectLodTree(unsafe), /Unsafe/);
  const huge = fixture(); huge.tree.lods[0].count = 131073;
  assert.throws(() => inspectLodTree(huge), /budget/);
  const missing = fixture(); missing.tree.lods[1].count = 0;
  assert.throws(() => inspectLodTree(missing), /decrease/);
  const invalid = fixture(); invalid.tree.bound.max[0] = NaN;
  assert.throws(() => inspectLodTree(invalid), /bounds/);
});
