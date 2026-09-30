/**
 * GPU-resident execution of the analysis kernels.
 *
 * Data is uploaded once per tile and stays on the device; switching between
 * natural colour, NDVI, and change costs a uniform write, not a re-upload.
 * Readback is explicit (`readback`) and copies through a MAP_READ staging
 * buffer, so the render path never stalls on a synchronous map.
 */

import {
  NDVI_EPSILON,
  packMask,
  type IndexInputs,
  type NdviPlane,
} from '../analysis/AnalysisPipelines';
import analysisShader from './shaders/analysis.wgsl?raw';

const WORKGROUP_SIZE = 8;

/**
 * Value the GPU writes where a sample is not analytically valid.
 *
 * A sentinel rather than NaN, because a NaN written to a storage buffer is
 * legal but comparing it on readback costs a branch per pixel, and because a
 * sentinel keeps the whole output plane bit-reproducible. `readback` maps it
 * back to NaN so callers see exactly what the CPU path produces.
 */
const INVALID_SENTINEL = -9999.0;

/** A GPU buffer plus the element count it was sized for. */
export interface DevicePlane {
  buffer: GPUBuffer;
  elements: number;
}

export interface UploadedTile {
  width: number;
  height: number;
  /** Retained so readback can return the same shape the CPU path returns. */
  cpu: { red: Float32Array; nir: Float32Array };
  /** Red/nir interleaved, two float32 per pixel, matching `bands_a`. */
  bands: DevicePlane;
  /** All six mask planes concatenated: A.red, A.nir, A.quality, B.*. */
  masks: DevicePlane;
  ndvi: DevicePlane;
  ndviValid: DevicePlane;
  delta: DevicePlane;
  deltaValid: DevicePlane;
  /**
   * The comparison date, if one has been uploaded for *this* tile.
   *
   * Per tile rather than per pipeline. A single global B looked reasonable for
   * one tile at a time, but the renderer holds a whole viewport of tiles, and
   * the global silently overwrote the previous tile's comparison data -- so
   * swipe and difference would have shown date A against itself for every tile
   * but the most recently uploaded.
   */
  second: DevicePlane | null;
}

export class NdviGpu {
  readonly device: GPUDevice;

