import { ADDRESS_CLAMP_TO_EDGE, BLEND_NONE, BLEND_NORMAL, CULLFACE_BACK, Color, Entity, FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR, Mat4, Mesh, MeshInstance, PIXELFORMAT_RGBA8, PRIMITIVE_TRIANGLES,
  Quat, StandardMaterial, Texture, Vec3 } from 'playcanvas';
import type { PCApp } from '../splat/supersplat/pc-app';
import type { Camera } from '../splat/supersplat/camera';
import { basemapTileImages } from '../splat/GroundTileImages';
import { BasemapTileStream } from '../splat/BasemapTileStream';
import type { BasemapStyle } from './darkVectorTiles';
import { groundTileKey, type GroundTile, type VisibleGroundTile } from '../splat/groundTilePlan';
import { EARTH_BASE_SCALE, earthClipPlanes, earthTileGeometry, planEarthTiles } from './earthTilePlan';
import { EARTH_RADIUS, globePoint } from './navigation3D';
import type { SplatGeoreference } from '../data/splatGeoreference';

interface TileResource { texture: Texture; material: StandardMaterial }

/** Camera-driven spherical imagery, using one nonoverlapping patch per leaf. */
export function createOrbitEarth(app: PCApp, anchor: { lon: number; lat: number }, reference?: SplatGeoreference, camera?: Camera) {
  const root = new Entity('Earth satellite surface', app); app.root.addChild(root); root.enabled = false;
  if (reference) {
    const [a, b, c, d] = reference.modelToMercator;
    const unit = Math.sqrt(Math.abs(a * d - b * c)) * Math.cos(anchor.lat * Math.PI / 180);
    root.setLocalScale(1 / unit, 1 / unit, 1 / unit);
    root.setLocalEulerAngles(0, -Math.atan2(c, a) * 180 / Math.PI, 0);
    root.setLocalPosition(0, reference.groundZ, 0);
  }
  const baseRotation = root.getLocalRotation().clone(), basePosition = root.getLocalPosition().clone();
  const modelUnitsPerMetre = root.getLocalScale().x;
  let opacity = 0, started = false, disposed = false, lastUpdate = -Infinity, signature = '';
  let tiles: VisibleGroundTile[] = [];
  const meshes = new Map<string, { entity: Entity; mesh: Mesh; instance: MeshInstance; uvs: number[]; source: string }>();
  const baseMaterial = new StandardMaterial(); baseMaterial.useLighting = false; baseMaterial.diffuse = new Color(0, 0, 0);
  baseMaterial.emissive = new Color(.035, .075, .13);
  const applyOpacity = (material: StandardMaterial) => {
    material.blendType = opacity === 1 ? BLEND_NONE : BLEND_NORMAL;
    material.opacity = opacity; material.depthWrite = true; material.update();
  };
  applyOpacity(baseMaterial);
  const base = new Entity('Earth background', app); base.addComponent('render', { type: 'sphere', material: baseMaterial });
  // Keep the underlay below every tessellated patch, including coarse diagonal
  // chords. A nearly coincident sphere previously poked through as dark triangles.
  base.setLocalPosition(0, -EARTH_RADIUS, 0);
  base.setLocalScale(2 * EARTH_RADIUS * EARTH_BASE_SCALE, 2 * EARTH_RADIUS * EARTH_BASE_SCALE, 2 * EARTH_RADIUS * EARTH_BASE_SCALE);
  root.addChild(base);
  const remove = (key: string) => { const item = meshes.get(key)!; item.entity.destroy(); item.mesh.destroy(); meshes.delete(key); };
  const sync = () => {
    if (disposed) return;
    const keep = new Set<string>();
    for (const tile of tiles) {
      const source = stream.find(tile);
      if (!source) continue;
      const key = groundTileKey(tile), sourceKey = groundTileKey(source.tile);
      keep.add(key);
      let entry = meshes.get(key);
      if (!entry) {
        const geometry = earthTileGeometry(tile, anchor);
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(geometry.positions); mesh.setIndices(geometry.indices);
        const instance = new MeshInstance(mesh, source.value.material);
        const entity = new Entity(`Earth ${key}`, app);
        entity.addComponent('render', { meshInstances: [instance] }); root.addChild(entity);
        entry = { entity, mesh, instance, uvs: geometry.uvs, source: '' }; meshes.set(key, entry);
      }
      if (entry.source !== sourceKey) {
        const factor = 2 ** (tile.z - source.tile.z);
        const left = (tile.x - source.tile.x * factor) / factor;
        const top = (tile.y - source.tile.y * factor) / factor;
        const uvs = entry.uvs.map((value, index) => value / factor + (index % 2 ? top : left));
        entry.mesh.setUvs(0, uvs); entry.mesh.update(PRIMITIVE_TRIANGLES);
        applyOpacity(source.value.material);
        entry.instance.material = source.value.material; entry.source = sourceKey;
      }
    }
    // Parents supply textures through cropped UVs, never a second overlapping
    // sphere patch. Keep old resources alive until their replacements are bound.
    for (const key of meshes.keys()) if (!keep.has(key)) remove(key);
  };
  const stream = new BasemapTileStream<TileResource>(async (style, tile: GroundTile, signal) => {
    const image = await basemapTileImages(style).get(tile.z, tile.x, tile.y, signal);
    if (!image) return null;
    signal.throwIfAborted();
    const texture = new Texture(app.graphicsDevice, { name: `Earth ${groundTileKey(tile)}`, width: image.width, height: image.height,
      format: PIXELFORMAT_RGBA8, mipmaps: true, flipY: false,
      minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
      anisotropy: Math.min(8, app.graphicsDevice.maxAnisotropy || 1) });
    texture.setSource(image);
    const material = new StandardMaterial(); material.useLighting = false; material.diffuse = new Color(0, 0, 0);
    material.emissive = new Color(1, 1, 1); material.emissiveMap = texture; material.cull = CULLFACE_BACK;
    applyOpacity(material);
    return { texture, material };
  }, ({ texture, material }) => { material.destroy(); texture.destroy(); }, sync, 256, 6);
  const prepare = () => {
    if (started || disposed) return;
    started = true;
    tiles = Array.from({ length: 16 }, (_, i) => ({ z: 2, x: i % 4, y: Math.floor(i / 4), corners: [], error: 0 }));
    stream.setTiles(tiles); sync();
  };
  return {
    getWorldTransform: () => root.getWorldTransform(),
    setFocus(focus: { lon: number; lat: number }): void {
      // Change the floating geographic frame while the physical sphere center
      // stays fixed. Meshes/textures remain in their original geographic frame.
      const center = new Vec3(0, -EARTH_RADIUS, 0);
      const up = globePoint(focus.lon, focus.lat, anchor).sub(center).normalize();
      const east = globePoint(focus.lon + 90, 0, anchor).sub(center).normalize();
      const south = new Vec3().cross(east, up).normalize();
      const matrix = new Mat4().set([east.x, up.x, south.x, 0, east.y, up.y, south.y, 0,
        east.z, up.z, south.z, 0, 0, 0, 0, 1]);
      const rotation = new Quat().setFromMat4(matrix);
      root.setLocalRotation(new Quat().mul2(baseRotation, rotation));
      const shift = center.clone().sub(rotation.transformVector(center)).mulScalar(modelUnitsPerMetre);
      root.setLocalPosition(basePosition.clone().add(baseRotation.transformVector(shift)));
      signature = ''; lastUpdate = -Infinity;
    },
    prepare,
    setStyle(style: BasemapStyle): void {
      if (disposed || !stream.setStyle(style)) return;
      for (const key of meshes.keys()) remove(key);
      baseMaterial.emissive = style === 'dark-vector' ? new Color(.025, .04, .065) : new Color(.035, .075, .13);
      baseMaterial.update(); signature = ''; lastUpdate = -Infinity;
      if (started) { stream.setTiles(tiles); sync(); }
    },
    update(value: number): void {
      if (disposed) return;
      // Refit every frame, even while the tile plan is throttled or the camera
      // is stationary. Restore city clipping when the globe fades away.
      let inverse: Mat4 | undefined;
      let position: ReturnType<Mat4['transformPoint']> | undefined;
      if (camera) {
        camera.updateClipping();
        if (value > 0) {
          inverse = new Mat4().copy(root.getWorldTransform()).invert();
          position = inverse.transformPoint(camera.mainCamera.getPosition());
          const clipping = earthClipPlanes(position, root.getLocalScale().x);
          camera.camera.nearClip = clipping.near;
          camera.camera.farClip = Math.max(camera.camera.farClip, clipping.far);
        }
      }
      if (value > 0) prepare();
      root.enabled = value > 0;
      if (opacity !== value) {
        opacity = value; applyOpacity(baseMaterial);
        const materials = new Set([...meshes.values()].map(item => item.instance.material as StandardMaterial));
        for (const material of materials) applyOpacity(material);
      }
      const now = performance.now();
      if (!camera || !inverse || !position || value <= 0 || now - lastUpdate < 150) return;
      lastUpdate = now;
      const main = camera.mainCamera;
      const forward = inverse.transformVector(main.forward).normalize();
      const right = inverse.transformVector(main.right).normalize(), up = inverse.transformVector(main.up).normalize();
      const height = app.graphicsDevice.height, aspect = app.graphicsDevice.width / Math.max(1, height);
      const next = [...position.toArray(), ...forward.toArray(), ...up.toArray(), height, aspect, camera.camera.fov].map(v => v.toFixed(3)).join(',');
      if (signature !== next) {
        signature = next;
        tiles = planEarthTiles(anchor, { position, forward, right, up, fov: camera.camera.fov, height, aspect });
      }
      stream.setTiles(tiles); sync();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const key of meshes.keys()) remove(key);
      stream.dispose(); root.destroy(); baseMaterial.destroy();
    },
  };
}
