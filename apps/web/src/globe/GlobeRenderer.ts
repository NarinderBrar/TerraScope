import type { NumericTile } from '@terrascope/contracts';
import type { RenderSettings } from '../gpu/RasterRenderer';
import type { GpuContext } from '../gpu/GpuContext';
import { buildGlobeTileMesh } from './GlobeMesh';
import { globeViewProjection } from './GlobeMath';
import type { GlobeCamera, GlobeViewport } from './GlobeMath';
import type { GlobeTile } from './GlobeTiles';
import globeShader from './globe.wgsl?raw';

const TILE_SIZE = 256;
const BASE_ZOOM = 2;
const VERTEX_STRIDE = 20;
const PARAM_BYTES = 112;

export interface GlobeGpuTile {
  readonly key: string;
  readonly tile: GlobeTile;
  readonly bytes: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  sourceA: GPUTexture;
  sourceB: GPUTexture;
  maskA: GPUTexture;
  maskB: GPUTexture;
  baseBindGroup: GPUBindGroup;
  sceneBindGroup: GPUBindGroup;
  dispose(): void;
}

export interface GlobeDrawItem {
  key: string;
  tile: GlobeTile;
}

/** WebGPU globe compositor. It owns no application state or network requests. */
export class GlobeRenderer {
  readonly context: GpuContext;
  readonly canvas: HTMLCanvasElement;
  readonly basemap: GlobeGpuTile[] = [];

  #layout: GPUBindGroupLayout | null = null;
  #baseParams: GPUBuffer | null = null;
  #sceneParams: GPUBuffer | null = null;
  #basePipeline: GPURenderPipeline | null = null;
  #scenePipeline: GPURenderPipeline | null = null;
  #depth: GPUTexture | null = null;
  #width = 0;
  #height = 0;
  #destroyed = false;

  private constructor(canvas: HTMLCanvasElement, context: GpuContext) {
    this.canvas = canvas;
    this.context = context;
  }

  static async create(canvas: HTMLCanvasElement, context: GpuContext): Promise<GlobeRenderer> {
    const renderer = new GlobeRenderer(canvas, context);
    await renderer.initialise();
    return renderer;
  }