  #ndviPipeline: GPUComputePipeline | null = null;
  #deltaPipeline: GPUComputePipeline | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #layout: GPUBindGroupLayout | null = null;
  #emptyBuffer: GPUBuffer | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  get ready(): boolean {
    return this.#ndviPipeline !== null;
  }

  /** Compile the pipelines. Idempotent. */
  async initialise(): Promise<void> {
    if (this.#ndviPipeline) return;
    const module = this.device.createShaderModule({ code: analysisShader, label: 'analysis' });

    // Compilation diagnostics are raised eagerly. A pipeline error that only
    // appears at dispatch time is close to undiagnosable.
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        `analysis.wgsl failed to compile:\n${errors
          .map((m) => `  ${m.lineNum}:${m.linePos} ${m.message}`)
          .join('\n')}`,
      );
    }

    // The binding list is fixed by the shader, so the layout is explicit
    // rather than 'auto'. 'auto' mints a fresh, incompatible layout per
    // pipeline, and the two entry points have to share one.
    // Eight storage buffers, not sixteen. WebGPU only guarantees
    // `maxStorageBuffersPerShaderStage >= 8`, so a 16-binding layout is invalid
    // on a conformant device and the shader would never run. See the budget note
    // at the top of analysis.wgsl.
    this.#layout = this.device.createBindGroupLayout({
      label: 'analysis-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...[1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' as const },
        })),
        ...[4, 5, 6, 7].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' as const },
        })),
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.#layout],
    });
    this.#ndviPipeline = await this.device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'main' },
      label: 'ndvi',
    });
    this.#deltaPipeline = await this.device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'delta' },
      label: 'delta-ndvi',
    });
    this.#uniformBuffer = this.device.createBuffer({
      // 32 bytes: the struct gained `words_per_row` for the word-major dispatch,
      // and WGSL rounds a uniform struct up to 16-byte alignment.
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'analysis-uniforms',
    });
    // Bound in place of the second date when there is none. Must be a real
    // storage buffer: WebGPU rejects a zero-sized binding outright.
    this.#emptyBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'unused-binding',
    });
  }

  /** Upload the primary date. The returned tile owns its buffers. */
  uploadTile(inputs: IndexInputs): UploadedTile {
    this.#assertReady();
    const pixels = inputs.width * inputs.height;
    const store = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    // The validity outputs need COPY_DST because each run clears them: the
    // kernels now store whole words rather than ORing bits in, but clearing is
    // still mandatory so a tile recomputed after a different epsilon cannot
    // report a stale pixel as valid.
    const out = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

    // Interleaved red/nir, two float32 per pixel.
    const bands = this.#plane(pixels * 8, pixels * 2, store, 'bands-a');
    // All six mask planes, so a second date lands in the same buffer.
    const masks = this.#plane(packedBytes(pixels) * 6, packedBytes(pixels) * 6, store, 'masks');

    this.#write(bands.buffer, interleaveBands(inputs.red, inputs.nir));
    this.#writeMasks(masks.buffer, inputs.redValid, inputs.nirValid, inputs.qualityValid, 0);

    const tile: UploadedTile = {
      width: inputs.width,
      height: inputs.height,
      cpu: { red: inputs.red, nir: inputs.nir },
      bands,
      masks,
      ndvi: this.#plane(pixels * 4, pixels, out, 'ndvi'),
      ndviValid: this.#plane(packedBytes(pixels), pixels, out, 'ndvi-valid'),
      delta: this.#plane(pixels * 4, pixels, out, 'delta'),
      deltaValid: this.#plane(packedBytes(pixels), pixels, out, 'delta-valid'),
      second: null,
    };
    return tile;
  }

  /**
   * Upload the comparison date for one tile. Required before the delta entry
   * point for that tile.
   */
  uploadSecondDate(tile: UploadedTile, inputs: IndexInputs): void {
    this.#assertReady();
    if (inputs.width !== tile.width || inputs.height !== tile.height) {
      // Writing B at A's dimensions would read past the end of the plane, and
      // the out-of-range reads are zeros -- which look exactly like a fully
      // masked-out date rather than an error.
      throw new Error(
        `second date is ${inputs.width}x${inputs.height}, tile is ${tile.width}x${tile.height}`,
      );
    }
    const pixels = inputs.width * inputs.height;
    const store = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.clearSecondDate(tile);
    const bands = this.#plane(pixels * 8, pixels * 2, store, 'bands-b');
    this.#write(bands.buffer, interleaveBands(inputs.red, inputs.nir));
    // B's mask planes live in A's buffer, after A's three, so the shader derives
    // both offsets from one stride.
    this.#writeMasks(
      tile.masks.buffer,
      inputs.redValid,
      inputs.nirValid,
      inputs.qualityValid,
      packedBytes(pixels) * 3,
    );
    tile.second = bands;
  }

  /** Drop one tile's comparison date. */
  clearSecondDate(tile: UploadedTile): void {
    tile.second?.buffer.destroy();
    tile.second = null;
  }

  /**
   * Run NDVI for one tile.
   *
   * Results land in the tile's own buffers, so a resident tile keeps its
   * computed index without recompute when the user switches layers.
   */
  runNdvi(tile: UploadedTile, epsilon = NDVI_EPSILON): void {
    const pipeline = this.#ndviPipeline;
    const uniforms = this.#uniformBuffer;
    if (!pipeline || !uniforms) {
      throw new Error('NdviGpu.initialise() must complete before use.');
    }
    this.#writeUniforms(uniforms, tile, epsilon);
    // The shader only ever ORs bits in, so a stale validity word from a
    // previous run would leak into this one. Clearing is mandatory, not
    // defensive.
    this.device.queue.writeBuffer(
      tile.ndviValid.buffer,
      0,
      new Uint8Array(tile.ndviValid.buffer.size),
    );

    const encoder = this.device.createCommandEncoder({ label: 'ndvi' });
    const pass = encoder.beginComputePass({ label: 'ndvi-pass' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#bindGroup(tile, false));
    dispatch(pass, tile);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Run the two-date difference.
   *
   * Clears the primary validity mask too: the delta kernel reports validity
   * through the same binding, so leaving the NDVI bits set would label a
   * pixel valid when only the first date was observable.
   */
  runDelta(tile: UploadedTile, epsilon = NDVI_EPSILON): void {
    const pipeline = this.#deltaPipeline;
    const uniforms = this.#uniformBuffer;
    if (!pipeline || !uniforms) {
      throw new Error('NdviGpu.initialise() must complete before use.');
    }
    if (!tile.second) {
      throw new Error('runDelta() requires uploadSecondDate(tile, ...) for this tile.');
    }
    this.#writeUniforms(uniforms, tile, epsilon);
    this.device.queue.writeBuffer(
      tile.ndviValid.buffer,
      0,
      new Uint8Array(tile.ndviValid.buffer.size),
    );
    this.device.queue.writeBuffer(
      tile.deltaValid.buffer,
      0,
      new Uint8Array(tile.deltaValid.buffer.size),
    );

    const encoder = this.device.createCommandEncoder({ label: 'delta' });
    const pass = encoder.beginComputePass({ label: 'delta-pass' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#bindGroup(tile, true));
    dispatch(pass, tile);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  #bindGroup(tile: UploadedTile, withSecond: boolean): GPUBindGroup {
    const layout = this.#layout;
    const uniforms = this.#uniformBuffer;
    const empty = this.#emptyBuffer;
    if (!layout || !uniforms || !empty) {
      throw new Error('NdviGpu.initialise() must complete before use.');
    }
    // The NDVI entry point never reads `bands_b`, but the layout is shared with
    // the delta entry point so both pipelines can use one layout. A real buffer
    // is required: WebGPU rejects a zero-sized binding outright.
    return this.device.createBindGroup({
      label: withSecond ? 'analysis-bind-delta' : 'analysis-bind',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: { buffer: tile.bands.buffer } },
        { binding: 2, resource: { buffer: tile.masks.buffer } },
        { binding: 3, resource: { buffer: withSecond && tile.second ? tile.second.buffer : tile.bands.buffer } },
        { binding: 4, resource: { buffer: tile.ndvi.buffer } },
        { binding: 5, resource: { buffer: tile.ndviValid.buffer } },
        { binding: 6, resource: { buffer: tile.delta.buffer } },
        { binding: 7, resource: { buffer: tile.deltaValid.buffer } },
      ],
    });
  }

  #writeUniforms(uniforms: GPUBuffer, tile: UploadedTile, epsilon: number): void {
    const wordsPerRow = Math.ceil(tile.width / 4);
    this.device.queue.writeBuffer(uniforms, 0, new Uint32Array([tile.width, tile.height]));
    this.device.queue.writeBuffer(uniforms, 8, new Float32Array([epsilon, INVALID_SENTINEL]));
    // The kernels dispatch one invocation per packed mask word, so they need the
    // row length in words and the plane stride. An undefined `words_per_row`
    // would be a zero-work dispatch that reads as "all invalid" rather than as
    // an error, so both are written explicitly.
    this.device.queue.writeBuffer(
      uniforms,
      16,
      new Uint32Array([wordsPerRow, wordsPerRow * tile.height, 0, 0]),
    );
  }

  /**
   * Copy a computed plane back to the CPU.
   *
   * Explicit, and never on the render path. One buffer copy plus one map; the
   * caller is asking for the numbers, not for a frame.
   */
  async readback(tile: UploadedTile, plane: 'ndvi' | 'delta' = 'ndvi'): Promise<NdviPlane> {
    this.#assertReady();
    const pixels = tile.width * tile.height;
    const source = plane === 'ndvi' ? tile.ndvi : tile.delta;
    const validSource = plane === 'ndvi' ? tile.ndviValid : tile.deltaValid;

    const valueStaging = this.device.createBuffer({
      size: source.buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const validStaging = this.device.createBuffer({
      size: validSource.buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder({ label: 'readback' });
    encoder.copyBufferToBuffer(source.buffer, 0, valueStaging, 0, source.buffer.size);
    encoder.copyBufferToBuffer(validSource.buffer, 0, validStaging, 0, validSource.buffer.size);
    this.device.queue.submit([encoder.finish()]);

    await Promise.all([
      valueStaging.mapAsync(GPUMapMode.READ),
      validStaging.mapAsync(GPUMapMode.READ),
    ]);
    const value = new Float32Array(valueStaging.getMappedRange().slice(0));
    const packed = new Uint32Array(validStaging.getMappedRange().slice(0));
    valueStaging.unmap();
    validStaging.unmap();
    valueStaging.destroy();
    validStaging.destroy();

    const valid = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i += 1) {
      const lane = (packed[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
      valid[i] = lane === 0 ? 0 : 1;
      // Map the sentinel back to NaN so the GPU path returns the same thing
      // the CPU path does. Without this, any parity comparison would be
      // comparing 0.1 against -9999 and look like a catastrophic bug.
      if (valid[i] === 0) value[i] = Number.NaN;
    }
    return { red: tile.cpu.red, nir: tile.cpu.nir, value, valid };
  }

  destroyTile(tile: UploadedTile): void {
    this.clearSecondDate(tile);
    for (const plane of [tile.bands, tile.masks, tile.ndvi, tile.ndviValid, tile.delta, tile.deltaValid]) {
      plane.buffer.destroy();
    }
  }

  destroy(): void {
    this.#ndviPipeline = null;
    this.#deltaPipeline = null;
    this.#uniformBuffer?.destroy();
    this.#uniformBuffer = null;
    this.#emptyBuffer?.destroy();
    this.#emptyBuffer = null;
  }

  #assertReady(): void {
    if (!this.#ndviPipeline) {
      throw new Error('NdviGpu.initialise() must complete before use.');
    }
  }

  #plane(size: number, elements: number, usage: GPUBufferUsageFlags, label: string): DevicePlane {
    return {
      buffer: this.device.createBuffer({ size, usage, label }),
      elements,
    };
  }

  #write(buffer: GPUBuffer, data: Float32Array): void {
    this.device.queue.writeBuffer(buffer, 0, toArrayBufferView(data));
  }

  /**
   * Pack three validity masks into one buffer at a plane offset.
   *
   * The three masks of a date are always stored together, so the shader can
   * derive the plane stride from `plane_words` instead of needing three
   * separate bindings -- which is what keeps the layout inside the 8-buffer
   * WebGPU minimum.
   */
  #writeMasks(buffer: GPUBuffer, a: Uint8Array, b: Uint8Array, c: Uint8Array, planeOffset: number): void {
    const stride = packedBytes(a.length);
    const packed = new Uint32Array((stride * 3) / 4);
    // Written as bytes so the four-lane packing matches the shader's
    // `(index & 3) * 8` byte-lane indexing exactly.
    const bytes = new Uint8Array(packed.buffer);
    bytes.set(toBytes(packMask(a)), planeOffset);
    bytes.set(toBytes(packMask(b)), planeOffset + stride);
    bytes.set(toBytes(packMask(c)), planeOffset + stride * 2);
    this.device.queue.writeBuffer(buffer, planeOffset, toArrayBufferView(packed));
  }

}

/**
 * Re-view a typed array as backed by a plain `ArrayBuffer`.
 *
 * `GPUQueue.writeBuffer` accepts only `ArrayBufferView<ArrayBuffer>`, and
 * TypeScript will not narrow a `Float32Array` that might be backed by a
 * `SharedArrayBuffer`. Decoded tiles are never shared, so copying the
 * reference through a non-shared view is safe and keeps the types honest.
 */
function toArrayBufferView(view: Float32Array | Uint32Array): GPUAllowSharedBufferSource {
  // `view.buffer` is typed `ArrayBufferLike`; the runtime check is what lets
  // the compiler see a plain `ArrayBuffer` on the fast path.
  if (view.buffer instanceof ArrayBuffer) return view as Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  // Only reachable if a caller handed in shared memory, which nothing here
  // does; copy into a plain buffer so the upload is type-correct.
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer as SharedArrayBuffer, view.byteOffset, view.byteLength));
  return view instanceof Float32Array ? new Float32Array(copy.buffer) : new Uint32Array(copy.buffer);
}

