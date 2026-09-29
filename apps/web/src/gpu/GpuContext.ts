/**
 * Adapter/device lifecycle and capability probing.
 *
 * Everything the rest of the app is allowed to assume about the GPU is
 * established here, once, from queried limits -- never from a spec sheet.
 * A device that cannot filter `r32float` or lacks a large enough storage
 * buffer has to be detected before a shader module is compiled, because the
 * failure would otherwise surface as a validation error deep in a render pass
 * with no useful context.
 */

export interface GpuLimits {
  maxTextureDimension2D: number;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupsPerDimension: number;
  maxComputeInvocationsPerWorkgroup: number;
  maxSampledTexturesPerShaderStage: number;
  maxStorageTexturesPerShaderStage: number;
}

export interface GpuFeatures {
  /** r32float sampling is not core; without it we use textureLoad. */
  canFilterFloat32: boolean;
  timestampQuery: boolean;
  shaderF16: boolean;
}

export interface GpuContextInfo {
  vendor: string;
  architecture: string;
  description: string;
  device: string;
  limits: GpuLimits;
  features: GpuFeatures;
  /** Workgroup edge, chosen once and passed to every pipeline. */
  workgroupSize: number;
}

export class WebGpuUnavailable extends Error {
  override readonly name = 'WebGpuUnavailable';
  /** Machine-readable reason so the UI can offer the right advice. */
  readonly reason:
    | 'no-navigator-gpu'
    | 'no-adapter'
    | 'no-device'
    | 'no-context'
    | 'insecure-context';

