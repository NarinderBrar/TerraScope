import { BLEND_NORMAL, CULLFACE_NONE, Color, Entity, Mesh, MeshInstance, PIXELFORMAT_RGBA8, PRIMITIVE_TRIANGLES,
  StandardMaterial, Texture } from 'playcanvas';
import { worldPxToLonLat } from '@terrascope/contracts';
import type { PCApp } from '../splat/supersplat/pc-app';
import { fetchWorldImageryTile } from './worldImagery';
import { globePoint } from './navigation3D';
import type { SplatGeoreference } from '../data/splatGeoreference';

/** Low-resolution Earth shares the local camera; fades in as the plane fades out. */
export function createOrbitEarth(app: PCApp, anchor: { lon: number; lat: number }, reference?: SplatGeoreference) {
  const root = new Entity('Earth satellite surface', app); app.root.addChild(root); root.enabled = false;
  if (reference) {
    const [a, b, c, d] = reference.modelToMercator;
    const unit = Math.sqrt(Math.abs(a * d - b * c)) * Math.cos(anchor.lat * Math.PI / 180);
    root.setLocalScale(1 / unit, 1 / unit, 1 / unit);
    root.setLocalEulerAngles(0, -Math.atan2(c, a) * 180 / Math.PI, 0);
    root.setLocalPosition(0, reference.groundZ, 0);
  }
  const abort = new AbortController(), meshes: Mesh[] = [], materials: StandardMaterial[] = [], textures: Texture[] = [];
  let opacity = 0, started = false;
  const baseMaterial = new StandardMaterial(); baseMaterial.useLighting = false; baseMaterial.diffuse = new Color(0, 0, 0);
  baseMaterial.emissive = new Color(.035, .075, .13); baseMaterial.blendType = BLEND_NORMAL; baseMaterial.opacity = 0; baseMaterial.update();
  materials.push(baseMaterial);
  const base = new Entity('Earth background', app); base.addComponent('render', { type: 'sphere', material: baseMaterial });
  base.setLocalPosition(0, -6371008.8, 0); base.setLocalScale(6371008.8 * 1.998, 6371008.8 * 1.998, 6371008.8 * 1.998); root.addChild(base);
  const load = async (index: number): Promise<void> => {
    const x = index % 4, y = Math.floor(index / 4);
    const source = await fetchWorldImageryTile(2, x, y, abort.signal, new Map());
    if (!source) return;
    const bitmap = await createImageBitmap(source.blob);
    if (abort.signal.aborted) { bitmap.close(); return; }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    try { canvas.getContext('2d')!.drawImage(bitmap, source.left, source.top, source.size, source.size, 0, 0, 256, 256); }
    finally { bitmap.close(); }
    const texture = new Texture(app.graphicsDevice, { width: 256, height: 256, format: PIXELFORMAT_RGBA8, mipmaps: true, flipY: false });
    texture.setSource(canvas); textures.push(texture);
    const material = new StandardMaterial(); material.useLighting = false; material.diffuse = new Color(0, 0, 0);
    material.emissive = new Color(1, 1, 1); material.emissiveMap = texture; material.cull = CULLFACE_NONE;
    material.blendType = BLEND_NORMAL; material.opacity = opacity; material.update(); materials.push(material);
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [], n = 24;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const geo = worldPxToLonLat((x + i / n) * 64, (y + j / n) * 64, 0);
      const lat = y === 0 && j === 0 ? 90 : y === 3 && j === n ? -90 : geo.lat;
      const p = globePoint(geo.lon, lat, anchor); positions.push(p.x, p.y, p.z); uvs.push(i / n, j / n);
      if (i < n && j < n) { const a = j * (n + 1) + i; indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1); }
    }
    const mesh = new Mesh(app.graphicsDevice); mesh.setPositions(positions); mesh.setUvs(0, uvs); mesh.setIndices(indices); mesh.update(PRIMITIVE_TRIANGLES); meshes.push(mesh);
    const entity = new Entity(`Earth ${x}/${y}`, app); entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] }); root.addChild(entity);
  };
  const start = async (): Promise<void> => {
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!abort.signal.aborted && cursor < 16) { const index = cursor++; try { await load(index); } catch { /* Failed base tiles remain retryable by reopening 3D. */ } }
    }));
  };
  return {
    getWorldTransform: () => root.getWorldTransform(),
    prepare(): void { if (!started) { started = true; void start(); } },
    update(value: number): void {
      if (value > 0 && !started) { started = true; void start(); }
      root.enabled = value > 0;
      if (opacity === value) return;
      opacity = value; for (const material of materials) { material.opacity = value; material.update(); }
    },
    dispose(): void { abort.abort(); root.destroy(); for (const mesh of meshes) mesh.destroy(); for (const material of materials) material.destroy(); for (const texture of textures) texture.destroy(); },
  };
}