  async initialise(): Promise<void> {
    const device = this.context.device;
    const format = this.context.format;
    this.#layout = device.createBindGroupLayout({
      label: 'globe-tile-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
    const module = device.createShaderModule({ label: 'globe-shader', code: globeShader });
    this.#baseParams = this.#uniform('globe-base-params');
    this.#sceneParams = this.#uniform('globe-scene-params');
    const vertex = {
      module,
      entryPoint: 'vertexMain',
      buffers: [{
        arrayStride: VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
          { shaderLocation: 1, offset: 12, format: 'float32x2' as const },
        ],
      }],
    };
    const fragment = { module, entryPoint: 'fragmentMain', targets: [{ format }] };
    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    };
    this.#basePipeline = await device.createRenderPipelineAsync({
      label: 'globe-base-pipeline',
      layout: pipelineLayout,
      vertex,
      fragment,
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      depthStencil,
    });
    this.#scenePipeline = await device.createRenderPipelineAsync({
      label: 'globe-scene-pipeline',
      layout: pipelineLayout,
      vertex,
      fragment,
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      depthStencil: { ...depthStencil, depthWriteEnabled: false },
    });
    this.resize();
    await this.loadBaseImagery();
  }

  resize(): void {
    if (this.#destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width === width && this.canvas.height === height && this.#depth) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.#width = width;
    this.#height = height;
    this.#depth?.destroy();
    this.#depth = this.context.device.createTexture({
      label: 'globe-depth',
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (this.context.configured) this.context.configure();
  }

  get dpr(): number {
    return this.#width / Math.max(1, this.canvas.clientWidth);
  }

  async loadBaseImagery(): Promise<void> {
    const device = this.context.device;
    const pending: Promise<void>[] = [];
    for (let y = 0; y < 2 ** BASE_ZOOM; y += 1) {
      for (let x = 0; x < 2 ** BASE_ZOOM; x += 1) {
        const bounds = xyzBounds(BASE_ZOOM, x, y);
        const tile: GlobeTile = {
          z: BASE_ZOOM,
          x,
          y,
          bounds,
          priority: 0,
          key: `base/${BASE_ZOOM}/${x}/${y}`,
        };
        pending.push(this.#loadBaseTile(tile));
      }
    }
    await Promise.allSettled(pending);
    void device;
  }

  /** Upload calibrated EOT1 bands and optional Date B into GPU tile resources. */
  uploadTile(key: string, tile: GlobeTile, a: NumericTile, b?: NumericTile): GlobeGpuTile {
    return this.#makeTile(key, tile, a, b ?? null, false);
  }

  render(
    camera: GlobeCamera,
    _viewport: GlobeViewport,
    settings: RenderSettings,
    tiles: readonly GlobeDrawItem[],
    get: (key: string) => GlobeGpuTile | undefined,
  ): void {
    if (this.#destroyed || !this.#basePipeline || !this.#scenePipeline || !this.#depth || !this.#layout) return;
    this.resize();
    const dprViewport = { width: this.#width, height: this.#height };
    const matrix = globeViewProjection(camera, dprViewport);
    this.context.device.queue.writeBuffer(
      this.#baseParams!,
      0,
      packParams(matrix, dprViewport, { ...settings, layer: 'natural', swipeEnabled: false }, false),
    );
    this.context.device.queue.writeBuffer(
      this.#sceneParams!,
      0,
      packParams(matrix, dprViewport, settings, tiles.some((item) => get(item.key)?.sourceB !== get(item.key)?.sourceA)),
    );

    let surface: GPUTextureView;
    try {
      surface = this.context.surface;
    } catch {
      return;
    }
    const encoder = this.context.device.createCommandEncoder({ label: 'globe-frame' });
    const pass = encoder.beginRenderPass({
      label: 'globe-pass',
      colorAttachments: [{
        view: surface,
        clearValue: { r: 0.012, g: 0.026, b: 0.055, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.#depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.#basePipeline);
    for (const item of this.basemap) this.#draw(pass, item, true);
    pass.setPipeline(this.#scenePipeline);
    for (const item of tiles) {
      const resource = get(item.key);
      if (resource) this.#draw(pass, resource, false);
    }
    pass.end();
    this.context.device.queue.submit([encoder.finish()]);
  }

  destroyTile(tile: GlobeGpuTile): void {
    tile.dispose();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const tile of this.basemap) tile.dispose();
    this.basemap.length = 0;
    this.#depth?.destroy();
    this.#baseParams?.destroy();
    this.#sceneParams?.destroy();
  }

  #uniform(label: string): GPUBuffer {
    return this.context.device.createBuffer({
      label,
      size: PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  #draw(pass: GPURenderPassEncoder, tile: GlobeGpuTile, base: boolean): void {
    pass.setBindGroup(0, base ? tile.baseBindGroup : tile.sceneBindGroup);
    pass.setVertexBuffer(0, tile.vertexBuffer);
    pass.setIndexBuffer(tile.indexBuffer, 'uint32');
    pass.drawIndexed(tile.indexCount);
  }

  async #loadBaseTile(tile: GlobeTile): Promise<void> {
    try {
      const url = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${tile.z}/${tile.y}/${tile.x}.jpg`;
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) return;
      const bitmap = await createImageBitmap(await response.blob());
      const texture = this.context.device.createTexture({
        label: tile.key,
        size: [bitmap.width, bitmap.height],
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.context.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
      bitmap.close();
      const masks = fullCoverageMask(this.context.device, TILE_SIZE, TILE_SIZE);
      const resource = this.#makeTile(tile.key, tile, null, null, true, texture, masks);
      this.basemap.push(resource);
    } catch {
      // The globe remains usable as a shaded sphere if this optional basemap
      // source is offline or blocks cross-origin requests.
    }
  }

  #makeTile(
    key: string,
    tile: GlobeTile,
    a: NumericTile | null,
    b: NumericTile | null,
    base: boolean,
    baseTexture?: GPUTexture,
    baseMask?: GPUTexture,
  ): GlobeGpuTile {
    const device = this.context.device;
    const mesh = buildGlobeTileMesh(tile);
    const vertexBuffer = device.createBuffer({
      label: `${key}-vertices`,
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const indexBuffer = device.createBuffer({
      label: `${key}-indices`,
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(mesh.vertices));
    device.queue.writeBuffer(indexBuffer, 0, new Uint32Array(mesh.indices));

    const sourceA = baseTexture ?? uploadBands(device, a!);
    const sourceB = base ? sourceA : (b ? uploadBands(device, b) : sourceA);
    const maskA = baseMask ?? uploadMasks(device, a!);
    const maskB = base ? maskA : (b ? uploadMasks(device, b) : maskA);
    const baseBindGroup = this.#bindGroup(this.#baseParams!, sourceA, sourceB, maskA, maskB);
    const sceneBindGroup = this.#bindGroup(this.#sceneParams!, sourceA, sourceB, maskA, maskB);
    const ownedTextures = base ? [sourceA, maskA] : [sourceA, ...(sourceB === sourceA ? [] : [sourceB]), maskA, ...(maskB === maskA ? [] : [maskB])];
    const byteCount = mesh.vertices.byteLength + mesh.indices.byteLength + (a ? a.header.width * a.header.height * 20 : TILE_SIZE * TILE_SIZE * 5);
    let disposed = false;
    return {
      key,
      tile,
      bytes: byteCount,
      vertexBuffer,
      indexBuffer,
      indexCount: mesh.indices.length,
      sourceA,
      sourceB,
      maskA,
      maskB,
      baseBindGroup,
      sceneBindGroup,
      dispose() {
        if (disposed) return;
        disposed = true;
        vertexBuffer.destroy();
        indexBuffer.destroy();
        for (const texture of ownedTextures) texture.destroy();
      },
    };
  }

  #bindGroup(params: GPUBuffer, a: GPUTexture, b: GPUTexture, ma: GPUTexture, mb: GPUTexture): GPUBindGroup {
    return this.context.device.createBindGroup({
      label: 'globe-tile-bind-group',
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: a.createView() },
        { binding: 2, resource: b.createView() },
        { binding: 3, resource: ma.createView() },
        { binding: 4, resource: mb.createView() },
      ],
    });
  }
}

function uploadBands(device: GPUDevice, tile: NumericTile): GPUTexture {
  const { width, height } = tile.header;
  const rgba = new Float32Array(width * height * 4);
  const bands = [tile.bands.red, tile.bands.green, tile.bands.blue, tile.bands.nir];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    for (let channel = 0; channel < 4; channel += 1) rgba[offset + channel] = bands[channel]?.[pixel] ?? 0;
  }
  const texture = device.createTexture({
    label: `eot1-${tile.header.grid.z}/${tile.header.grid.x}/${tile.header.grid.y}-bands`,
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, rgba, { bytesPerRow: width * 16, rowsPerImage: height }, [width, height]);
  return texture;
}

function uploadMasks(device: GPUDevice, tile: NumericTile): GPUTexture {
  const { width, height } = tile.header;
  const rgba = new Uint8Array(width * height * 4);
  const masks = [tile.masks['coverage:red'], tile.masks.quality, tile.masks.red, tile.masks.nir];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) rgba[pixel * 4 + channel] = masks[channel]?.[pixel] ? 255 : 0;
  }
  const texture = device.createTexture({
    label: `eot1-${tile.header.grid.z}/${tile.header.grid.x}/${tile.header.grid.y}-masks`,
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, rgba, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
  return texture;
}

function fullCoverageMask(device: GPUDevice, width: number, height: number): GPUTexture {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  const texture = device.createTexture({
    label: 'globe-basemap-mask',
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
  return texture;
}

function packParams(
  matrix: Float32Array,
  viewport: GlobeViewport,
  settings: RenderSettings,
  hasSecond: boolean,
): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAM_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < 16; i += 1) view.setFloat32(i * 4, matrix[i], true);
  view.setFloat32(64, viewport.width, true);
  view.setFloat32(68, viewport.height, true);
  view.setFloat32(72, settings.swipe, true);
  const layer = settings.layer === 'ndvi' ? 1
    : settings.layer === 'difference' ? 2
      : settings.layer === 'vegetation' ? 3
        : settings.layer === 'band' ? 4
          : settings.layer === 'false' ? 5 : 0;
  view.setUint32(76, layer, true);
  const band = settings.band === 'green' ? 1 : settings.band === 'blue' ? 2 : settings.band === 'nir' ? 3 : 0;
  view.setUint32(80, band, true);
  view.setUint32(84, hasSecond ? 1 : 0, true);
  view.setUint32(88, settings.swipeEnabled ? 1 : 0, true);
  view.setFloat32(92, settings.ndviMin, true);
  view.setFloat32(96, settings.ndviMax, true);
  view.setFloat32(100, settings.deltaRange, true);
  view.setFloat32(104, settings.gamma, true);
  view.setFloat32(108, settings.exposure, true);
  return buffer;
}

function xyzBounds(z: number, x: number, y: number): GlobeTile['bounds'] {
  const n = 2 ** z;
  const lon = (tx: number): number => tx / n * 360 - 180;
  const lat = (ty: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
