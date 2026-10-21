import {
  ADDRESS_CLAMP_TO_EDGE, CULLFACE_NONE, FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR,
  PIXELFORMAT_RGBA8, PRIMITIVE_TRIANGLES, Color, Entity, Mat4, Mesh, MeshInstance, StandardMaterial, Texture, Vec3,
} from 'playcanvas';
import type { PCApp } from './supersplat/pc-app';
import type { Camera } from './supersplat/camera';
import type { SplatGeoreference } from '../data/splatGeoreference';
import { fetchWorldImageryTile } from '../map/worldImagery';
import { GroundTileStream } from './GroundTileStream';
import { groundTileKey, groundTileUvs, planGroundTiles, type GroundTile, type Point3, type VisibleGroundTile } from './groundTilePlan';

export interface GroundMapLayer { update(): void; retry(): void; setVisible(visible: boolean): void; dispose(): void }
export type GroundMapStatus = 'loading' | 'ready' | 'unavailable';
interface TileResource { texture: Texture; material: StandardMaterial }

/** Camera-driven Esri quadtree rendered in the splat's fixed, registered frame. */
export function createGroundMap(
  app: PCApp, modelRoot: Entity, reference: SplatGeoreference, camera: Camera,
  onStatus: (status: GroundMapStatus) => void,
): GroundMapLayer {
  const root = new Entity('Streaming satellite ground');
  modelRoot.addChild(root);
  const inverse = new Mat4();
  const meshes = new Map<string, { entity: Entity; mesh: Mesh; instance: MeshInstance; source: string }>();
  let tiles: VisibleGroundTile[] = [];
  let visible = true;
  let disposed = false;
  let signature = '';
  let lastUpdate = -Infinity;
  let lastRefresh = -Infinity;
  let status: GroundMapStatus = 'loading';
  onStatus(status);

  const load = async (tile: GroundTile, signal: AbortSignal): Promise<TileResource | null> => {
    const n = 2 ** tile.z;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    // Per-request fallback cache: cancelling an obsolete tile cannot poison a neighbour's request.
    const image = await fetchWorldImageryTile(tile.z, ((tile.x % n) + n) % n, tile.y, timeout, new Map());
    if (!image) return null;
    const bitmap = await createImageBitmap(image.blob);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    try {
      timeout.throwIfAborted();
      canvas.getContext('2d')!.drawImage(bitmap, image.left, image.top, image.size, image.size, 0, 0, 256, 256);
    } finally { bitmap.close(); }
    const texture = new Texture(app.graphicsDevice, {
      name: `Satellite ${groundTileKey(tile)}`, width: 256, height: 256,
      format: PIXELFORMAT_RGBA8, mipmaps: true, flipY: false,
      anisotropy: Math.min(16, app.graphicsDevice.maxAnisotropy || 1),
      minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    texture.setSource(canvas);
    const material = new StandardMaterial();
    material.name = texture.name;
    material.useLighting = false;
    material.cull = CULLFACE_NONE;
    material.diffuse = new Color(0, 0, 0);
    material.emissive = new Color(1, 1, 1);
    material.emissiveMap = texture;
    material.depthWrite = false;
    material.update();
    return { texture, material };
  };
  const removeMesh = (key: string): void => {
    const entry = meshes.get(key)!;
    entry.entity.destroy();
    entry.mesh.destroy();
    meshes.delete(key);
  };
  const sync = (): void => {
    if (disposed) return;
    const keep = new Set<string>();
    for (const tile of tiles) {
      const source = stream.find(tile);
      if (!source) continue;
      const key = groundTileKey(tile), sourceKey = groundTileKey(source.tile);
      keep.add(key);
      let entry = meshes.get(key);
      if (!entry) {
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(tile.corners.flat());
        mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        mesh.setUvs(0, groundTileUvs(tile, source.tile));
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update(PRIMITIVE_TRIANGLES);
        const instance = new MeshInstance(mesh, source.value.material);
        const entity = new Entity(`Ground ${key}`);
        entity.addComponent('render', { meshInstances: [instance] });
        root.addChild(entity);
        entry = { entity, mesh, instance, source: sourceKey };
        meshes.set(key, entry);
      } else if (entry.source !== sourceKey) {
        entry.instance.material = source.value.material;
        entry.mesh.setUvs(0, groundTileUvs(tile, source.tile));
        entry.mesh.update(PRIMITIVE_TRIANGLES);
        entry.source = sourceKey;
      }
    }
    for (const key of meshes.keys()) if (!keep.has(key)) removeMesh(key);
    const next = keep.size ? 'ready' : tiles.length && !stream.pending ? 'unavailable' : status;
    if (next !== status) {
      status = next;
      // Reveal only once submitted in the same rendered frame as the splats.
      app.once('frameend', () => { if (!disposed && status === next) onStatus(next); });
    }
  };
  const stream = new GroundTileStream(load, ({ material, texture }) => { material.destroy(); texture.destroy(); }, sync);
  const tuple = (value: Vec3): Point3 => [value.x, value.y, value.z];
  const update = (): void => {
    if (disposed || !visible) return;
    const now = performance.now();
    if (now - lastUpdate < 150) return;
    lastUpdate = now;
    inverse.copy(modelRoot.getWorldTransform()).invert();
    const main = camera.mainCamera;
    const position = tuple(inverse.transformPoint(main.getPosition()));
    const forward = tuple(inverse.transformVector(main.forward));
    const right = tuple(inverse.transformVector(main.right));
    const up = tuple(inverse.transformVector(main.up));
    const width = app.graphicsDevice.width, height = app.graphicsDevice.height;
    const next = [...position, ...forward, ...up, width, height, camera.camera.fov, camera.camera.farClip].map((v) => v.toFixed(4)).join(',');
    if (next !== signature) {
      signature = next;
      tiles = planGroundTiles(reference, { position, forward, right, up, fov: camera.camera.fov, aspect: width / height,
        height, near: camera.camera.nearClip, far: camera.camera.farClip });
      stream.setTiles(tiles);
      sync();
      lastRefresh = now;
    } else if (now - lastRefresh > 1000) {
      // Retrying a failed network request does not require camera movement.
      lastRefresh = now;
      stream.setTiles(tiles);
    }
  };
  update();
  return {
    update,
    retry: () => { if (!disposed) { stream.retry(); update(); } },
    setVisible: (value) => {
      visible = value; root.enabled = value;
      if (!value) stream.setTiles([]);
      else { signature = ''; lastUpdate = -Infinity; update(); }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const key of meshes.keys()) removeMesh(key);
      stream.dispose();
      root.destroy();
    },
  };
}
