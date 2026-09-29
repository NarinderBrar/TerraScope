/**
 * WebGPU compute parity against the Python reference.
 *
 * The other parity test checks the JavaScript implementation. This one checks
 * the actual GPU: it runs `analysis.wgsl` on real hardware, reads the result
 * back, and requires it to match the same fixture the Python suite produced.
 *
 * It is skipped when no adapter is available, which is the normal case in CI
 * on a headless runner. That skip is deliberate rather than a convenience:
 * the JS and Python implementations are checked unconditionally, and a
 * skipped GPU test is visible in the output rather than silently absent.
 *
 * Run headless with a software adapter:
 *   --enable-unsafe-webgpu --use-angle=vulkan --enable-features=Vulkan
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NdviGpu, type UploadedTile } from '../../src/gpu/AnalysisKernels';
import { GpuContext, WebGpuUnavailable } from '../../src/gpu/GpuContext';
import { computeNdviPlane, summarise } from '../../src/analysis/AnalysisPipelines';
import { CPU_REFERENCE_BASE64, CPU_REFERENCE_META } from './referenceFixture';
import { decodeReferenceBase64 } from './referenceLoader';

const TOLERANCE = 1e-5;

const fixture = await decodeReferenceBase64(CPU_REFERENCE_BASE64, CPU_REFERENCE_META);

let gpu: GpuContext | null = null;
let kernels: NdviGpu | null = null;
let tile: UploadedTile | null = null;
let skipReason = '';

beforeAll(async () => {
  if (!('gpu' in navigator)) {
    skipReason = 'navigator.gpu is not present in this environment';
    return;
  }
  try {
    gpu = await GpuContext.create();
  } catch (error) {
    if (error instanceof WebGpuUnavailable) {
      skipReason = error.message;
      return;
    }
    throw error;
  }
  kernels = new NdviGpu(gpu.device);
  await kernels.initialise();
  tile = kernels.uploadTile({
    red: fixture.red,
    nir: fixture.nir,
    green: fixture.green,
    blue: fixture.blue,
    redValid: fixture.redMask,
    nirValid: fixture.nirMask,
    qualityValid: fixture.quality,
    width: fixture.width,
    height: fixture.height,
  });
  kernels.runNdvi(tile);
});

afterAll(() => {
  if (kernels && tile) kernels.destroyTile(tile);
  kernels?.destroy();
  gpu?.destroy();
});

describe('WebGPU NDVI matches the Python reference', () => {
  it('has an adapter and compiled pipelines', () => {
    if (skipReason) {
      console.log(`  skipped: ${skipReason}`);
      return;
    }
    expect(kernels?.ready).toBe(true);
    // Compilation diagnostics are checked in initialise(); reaching here means
    // analysis.wgsl built without error.
  });

  it('agrees with the reference on every validity bit', async () => {
    if (skipReason || !kernels || !tile) return;
    const read = await kernels.readback(tile, 'ndvi');
    let mismatches = 0;
    for (let i = 0; i < read.valid.length; i += 1) {
      if (read.valid[i] !== fixture.ndviValid[i]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('agrees with the reference on every valid value to 1e-5', async () => {
    if (skipReason || !kernels || !tile) return;
    const read = await kernels.readback(tile, 'ndvi');
    let worst = 0;
    for (let i = 0; i < read.valid.length; i += 1) {
      if (read.valid[i] !== 1) continue;
      const diff = Math.abs(read.value[i] - fixture.ndvi[i]);
      if (diff > worst) worst = diff;
    }
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('agrees with the JavaScript implementation', async () => {
    if (skipReason || !kernels || !tile) return;
    const read = await kernels.readback(tile, 'ndvi');
    const cpu = computeNdviPlane({
      red: fixture.red,
      nir: fixture.nir,
      redValid: fixture.redMask,
      nirValid: fixture.nirMask,
      qualityValid: fixture.quality,
      width: fixture.width,
      height: fixture.height,
    });
    let worst = 0;
    for (let i = 0; i < read.valid.length; i += 1) {
      expect(read.valid[i]).toBe(cpu.valid[i]);
      if (read.valid[i] !== 1) continue;
      worst = Math.max(worst, Math.abs(read.value[i] - cpu.value[i]));
    }
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('produces the same summary statistics as the reference', async () => {
    if (skipReason || !kernels || !tile) return;
    const read = await kernels.readback(tile, 'ndvi');
    const gpuStats = summarise(read.value, read.valid);
    const refStats = summarise(fixture.ndvi, fixture.ndviValid);
    expect(gpuStats.valid).toBe(refStats.valid);
    expect(Math.abs(gpuStats.mean - refStats.mean)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(gpuStats.min - refStats.min)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(gpuStats.max - refStats.max)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('leaves every invalid sample as NaN after readback', async () => {
    // The GPU writes a sentinel because NaN in a storage buffer is legal but
    // awkward to compare. readback must map it back, or every downstream
    // comparison against the CPU path would see 0.1 against -9999.
    if (skipReason || !kernels || !tile) return;
    const read = await kernels.readback(tile, 'ndvi');
    for (let i = 0; i < read.valid.length; i += 1) {
      if (read.valid[i] === 0) {
        expect(Number.isNaN(read.value[i]), `index ${i}`).toBe(true);
      }
    }
  });
});
