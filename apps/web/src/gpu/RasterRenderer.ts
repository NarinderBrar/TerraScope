/**
 * WebGPU tile compositor.
 *
 * Draws one textured quad per resident tile, choosing between natural colour,
 * false colour, NDVI, NDVI difference, a single band, and a two-date swipe.
 *
 * The design constraint that shapes everything here: `tile.wgsl` binds the
 * index plane and its validity mask as per-tile storage buffers, so a bind group
 * cannot be shared between tiles. That means one draw call per tile, and it is
 * why this class owns a bind group per uploaded tile rather than a single
 * pipeline-wide set of buffers.
 */

import { TILE_SIZE } from '@terrascope/contracts';
import { packMask } from '../analysis/AnalysisPipelines';
import type { NumericTile } from '@terrascope/contracts';
import type { UploadedTile } from './AnalysisKernels';
import type { GpuContext } from './GpuContext';
import { RAMP_BANDS, type RampBand } from '../ui/ramps';
import tileShader from './shaders/tile.wgsl?raw';

/** Layers `tile.wgsl` understands. Values must match the shader's `layer`. */
export type RenderLayer = 'natural' | 'false' | 'ndvi' | 'difference' | 'band' | 'vegetation';

export interface RenderSettings {
  layer: RenderLayer;
  /** Which band `layer === 'band'` shows. */
  band: RampBand;
  /** 0..1 divider position, as a fraction of viewport width. */
  swipe: number;
  /** Draw a two-date swipe rather than a single date. */
  swipeEnabled: boolean;
  /** Display gamma. 1 = none. Never touches analytical values. */
  gamma: number;
  /** Multiplies reflectance before display only. */
  exposure: number;
  /** Whether scene classification participates in analytical validity. */
  qualityMask: boolean;
  ndviMin: number;
  ndviMax: number;
  deltaRange: number;
}

/** One tile's position, in the same convention `visibleTiles` returns. */
export interface DrawTile {
  key: string;
  /** Top-left, in CSS pixels from the viewport's top-left. */
  screenX: number;
  screenY: number;
  /** Device pixels per world pixel at the current fractional zoom. */
  scale: number;
  /** Texture subsection used when a coarse parent stands in for this tile. */
  uv?: readonly [number, number, number, number];
  /**
   * Explicit on-screen size in CSS pixels, for a quad that is not a square
   * tile (a timelapse frame covering the viewport). Overrides `scale`.
   */
  size?: { width: number; height: number };
}

/** GPU resources for one resident tile. */
export interface RenderTile {
  width: number;
  height: number;
  /** rgba32float: r = red, g = green, b = blue, a = nir for Date A. */
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  /** B's bands, absent until a comparison date is uploaded. */
  textureB: GPUTexture | null;
  viewB: GPUTextureView | null;
  /** `coverage:red` from Date A header. Drives rendering, not analysis. */
  coverage: GPUBuffer | null;
  /** `coverage:red` from Date B header. */
  coverageB: GPUBuffer | null;
  /** Date A's compute output. NDVI lives on the GPU, never on the CPU. */
  analysisA: UploadedTile | null;
  /** Date B's compute output, when a comparison date is loaded. */
  analysisB: UploadedTile | null;
  bindGroup: GPUBindGroup;
  bindGroupSwipe: GPUBindGroup;
  /** Bounded CPU copy retained for explicit pixel inspection. */
  source: NumericTile | null;
  sourceB: NumericTile | null;
}

const FLOATS_PER_VERTEX = 6;
const VERTICES_PER_QUAD = 6;

/**
 * Max tiles drawn in one frame.
 *
 * A guard, not a scheduler. A pathological zoom or a huge viewport could
 * otherwise queue thousands of draws and stall the device.
 */
const MAX_TILES_PER_FRAME = 256;

/**
 * Bytes for the uniform buffer.
 *
 * The WGSL struct is nine 4-byte fields, and a uniform struct's size is
 * rounded up to its 16-byte alignment, so the minimum legal binding is 48 even
 * though only 36 bytes carry data. A 32-byte buffer is rejected at bind-group
 * creation with a validation error that says nothing about the struct size, and
 * a *larger* buffer is fine -- so this is allocated generously on purpose.
 */
const UNIFORM_BYTES = 48;

export class RasterRenderer {
  readonly context: GpuContext;

