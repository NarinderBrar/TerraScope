/**
 * Entry point for the real-browser WebGPU parity run.
 *
 * This is bundled by `scripts/run-gpu-parity.mjs` and loaded in a headless
 * Chrome, so it must import the *same* modules the app ships. Nothing here
 * re-implements NDVI: the point of the run is that the production shader, bind
 * group layout, uniform packing, and readback path execute on a real WebGPU
 * implementation and agree with the Python fixture.
 *
 * Results are parked on `window.__parity` for the runner to collect.
 */

import { NDVI_EPSILON, computeNdviPlane, summarise } from '../../src/analysis/AnalysisPipelines';
import { NdviGpu } from '../../src/gpu/AnalysisKernels';
import { GpuContext, WebGpuUnavailable } from '../../src/gpu/GpuContext';
import tileShader from '../../src/gpu/shaders/tile.wgsl?raw';
import { CPU_REFERENCE_BASE64, CPU_REFERENCE_META } from './referenceFixture';
import { decodeReferenceBase64 } from './referenceLoader';

/** Matches the plan's parity tolerance. */
const TOLERANCE = 1e-5;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

declare global {
  interface Window {
    __parity?: { pass: boolean; checks: Check[]; adapter: unknown; error: string | null };
  }
}

async function run(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail = '') => {
    checks.push({ name, pass, detail });
  };

  const fixture = await decodeReferenceBase64(CPU_REFERENCE_BASE64, CPU_REFERENCE_META);
  const pixels = fixture.width * fixture.height;

  // The fixture was generated with the server's epsilon. Running the GPU with a
  // different one would compare two different questions and still look close, so
  // this is checked rather than assumed.
  add(
    'fixture epsilon matches the production NDVI_EPSILON',
    CPU_REFERENCE_META.epsilon === NDVI_EPSILON,
    `${CPU_REFERENCE_META.epsilon} vs ${NDVI_EPSILON}`,
  );

  const indexInputs = {
    red: fixture.red,
    nir: fixture.nir,
    green: fixture.green,
    blue: fixture.blue,
    redValid: fixture.redMask,
    nirValid: fixture.nirMask,
    qualityValid: fixture.quality,
    width: fixture.width,
    height: fixture.height,
  };

  // ---- the JS implementation, for the three-way comparison ---------------
  const cpu = computeNdviPlane(indexInputs);
  {
    let mismatches = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (cpu.valid[i] !== fixture.ndviValid[i]) mismatches += 1;
    }
    add('JS validity matches the Python reference', mismatches === 0, `${mismatches} mismatches of ${pixels}`);
    let worst = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (fixture.ndviValid[i] !== 1) continue;
      worst = Math.max(worst, Math.abs(cpu.value[i] - fixture.ndvi[i]));
    }
    add('JS values match the Python reference', worst <= TOLERANCE, `worst |d| = ${worst.toExponential(3)}`);
  }

  // ---- the GPU ------------------------------------------------------------
  const context = await GpuContext.create();
  const kernels = new NdviGpu(context.device);

  // Errors are scoped around the whole run: an uncaptured validation error
  // here would otherwise surface as a silently wrong plane.
  await context.captureErrors('ndvi-gpu-parity', async () => {
    // tile.wgsl has no host wrapper yet, so nothing else compiles it. A render
    // shader that has never been handed to a compiler is not a shader, it is a
    // text file, and this project already shipped one broken copy of it.
    const tileModule = context.device.createShaderModule({ code: tileShader, label: 'tile' });
    const tileInfo = await tileModule.getCompilationInfo();
    const tileErrors = tileInfo.messages.filter((m) => m.type === 'error');
    add('tile.wgsl compiles', tileErrors.length === 0, tileErrors.map((m) => `${m.lineNum}: ${m.message}`).join('; '));

    await kernels.initialise();
    add('analysis.wgsl compiled and both pipelines built', kernels.ready);
    const tile = kernels.uploadTile(indexInputs);
    kernels.runNdvi(tile, CPU_REFERENCE_META.epsilon);
    const gpu = await kernels.readback(tile, 'ndvi');

    let mismatches = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (gpu.valid[i] !== fixture.ndviValid[i]) mismatches += 1;
    }
    add('GPU validity matches the Python reference exactly', mismatches === 0, `${mismatches} mismatches of ${pixels}`);

    let worstPython = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (gpu.valid[i] !== 1) continue;
      worstPython = Math.max(worstPython, Math.abs(gpu.value[i] - fixture.ndvi[i]));
    }
    add(`GPU values match the Python reference to ${TOLERANCE}`, worstPython <= TOLERANCE, `worst |d| = ${worstPython.toExponential(3)}`);

    let worstCpu = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (gpu.valid[i] !== 1) continue;
      worstCpu = Math.max(worstCpu, Math.abs(gpu.value[i] - cpu.value[i]));
    }
    add(`GPU values match the JS implementation to ${TOLERANCE}`, worstCpu <= TOLERANCE, `worst |d| = ${worstCpu.toExponential(3)}`);

    // readback maps the sentinel back to NaN. If that stopped happening every
    // invalid pixel would read as -9999 and the value checks above would look
    // catastrophic -- but a partial regression could hide, so assert directly.
    let notNaN = 0;
    let nanCount = 0;
    for (let i = 0; i < pixels; i += 1) {
      if (gpu.valid[i] === 0) {
        nanCount += 1;
        if (!Number.isNaN(gpu.value[i])) notNaN += 1;
      }
    }
    add('every invalid sample reads back as NaN', notNaN === 0 && nanCount > 0, `${notNaN} not NaN of ${nanCount} invalid`);
    add('readback preserved the sentinel contract (no valid pixel is NaN)', !containsNaN(gpu.value, gpu.valid));

    const stats = summarise(gpu.value, gpu.valid);
    const refStats = summarise(fixture.ndvi, fixture.ndviValid);
    add('valid sample count matches', stats.valid === refStats.valid, `${stats.valid} vs ${refStats.valid}`);
    add('mean matches', Math.abs(stats.mean - refStats.mean) <= TOLERANCE, `${stats.mean.toFixed(8)} vs ${refStats.mean.toFixed(8)}`);
    add('min matches', Math.abs(stats.min - refStats.min) <= TOLERANCE, `${stats.min} vs ${refStats.min}`);
    add('max matches', Math.abs(stats.max - refStats.max) <= TOLERANCE, `${stats.max} vs ${refStats.max}`);

    // A run where nothing was valid would pass every value comparison above
    // while proving nothing, so the coverage floor is asserted explicitly.
    add('the fixture is not vacuous', stats.valid > pixels * 0.5, `${((100 * stats.valid) / pixels).toFixed(1)}% valid`);
    add('all values are inside the physical NDVI range', stats.min >= -1 && stats.max <= 1, `[${stats.min.toFixed(6)}, ${stats.max.toFixed(6)}]`);

    kernels.destroyTile(tile);
  });

  kernels.destroy();
  context.destroy();

  const info = context.info;
  window.__parity = {
    pass: checks.every((c) => c.pass),
    checks,
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      device: info.device,
      limits: info.limits,
      features: info.features,
    },
    error: null,
  };
}

function containsNaN(values: Float32Array, valid: Uint8Array): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (valid[i] === 1 && Number.isNaN(values[i])) return true;
  }
  return false;
}

run().catch((error: unknown) => {
  const reason =
    error instanceof WebGpuUnavailable ? `WebGPU unavailable (${error.reason}): ${error.message}` : String(error);
  window.__parity = { pass: false, checks: [], adapter: null, error: reason };
});
