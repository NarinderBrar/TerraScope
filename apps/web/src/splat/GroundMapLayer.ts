import {
  ADDRESS_CLAMP_TO_EDGE, CULLFACE_NONE, FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR,
  PIXELFORMAT_RGBA8, PRIMITIVE_TRIANGLES, Color, Entity, Mesh, MeshInstance, StandardMaterial, Texture,
} from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';
import type { GroundMapPlan } from './groundMapPlan';

export interface GroundMapLayer { setVisible(visible: boolean): void; dispose(): void }
export type GroundMapStatus = 'loading' | 'ready' | 'unavailable';

/** Bounded satellite mosaic rendered with the same PlayCanvas camera as the splats. */
export async function loadGroundMap(
  app: PCApp,
  modelRoot: Entity,
  plan: GroundMapPlan,
  signal: AbortSignal,
): Promise<GroundMapLayer> {
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#253b3c';
  context.fillRect(0, 0, plan.width, plan.height);
  let completed = 0;
  let next = 0;
  // Bounded concurrency and a timeout keep detailed imagery requests manageable.
  const tileSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  await Promise.all(Array.from({ length: Math.min(8, plan.tiles.length) }, async () => {
    while (next < plan.tiles.length) {
      tileSignal.throwIfAborted();
      const tile = plan.tiles[next++];
      try {
        const response = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tile.z}/${tile.y}/${tile.x}`, { signal: tileSignal });
        if (!response.ok) continue;
        const bitmap = await createImageBitmap(await response.blob());
        try {
          signal.throwIfAborted();
          context.drawImage(bitmap, tile.left, tile.top, 256, 256);
          completed++;
        } finally { bitmap.close(); }
      } catch (error) { if (tileSignal.aborted) throw error; }
    }
  }));
  signal.throwIfAborted();
  if (!completed) throw new Error('Satellite map tiles are unavailable');
  const texture = new Texture(app.graphicsDevice, {
    name: 'Skyfall satellite imagery', width: plan.width, height: plan.height,
    format: PIXELFORMAT_RGBA8, mipmaps: true, flipY: false,
    anisotropy: Math.min(16, app.graphicsDevice.maxAnisotropy || 1),
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  texture.setSource(canvas);
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions(plan.corners.flat());
  mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  mesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(PRIMITIVE_TRIANGLES);
  const material = new StandardMaterial();
  material.name = 'Satellite ground material';
  material.useLighting = false;
  material.cull = CULLFACE_NONE;
  material.diffuse = new Color(0, 0, 0);
  material.emissive = new Color(1, 1, 1);
  material.emissiveMap = texture;
  material.depthWrite = false;
  material.update();
  const entity = new Entity('Satellite ground map');
  entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
  modelRoot.addChild(entity);
  return {
    setVisible: (visible) => { entity.enabled = visible; },
    dispose: () => { entity.destroy(); mesh.destroy(); material.destroy(); texture.destroy(); },
  };
}