  #pipeline: GPURenderPipeline | null = null;
  #layout: GPUBindGroupLayout | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #vertexBuffer: GPUBuffer | null = null;
  #vertexCapacity = 0;
  #emptyBuffer: GPUBuffer | null = null;

  get ready(): boolean {
    return this.#pipeline !== null;
  }

  constructor(context: GpuContext) {
    this.context = context;
  }

  async initialise(): Promise<void> {
    if (this.#pipeline) return;
    const device = this.context.device;

    const module = device.createShaderModule({ code: tileShader, label: 'tile' });
    // Surface compile errors here rather than as a blank canvas later. This
    // shader once shipped with a helper that could not compile, and nothing
    // noticed for weeks because a shader module is not compiled until something
    // hands it to a pipeline.
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `tile.wgsl failed to compile:\n${errors
          .map((m) => `  ${m.lineNum}:${m.linePos} ${m.message}`)
          .join('\n')}`,
      );
    }

    this.#layout = device.createBindGroupLayout({
      label: 'tile-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        // 3..8 are the packed coverage masks and the index planes:
        // 3: coverage_a, 4: index_valid_a, 5: index_valid_b, 6: ndvi_a, 7: ndvi_b, 8: coverage_b
        ...[3, 4, 5, 6, 7, 8].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' as const },
        })),
      ],
    });

    this.#pipeline = await device.createRenderPipelineAsync({
      label: 'tile',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
              { shaderLocation: 2, offset: 16, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fragmentMain',
        // The canvas format, not rgba32float: an rgba32float render target is
        // not universally supported, and the canvas is never the precision
        // bottleneck for an 8-bit display.
        targets: [
          {
            format: this.context.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.#uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'tile-uniforms',
    });
    // A real buffer is required for every binding: WebGPU rejects a zero-sized
    // one outright. Stands in for B's texture and index planes before a
    // comparison date is loaded, so one bind group layout serves both paths.
    this.#emptyBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'tile-placeholder',
    });
  }

  /**
   * Upload a decoded tile for Date A and build its bind groups.
   * If `existing` is provided (e.g. Date B was uploaded first), updates `existing`.
   */
  upload(key: string, tile: NumericTile, analysisA: UploadedTile, existing?: RenderTile): RenderTile {
    const device = this.context.device;
    const { width, height } = tile.header;
    const pixels = width * height;

    const texture = device.createTexture({
      label: `tile-a:${key}`,
      size: { width, height },
      format: 'rgba32float',
      // TEXTURE_BINDING only: the shader uses textureLoad at exact texels, so
      // nothing ever samples or writes this texture.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      asSource(packBands(tile)),
      { bytesPerRow: width * 16, rowsPerImage: height },
      { width, height },
    );

    // `coverage:red` drives rendering. A pixel the sensor actually saw must not
    // be drawn as a hole just because it is unsuitable for NDVI -- that is what
    // the separate index validity mask is for.
    const coverageSource = tile.masks['coverage:red'] ?? tile.masks['coverage:nir'];
    if (!coverageSource) {
      texture.destroy();
      throw new Error(`tile ${key} has no coverage mask in its header`);
    }
    const coverage = device.createBuffer({
      label: `coverage-a:${key}`,
      size: packedBytes(pixels),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(coverage, 0, asSource(toBytes(packMask(coverageSource))));

    const view = texture.createView();

    if (existing) {
      existing.texture?.destroy();
      existing.coverage?.destroy();
      existing.texture = texture;
      existing.view = view;
      existing.coverage = coverage;
      existing.analysisA = analysisA;
      existing.source = tile;
      existing.bindGroup = this.#makeBindGroup(existing, false);
      existing.bindGroupSwipe = this.#makeBindGroup(existing, true);
      return existing;
    }

    const renderTile: RenderTile = {
      width,
      height,
      texture,
      view,
      textureB: null,
      viewB: null,
      coverage,
      coverageB: null,
      analysisA,
      analysisB: null,
      bindGroup: null as unknown as GPUBindGroup,
      bindGroupSwipe: null as unknown as GPUBindGroup,
      source: tile,
      sourceB: null,
    };
    renderTile.bindGroup = this.#makeBindGroup(renderTile, false);
    renderTile.bindGroupSwipe = renderTile.bindGroup;
    return renderTile;
  }

  /**
   * Upload a decoded tile for Date B and build its bind groups.
   * If `existing` is provided, updates `existing`.
   */
  uploadSecond(key: string, second: NumericTile, analysisB: UploadedTile, existing?: RenderTile): RenderTile {
    const device = this.context.device;
    const { width, height } = second.header;
    const pixels = width * height;

    const texture = device.createTexture({
      label: `tile-b:${key}`,
      size: { width, height },
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      asSource(packBands(second)),
      { bytesPerRow: width * 16, rowsPerImage: height },
      { width, height },
    );

    const coverageSource = second.masks['coverage:red'] ?? second.masks['coverage:nir'];
    if (!coverageSource) {
      texture.destroy();
      throw new Error(`tile ${key} has no coverage mask in its header`);
    }
    const coverage = device.createBuffer({
      label: `coverage-b:${key}`,
      size: packedBytes(pixels),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(coverage, 0, asSource(toBytes(packMask(coverageSource))));

    const view = texture.createView();

    if (existing) {
      existing.textureB?.destroy();
      existing.coverageB?.destroy();
      existing.textureB = texture;
      existing.viewB = view;
      existing.coverageB = coverage;
      existing.analysisB = analysisB;
      existing.sourceB = second;
      existing.bindGroupSwipe = this.#makeBindGroup(existing, true);
      existing.bindGroup = existing.bindGroupSwipe;
      return existing;
    }

    const renderTile: RenderTile = {
      width,
      height,
      texture: null,
      view: null,
      textureB: texture,
      viewB: view,
      coverage: null,
      coverageB: coverage,
      analysisA: null,
      analysisB,
      bindGroup: null as unknown as GPUBindGroup,
      bindGroupSwipe: null as unknown as GPUBindGroup,
      source: null,
      sourceB: second,
    };
    renderTile.bindGroup = this.#makeBindGroup(renderTile, false);
    renderTile.bindGroupSwipe = this.#makeBindGroup(renderTile, true);
    return renderTile;
  }

  /**
   * Attach a comparison date to a tile, enabling swipe and difference.
   */
  uploadSecondDate(tile: RenderTile, second: NumericTile, analysisB: UploadedTile): void {
    this.uploadSecond('', second, analysisB, tile);
  }

  releaseSecondDate(tile: RenderTile): void {
    tile.textureB?.destroy();
    tile.textureB = null;
    tile.viewB = null;
    tile.coverageB?.destroy();
    tile.coverageB = null;
    tile.analysisB = null;
    tile.sourceB = null;
    tile.bindGroup = this.#makeBindGroup(tile, false);
    tile.bindGroupSwipe = tile.bindGroup;
  }

  /**
   * Build a bind group from the tile's *current* resources.
   */
  #makeBindGroup(tile: RenderTile, withSecond: boolean): GPUBindGroup {
    if (!this.#layout || !this.#uniformBuffer) {
      throw new Error('RasterRenderer.initialise() must complete first.');
    }
    const a = tile.analysisA;
    const b = withSecond ? tile.analysisB : null;

    const activeViewA = tile.view ?? tile.viewB;
    const activeViewB = (b && tile.viewB) ?? tile.view ?? tile.viewB;
    const activeCoverageA = tile.coverage ?? tile.coverageB;
    const activeCoverageB = (b && tile.coverageB) ?? activeCoverageA;
    const activeValidA = a?.ndviValid.buffer ?? b?.ndviValid.buffer;
    const activeValidB = (b && b.ndviValid.buffer) ?? activeValidA;
    const activeNdviA = a?.ndvi.buffer ?? b?.ndvi.buffer;
    const activeNdviB = (b && b.ndvi.buffer) ?? activeNdviA;

    if (!activeViewA || !activeCoverageA || !activeValidA || !activeNdviA || !activeViewB || !activeCoverageB || !activeValidB || !activeNdviB) {
      throw new Error('RenderTile must have at least one date loaded.');
    }

    return this.context.device.createBindGroup({
      label: withSecond ? 'tile-bind-a+b' : 'tile-bind-a',
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: activeViewA },
        { binding: 2, resource: activeViewB },
        { binding: 3, resource: { buffer: activeCoverageA } },
        { binding: 4, resource: { buffer: activeValidA } },
        { binding: 5, resource: { buffer: activeValidB } },
        { binding: 6, resource: { buffer: activeNdviA } },
        { binding: 7, resource: { buffer: activeNdviB } },
        { binding: 8, resource: { buffer: activeCoverageB } },
      ],
    });
  }

  /**
   * Draw the given tiles.
   *
   * `viewport` is in CSS pixels; the uniform receives device pixels, because the
   * canvas backing store and the vertex positions are in device pixels. Mixing
   * the two is the classic "image is squeezed by the DPR" bug, so the
   * conversion happens here, once.
   */
  draw(
    tiles: DrawTile[],
    get: (key: string) => RenderTile | undefined,
    viewport: { width: number; height: number; dpr: number },
    settings: RenderSettings,
  ): { drawn: number; missing: number } {
    const pipeline = this.#pipeline;
    const uniform = this.#uniformBuffer;
    if (!pipeline || !uniform) throw new Error('RasterRenderer.initialise() must complete first.');
    if (tiles.length === 0) return { drawn: 0, missing: 0 };

    const device = this.context.device;
    const dpr = viewport.dpr;
    const deviceWidth = Math.max(1, Math.round(viewport.width * dpr));
    const deviceHeight = Math.max(1, Math.round(viewport.height * dpr));

    // Uniforms are per-frame state, identical for every tile. Writing them per
    // draw would be twenty-odd redundant uploads per frame.
    const hasSecond = tiles.some((t) => get(t.key)?.analysisB != null);
    device.queue.writeBuffer(uniform, 0, packUniforms(deviceWidth, deviceHeight, settings, hasSecond));

    const batches = tiles.slice(0, MAX_TILES_PER_FRAME);
    const scratch = new Float32Array(batches.length * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);
    const draws: Array<{ group: GPUBindGroup; firstVertex: number }> = [];
    let cursor = 0;
    let missing = 0;

    for (const item of batches) {
      const tile = get(item.key);
      if (!tile) {
        missing += 1;
        continue;
      }
      // CSS pixels from the top-left become device pixels from the centre, which
      // is what the vertex stage wants: small magnitudes, and no dependency on
      // where in the world the camera is.
      const originX = (item.screenX - viewport.width / 2) * dpr;
      const originY = (item.screenY - viewport.height / 2) * dpr;
      const extentX = (item.size ? item.size.width : TILE_SIZE * item.scale) * dpr;
      const extentY = (item.size ? item.size.height : TILE_SIZE * item.scale) * dpr;
      const firstVertex = cursor / FLOATS_PER_VERTEX;
      const [u0, v0, u1, v1] = item.uv ?? [0, 0, 1, 1];
      const hasA = tile.analysisA != null ? 1.0 : 0.0;
      const hasB = tile.analysisB != null ? 1.0 : 0.0;
      for (const [u, v] of QUAD) {
        scratch[cursor++] = originX + u * extentX;
        scratch[cursor++] = originY + v * extentY;
        scratch[cursor++] = u0 + u * (u1 - u0);
        scratch[cursor++] = v0 + v * (v1 - v0);
        scratch[cursor++] = hasA;
        scratch[cursor++] = hasB;
      }
      // Chosen here, not at draw time, so the group and the vertices in a
      // batch always describe the same date arrangement.
      draws.push({
        group: settings.swipeEnabled ? tile.bindGroupSwipe : tile.bindGroup,
        firstVertex,
      });
    }

    let vertexBuffer: GPUBuffer | null = null;
    if (draws.length > 0) {
      vertexBuffer = this.#ensureVertexBuffer(scratch.byteLength);
      device.queue.writeBuffer(vertexBuffer, 0, asSource(scratch), 0, cursor);
    }

    let surfaceView: GPUTextureView;
    try {
      surfaceView = this.context.surface;
    } catch {
      return { drawn: 0, missing };
    }

    const encoder = device.createCommandEncoder({ label: 'tiles' });
    const pass = encoder.beginRenderPass({
      label: 'tiles-pass',
      colorAttachments: [
        {
          view: surfaceView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    if (draws.length > 0 && vertexBuffer) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      for (const d of draws) {
        pass.setBindGroup(0, d.group);
        pass.draw(VERTICES_PER_QUAD, 1, d.firstVertex, 0);
      }
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    return { drawn: draws.length, missing };
  }

  destroyTile(tile: RenderTile): void {
    tile.texture?.destroy();
    tile.texture = null;
    tile.textureB?.destroy();
    tile.textureB = null;
    tile.coverage?.destroy();
    tile.coverage = null;
    tile.coverageB?.destroy();
    tile.coverageB = null;
  }

  destroy(): void {
    this.#vertexBuffer?.destroy();
    this.#uniformBuffer?.destroy();
    this.#emptyBuffer?.destroy();
    this.#vertexBuffer = null;
    this.#uniformBuffer = null;
    this.#emptyBuffer = null;
    this.#pipeline = null;
    this.#layout = null;
  }

  #ensureVertexBuffer(bytes: number): GPUBuffer {
    if (this.#vertexBuffer && this.#vertexCapacity >= bytes) return this.#vertexBuffer;
    this.#vertexBuffer?.destroy();
    // Rounded up so a slightly larger viewport does not reallocate every frame.
    this.#vertexCapacity = Math.max(bytes, 4096);
    this.#vertexBuffer = this.context.device.createBuffer({
      size: this.#vertexCapacity,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'tile-vertices',
    });
    return this.#vertexBuffer;
  }
}

/** Two triangles, uv origin top-left to match the decoded row order. */
const QUAD: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [0, 1],
  [0, 1], [1, 0], [1, 1],
];

const LAYER_INDEX: Record<RenderLayer, number> = {
  natural: 0,
  ndvi: 1,
  difference: 2,
  band: 3,
  false: 4,
  vegetation: 5,
};

/**
 * Lay out the WGSL uniform struct field by field.
 *
 * Offsets are spelled out rather than derived from a JS object because nothing
 * checks that a JS object's memory layout matches a WGSL struct's, and a silent
 * mismatch here shifts every field after the first.
 */
function packUniforms(
  deviceWidth: number,
  deviceHeight: number,
  settings: RenderSettings,
  hasSecond: boolean,
): ArrayBuffer {
  const buffer = new ArrayBuffer(UNIFORM_BYTES);
  const view = new DataView(buffer);
  view.setFloat32(0, deviceWidth, true);
  view.setFloat32(4, deviceHeight, true);
  view.setUint32(8, LAYER_INDEX[settings.layer], true);
  view.setFloat32(12, clamp01(settings.swipe), true);
  view.setUint32(16, RAMP_BANDS[settings.band], true);
  view.setUint32(20, hasSecond ? 1 : 0, true);
  view.setFloat32(24, Math.max(0, settings.gamma), true);
  // When swipe is enabled, the shader evaluates per-tile presence flags on each side of the divider.
  view.setUint32(28, settings.swipeEnabled ? 1 : 0, true);
  view.setFloat32(32, Math.max(0, settings.exposure), true);
  view.setFloat32(36, settings.ndviMin, true);
  view.setFloat32(40, Math.max(settings.ndviMin + 0.01, settings.ndviMax), true);
  view.setFloat32(44, Math.max(0.01, settings.deltaRange), true);
  return buffer;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Interleave a tile's bands into rgba32float order.
 *
 * Non-finite samples become 0. They are the out-of-band signal, and a NaN
 * reaching `displayEncode` would be clamped implementation-dependently -- which
 * is how a missing sample can end up drawn as a plausible dark pixel. The
 * coverage mask handles validity; the texture carries numbers only.
 */
function packBands(tile: NumericTile): Float32Array {
  const { width, height } = tile.header;
  const pixels = width * height;
  const out = new Float32Array(pixels * 4);
  const red = tile.bands['red'];
  const green = tile.bands['green'];
  const blue = tile.bands['blue'];
  const nir = tile.bands['nir'];
  for (let i = 0; i < pixels; i += 1) {
    out[i * 4] = finite(red?.[i]);
    out[i * 4 + 1] = finite(green?.[i]);
    out[i * 4 + 2] = finite(blue?.[i]);
    out[i * 4 + 3] = finite(nir?.[i]);
  }
  return out;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function packedBytes(pixels: number): number {
  return Math.ceil(pixels / 4) * 4;
}

function toBytes(packed: Uint32Array): Uint8Array {
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
}

/**
 * Re-view a typed array as backed by a plain `ArrayBuffer`.
 *
 * The WebGPU types accept only `ArrayBufferView<ArrayBuffer>`, and TypeScript
 * cannot narrow a `Float32Array` that might be `SharedArrayBuffer`-backed.
 * Decoded tiles are never shared, so the cast is safe and keeps the types
 * honest instead of widening every call site to `any`.
 */
function asSource(a: Float32Array | Uint8Array): GPUAllowSharedBufferSource {
  return a as Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer>;
}
