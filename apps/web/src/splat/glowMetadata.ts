import sourceHashes from '../data/splatSourceHashes.json';

export type GlowCategory = 'buildings' | 'vegetation';
export interface BuildingGlowMetadata {
  schemaVersion: number; scene: string; kind: string; coordinateFrame: string;
  sourceSha256: string; asset: string; assetSha256: string; byteLength: number;
  boundsMin: number[]; boundsMax: number[]; gridSize: number[]; atlasSize: number[];
  minimumLocalZ: number;
}
export const stemFor = (category: GlowCategory): string => category === 'buildings' ? 'building' : 'vegetation';
export function parseBuildingGlowMetadata(value: unknown, scene: string, category: GlowCategory = 'buildings'): BuildingGlowMetadata {
  const m = value as BuildingGlowMetadata | null;
  const stem = stemFor(category);
  if (!sourceHashes[scene as keyof typeof sourceHashes] || !m || m.schemaVersion !== 1 || m.scene !== scene || m.kind !== `langsplat-${stem}-glow`
      || m.coordinateFrame !== 'registered-model-local' || m.sourceSha256 !== sourceHashes[scene as keyof typeof sourceHashes]
      || m.asset !== `${scene}-${stem}-glow.bin` || !/^[a-f0-9]{64}$/.test(m.assetSha256)
      || !Array.isArray(m.gridSize) || !Array.isArray(m.atlasSize)
      || m.gridSize.length !== 3 || m.atlasSize.length !== 2
      || ![256, 512].includes(m.gridSize[0]) || m.gridSize[1] !== m.gridSize[0] || m.gridSize[2] !== 64
      || m.byteLength !== m.gridSize[0] * m.gridSize[1] * 64
      || m.atlasSize[0] !== m.gridSize[0] * 8 || m.atlasSize[1] !== m.gridSize[1] * 8
      || !Array.isArray(m.boundsMin) || !Array.isArray(m.boundsMax) || m.boundsMin.length !== 3 || m.boundsMax.length !== 3
      || !m.boundsMin.every(Number.isFinite) || !m.boundsMax.every(Number.isFinite)
      || !Number.isFinite(m.minimumLocalZ)
      || m.boundsMin.some((v, i) => m.boundsMax[i] <= v)) throw new Error('LangSplat glow data does not match this registered scene.');
  return m;
}
/** Probe both exports; unpublished scenes keep their glow controls disabled. */
export async function hasSceneGlow(scene: string, signal: AbortSignal): Promise<boolean> {
  try {
    await Promise.all((['buildings', 'vegetation'] as const).map(async category => {
      const response = await fetch(`${import.meta.env.BASE_URL}semantics/${scene}-${stemFor(category)}-glow.json`, { signal });
      if (!response.ok) throw new Error('Features are not published');
      parseBuildingGlowMetadata(await response.json(), scene, category);
    }));
    return true;
  } catch { return false; }
}
