import { parseBuildingGlowMetadata, type BuildingGlowMetadata } from './glowMetadata';

export const SEGMENT_CLASSES = [
  { category: 'buildings', label: 'Buildings', color: '#19a6ff' },
  { category: 'vegetation', label: 'Vegetation', color: '#19ff40' },
  { category: 'roads', label: 'Roads', color: '#ff990d' },
  { category: 'vehicles', label: 'Vehicles', color: '#ff33a6' },
  { category: 'air-conditioning', label: 'AC units', color: '#994dff' },
] as const;
export interface SegmentationMetadata extends BuildingGlowMetadata {
  classes: { id: number; category: string; voxels: number }[];
}
export function parseSegmentationMetadata(value: unknown, scene: string): SegmentationMetadata {
  const m = value as SegmentationMetadata | null;
  if (!m || m.kind !== 'langsplat-segmented-view' || m.asset !== `${scene}-segments.bin`
      || !Array.isArray(m.classes) || m.classes.length !== SEGMENT_CLASSES.length
      || m.classes.some((c, i) => c?.id !== i + 1 || c.category !== SEGMENT_CLASSES[i].category
        || !Number.isSafeInteger(c.voxels) || c.voxels < 0 || c.voxels > m.byteLength)
      || m.classes.reduce((sum, c) => sum + c.voxels, 0) > m.byteLength) {
    throw new Error('Segmented data does not match this scene.');
  }
  // Shared validation checks source identity, registered frame, bounds and atlas layout.
  parseBuildingGlowMetadata({ ...m, kind: 'langsplat-building-glow', asset: `${scene}-building-glow.bin` }, scene);
  return m;
}
export async function loadSegmentationMetadata(scene: string, signal: AbortSignal): Promise<SegmentationMetadata> {
  const response = await fetch(`${import.meta.env.BASE_URL}semantics/${scene}-segments.json`, { signal });
  if (!response.ok) throw new Error('Segmented view is unavailable for this scene.');
  return parseSegmentationMetadata(await response.json(), scene);
}