  constructor(reason: WebGpuUnavailable['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface CanvasFormatInfo {
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /** Configure once; reconfiguring discards the swap chain. */
  configure(canvas: HTMLCanvasElement, alphaMode?: GPUCanvasAlphaMode): void;
}

export class GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly info: GpuContextInfo;

  #canvas: HTMLCanvasElement | null = null;
  #context: GPUCanvasContext | null = null;
  #format: GPUTextureFormat = 'bgra8unorm';
  #configured = false;
  #lost = false;
  #onLost: Array<(info: GPUDeviceLostInfo) => void> = [];
  #onError: Array<(message: string) => void> = [];
  #errorScopes = 0;

  private constructor(adapter: GPUAdapter, device: GPUDevice, info: GpuContextInfo) {
    this.adapter = adapter;
    this.device = device;
    this.info = info;

    device.lost.then((lost) => {
      // 'destroyed' is a deliberate teardown; anything else is a real loss and
      // the only correct response is to rebuild every resource.
      if (lost.reason !== 'destroyed') {
        this.#lost = true;
        for (const handler of this.#onLost) handler(lost);
      }
    });

    device.addEventListener('uncapturederror', (event) => {
      const error = (event as GPUUncapturedErrorEvent).error;
      for (const handler of this.#onError) handler(error.message);
    });
  }

  static async create(): Promise<GpuContext> {
    if (!('gpu' in navigator)) {
      throw new WebGpuUnavailable(
        globalThis.isSecureContext ? 'no-navigator-gpu' : 'insecure-context',
        globalThis.isSecureContext
          ? 'This browser does not expose navigator.gpu.'
          : 'WebGPU requires a secure context. Use HTTPS or localhost.',
      );
    }
    if (!globalThis.isSecureContext) {
      throw new WebGpuUnavailable(
        'insecure-context',
        'WebGPU requires a secure context. Use HTTPS or localhost.',
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new WebGpuUnavailable(
        'no-adapter',
        'No WebGPU adapter is available. The browser supports WebGPU but could not provide a GPU.',
      );
    }

    const features: GpuFeatures = {
      canFilterFloat32: adapter.features.has('float32-filterable'),
      timestampQuery: adapter.features.has('timestamp-query'),
      shaderF16: adapter.features.has('shader-f16'),
    };
    // Ask for the features we will actually branch on. Requesting a feature the
    // adapter lacks is a hard failure, so each is optional and gated by `has`.
    const required: GPUFeatureName[] = [];
    if (features.canFilterFloat32) required.push('float32-filterable');
    if (features.timestampQuery) required.push('timestamp-query');

    const device = await adapter.requestDevice({
      requiredFeatures: required,
      requiredLimits: pickLimits(adapter.limits),
      label: 'terrascope-device',
    });
    if (!device) {
      throw new WebGpuUnavailable('no-device', 'Failed to create a WebGPU device.');
    }

    const info: GpuContextInfo = {
      vendor: adapter.info?.vendor ?? 'unknown',
      architecture: adapter.info?.architecture ?? '',
      description: adapter.info?.description ?? '',
      device: adapter.info?.device ?? '',
      limits: {
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        maxBufferSize: device.limits.maxBufferSize,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
        maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup,
        maxSampledTexturesPerShaderStage: device.limits.maxSampledTexturesPerShaderStage,
        maxStorageTexturesPerShaderStage: device.limits.maxStorageTexturesPerShaderStage,
      },
      features,
      // 8x8 is the plan's starting choice: a full 8x8 warp of a float32 pixel
      // maps cleanly onto a 2x2 quad-wave without any cross-workgroup
      // communication, which this workload does not otherwise need.
      workgroupSize: 8,
    };
    return new GpuContext(adapter, device, info);
  }

  get lost(): boolean {
    return this.#lost;
  }

  /** Bind the canvas once. Calling again reconfigures the swap chain. */
  attachCanvas(canvas: HTMLCanvasElement): GPUTextureFormat {
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new WebGpuUnavailable('no-context', 'Could not acquire a webgpu canvas context.');
    }
    this.#canvas = canvas;
    this.#context = context;
    // bgra8unorm is what every desktop backend prefers; fall back only if the
    // implementation insists.
    this.#format = navigator.gpu.getPreferredCanvasFormat();
    return this.#format;
  }

  configure(alphaMode: GPUCanvasAlphaMode = 'opaque'): void {
    if (!this.#context || !this.#canvas) {
      throw new WebGpuUnavailable('no-context', 'configure() called before attachCanvas().');
    }
    this.#context.configure({
      device: this.device,
      format: this.#format,
      alphaMode,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    this.#configured = true;
  }

  get surface(): GPUTextureView {
    if (!this.#context || !this.#configured) {
      throw new WebGpuUnavailable('no-context', 'Canvas is not configured.');
    }
    return this.#context.getCurrentTexture().createView();
  }

  get format(): GPUTextureFormat {
    return this.#format;
  }

  onDeviceLost(handler: (info: GPUDeviceLostInfo) => void): void {
    this.#onLost.push(handler);
  }

  onError(handler: (message: string) => void): void {
    this.#onError.push(handler);
  }

  /**
   * Scope error capture around a block.
   *
   * WebGPU validation errors are otherwise asynchronous and unattributed,
   * which turns a bad bind group into an intermittent blank tile.
   */
  async captureErrors<T>(label: string, body: () => T | Promise<T>): Promise<T> {
    this.device.pushErrorScope('validation');
    this.device.pushErrorScope('internal');
    this.#errorScopes += 2;
    let thrown: unknown = null;
    let result!: T;
    try {
      result = await body();
    } catch (error) {
      thrown = error;
    }
    // Scopes are popped even when the body threw. A WebGPU validation error
    // normally *causes* the throw you see -- `createComputePipelineAsync`
    // rejects with "invalid PipelineLayout" and the message that says why is in
    // the scope, so reporting only the throw hides the actual fault.
    const internal = await this.device.popErrorScope();
    const validation = await this.device.popErrorScope();
    this.#errorScopes -= 2;

    const scopeError = internal ?? validation;
    if (thrown) {
      const detail = scopeError ? ` [underlying ${scopeError.message}]` : '';
      throw new Error(
        `${label} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}${detail}`,
        { cause: thrown },
      );
    }
    if (scopeError) {
      throw new Error(`${label}: ${scopeError.message}`);
    }
    return result;
  }

  destroy(): void {
    this.device.destroy();
  }
}

/**
 * Ask only for limits that are safe to request unconditionally.
 *
 * Requesting a device limit higher than the adapter supports is rejected
 * outright, so these are all clamped to the adapter's own maxima and only ask
 * for values that genuinely matter here: a large storage buffer for tile
 * uploads and a compute dimension large enough for a 256x256 dispatch.
 */
function pickLimits(adapterLimits: GPUSupportedLimits): Record<string, number> {
  const wanted: Record<string, number> = {
    maxTextureDimension2D: 8192,
    maxBufferSize: 256 * 1024 * 1024,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65535,
    maxComputeInvocationsPerWorkgroup: 256,
  };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(wanted)) {
    const supported = (adapterLimits as unknown as Record<string, number>)[key];
    if (typeof supported === 'number') {
      out[key] = Math.min(value, supported);
    }
  }
  return out;
}
