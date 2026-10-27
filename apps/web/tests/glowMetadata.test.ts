import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import sourceHashes from '../src/data/splatSourceHashes.json';
import { hasSceneGlow, parseBuildingGlowMetadata } from '../src/splat/glowMetadata';

const template = JSON.parse(readFileSync('public/semantics/NYC_010-building-glow.json', 'utf8'));
afterEach(() => vi.unstubAllGlobals());

it('accepts the finer atlas while rejecting mismatched storage dimensions', () => {
  const refined = { ...template, gridSize: [512, 512, 64], atlasSize: [4096, 4096], byteLength: 16777216 };
  expect(parseBuildingGlowMetadata(refined, 'NYC_010')).toEqual(refined);
  for (const bad of [{ ...refined, byteLength: 4194304 }, { ...refined, atlasSize: [2048, 2048] },
    { ...refined, gridSize: [512, 256, 64] }, { ...refined, gridSize: [512, 512, 64, 1] }]) {
    expect(() => parseBuildingGlowMetadata(bad, 'NYC_010')).toThrow();
  }
});

it('retains manifest source hashes for every registered scene and rejects cross-scene evidence', () => {
  const manifest = JSON.parse(readFileSync('public/splats/manifest.json', 'utf8'));
  expect(Object.keys(sourceHashes)).toHaveLength(manifest.assets.length);
  for (const { id, sha256 } of manifest.assets) {
    expect(sourceHashes[id as keyof typeof sourceHashes]).toBe(sha256);
    const meta = { ...template, scene: id, asset: `${id}-building-glow.bin`, sourceSha256: sha256 };
    expect(parseBuildingGlowMetadata(meta, id)).toEqual(meta);
    expect(() => parseBuildingGlowMetadata({ ...meta, sourceSha256: '0'.repeat(64) }, id)).toThrow();
  }
});

it('requires valid exports for both categories before enabling a scene', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('-vegetation-')
    ? new Response('', { status: 404 }) : new Response(JSON.stringify(template))));
  expect(await hasSceneGlow('NYC_010', controller.signal)).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('-vegetation-')
    ? { ...template, kind: 'langsplat-vegetation-glow', asset: 'NYC_010-vegetation-glow.bin' } : template))));
  expect(await hasSceneGlow('NYC_010', controller.signal)).toBe(true);
  expect(await hasSceneGlow('JAX_068', controller.signal)).toBe(false);
});