function packedBytes(pixels: number): number {
  return Math.ceil(pixels / 4) * 4;
}

/**
 * Interleave red and nir into the `bands_a` / `bands_b` layout.
 *
 * One 8-byte adjacent pair per pixel rather than two 4-byte planes, so the
 * shader's two reads for a pixel land in the same cache line. This also halves
 * the storage-buffer count, which is what keeps the layout inside the 8-buffer
 * WebGPU minimum.
 */
function interleaveBands(red: Float32Array, nir: Float32Array): Float32Array {
  const n = red.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    out[i * 2] = red[i];
    out[i * 2 + 1] = nir[i];
  }
  return out;
}

/** Byte view of a packed mask, matching the shader's byte-lane indexing. */
function toBytes(packed: Uint32Array): Uint8Array {
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
}

/**
 * One invocation per packed mask word: ceil(width / 4) by height workgroups of
 * 8x8. The x dimension is in words, not pixels, because the shader gives each
 * invocation all four lanes of a word so that a validity word has exactly one
 * writer.
 */
function dispatch(pass: GPUComputePassEncoder, tile: UploadedTile): void {
  pass.dispatchWorkgroups(
    Math.ceil(Math.ceil(tile.width / 4) / WORKGROUP_SIZE),
    Math.ceil(tile.height / WORKGROUP_SIZE),
  );
}
