import { expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import manifest from '../public/splats/manifest.json';
import { sogTextureFiles, MAX_CHUNK_SPLATS } from '../src/splat/sogChunk';

it.each(SKYFALL_SCENES)('has complete, bounded and frame-validated LOD assets for $id', (scene) => {
  const base = new URL(`../public/splats/streamed/${scene.id}/`, import.meta.url);
  const json = (file: string) => JSON.parse(readFileSync(new URL(file, base), 'utf8'));
  const index = json('lod-meta.json'), provenance = json('provenance.json'), alignment = json('alignment.json');
  const source = manifest.assets.find((asset) => asset.id === scene.id)!;
  expect(scene.lodUrl).toContain(`/streamed/${scene.id}/lod-meta.json`);
  expect(index.lodLevels).toBe(3);
  expect(provenance.sourceSha256).toBe(source.sha256);
  expect(provenance.counts[0]).toBe(source.splats);
  expect(provenance.counts[1]).toBeLessThan(provenance.counts[0]);
  expect(provenance.counts[2]).toBeLessThan(provenance.counts[1]);
  expect(alignment.sourceSha256).toBe(source.sha256);
  expect(alignment.fullDetailSplats).toBe(source.splats);
  expect(alignment.sampledPositions).toBeGreaterThan(500);
  expect(alignment.maxNearestSourceDistanceModelUnits).toBeLessThan(0.15);
  for (let level = 1; level <= 3; level++) {
    expect(alignment.levels[String(level)].splats).toBe(provenance.counts[level - 1]);
    expect(alignment.levels[String(level)].maxNearestInputDistanceModelUnits).toBeLessThan(0.15);
  }
  for (const filename of index.filenames) {
    expect(filename).toMatch(/^[012]_\d+\/meta\.json$/);
    const chunk = json(filename);
    expect(chunk.count).toBeLessThanOrEqual(MAX_CHUNK_SPLATS);
    for (const { file } of sogTextureFiles(chunk)) expect(statSync(new URL(file, new URL(filename, base))).size).toBeGreaterThan(0);
  }
});
