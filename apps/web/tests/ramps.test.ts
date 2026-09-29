/**
 * Legend ramps must match the shader.
 *
 * `tile.wgsl` colours indices with `ndviRamp` and `deltaRamp`; the HTML legend
 * is built from the TypeScript copies in `ramps.ts`. Nothing forces those to
 * agree at runtime, so this test samples both at a grid of stops and requires
 * exact agreement. A legend that disagrees with the pixels it labels is worse
 * than no legend, because it is trusted.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rampColor, rampCssGradient, toCssColor, deltaLegend, ndviLegend } from '../src/ui/ramps';

const here = dirname(fileURLToPath(import.meta.url));
const shader = readFileSync(join(here, '../src/gpu/shaders/tile.wgsl'), 'utf8');

/** Stops are constant expressions in the shader, e.g. `vec3<f32>(0.37, 0.24, 0.13)`. */
function parseStops(functionName: string): Array<{ t: number; rgb: [number, number, number] }> {
  const start = shader.indexOf(`fn ${functionName}(`);
  if (start < 0) throw new Error(`${functionName} not found in tile.wgsl`);
  const body = shader.slice(start, shader.indexOf('\n}', start));
  const stops: Array<{ t: number; rgb: [number, number, number] }> = [];
  // `let name = vec3<f32>(r, g, b);` and a `return mix(a, b, v / f);` chain.
  const lets = [...body.matchAll(/let (\w+) = vec3<f32>\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g)].map(
    (m) => ({ name: m[1], rgb: [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number] }),
  );
  // The thresholds in the if-chain define each segment's upper position.
  const bounds = [...body.matchAll(/if \(v < ([\d.]+)\)/g)].map((m) => Number(m[1]));
  // The five values are the positions of the stops.
  const positions = [0, ...bounds, 1];
  for (let i = 0; i < positions.length && i < lets.length; i += 1) {
    stops.push({ t: positions[i], rgb: lets[i].rgb });
  }
  return stops;
}

describe('NDVI ramp matches the shader', () => {
  const stops = parseStops('ndviRamp');

  it('parses five stops out of tile.wgsl', () => {
    expect(stops).toHaveLength(5);
  });

  it('agrees with the TypeScript ramp at every stop and midpoint', () => {
    for (let i = 0; i < stops.length; i += 1) {
      // Compared with a tolerance, not `toEqual`: at an exact stop position the
      // ramp evaluates a mix at f = 0, and `a + (b - a) * 0` is not always
      // bit-identical to `a` in double precision. The shader is float32, so an
      // exact comparison would be stricter than the thing being matched.
      const atStop = rampColor('ndvi', stops[i].t);
      for (let c = 0; c < 3; c += 1) {
        expect(atStop[c], `stop ${i} channel ${c}`).toBeCloseTo(stops[i].rgb[c], 12);
      }
      if (i + 1 < stops.length) {
        const mid = (stops[i].t + stops[i + 1].t) / 2;
        // Reconstruct the shader's mix at this midpoint.
        const a = stops[i].rgb;
        const b = stops[i + 1].rgb;
        const f = (mid - stops[i].t) / (stops[i + 1].t - stops[i].t);
        const expected = [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f);
        const actual = rampColor('ndvi', mid);
        for (let c = 0; c < 3; c += 1) {
          expect(actual[c], `channel ${c} at ${mid}`).toBeCloseTo(expected[c], 10);
        }
      }
    }
  });

  it('clamps outside [0,1] rather than extrapolating', () => {
    expect(rampColor('ndvi', -5)).toEqual(rampColor('ndvi', 0));
    expect(rampColor('ndvi', 5)).toEqual(rampColor('ndvi', 1));
  });
});

/**
 * Evaluate `deltaRamp` from tile.wgsl, transcribed here.
 *
 * The generic `parseStops` helper cannot read this ramp: it is diverging and
 * amplified (`clamp(±value * 2)`), not a chain of `if (v < t)` segments, so
 * there are no in-range thresholds to derive stop positions from. The colours
 * are still read from the shader so a colour edit there still fails here.
 */
function shaderDeltaRamp(value: number): [number, number, number] {
  const start = shader.indexOf('fn deltaRamp(');
  if (start < 0) throw new Error('deltaRamp not found in tile.wgsl');
  const body = shader.slice(start, shader.indexOf('\n}', start));
  const colours = [...body.matchAll(/let (\w+) = vec3<f32>\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g)].map(
    (m) => [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number],
  );
  const [loss, neutral, gain] = colours;
  const gainFactor = Number(/clamp\(-v \* ([\d.]+)/.exec(body)?.[1] ?? 2);
  const mix = (a: [number, number, number], b: [number, number, number], f: number): [number, number, number] =>
    [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f) as [number, number, number];

  const v = Math.min(1, Math.max(-1, value));
  if (v < 0) return mix(neutral, loss, Math.min(1, -v * gainFactor));
  return mix(neutral, gain, Math.min(1, v * gainFactor));
}

describe('delta ramp matches the shader', () => {
  it('agrees with the shader across the whole range, not just the anchors', () => {
    // `rampColor` takes UI space (0..1); the shader takes change (-1..1). The
    // mapping is linear, so the shader's amplified midpoints land at 0.25/0.75
    // -- which is why the TS table needs its duplicate stops.
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40;
      const value = t * 2 - 1;
      const expected = shaderDeltaRamp(value);
      const actual = rampColor('delta', t);
      for (let c = 0; c < 3; c += 1) {
        expect(actual[c], `channel ${c} at t=${t} (value ${value.toFixed(3)})`).toBeCloseTo(expected[c], 12);
      }
    }
  });

  it('saturates at the same points as the shader amplification', () => {
    // Beyond half the range the shader is already at full colour. A legend that
    // kept spreading colour out here would describe pixels that are not drawn.
    // Compared per channel with a tolerance rather than `toEqual`: the
    // interpolation is done in floating point, so an endpoint reached by
    // evaluating `a + (b - a) * 1` is not always bit-identical to `b`.
    const close = (x: [number, number, number], y: [number, number, number]) => {
      for (let c = 0; c < 3; c += 1) expect(x[c]).toBeCloseTo(y[c], 12);
    };
    close(rampColor('delta', 0), rampColor('delta', 0.25));
    close(rampColor('delta', 0.75), rampColor('delta', 1));
    expect(rampColor('delta', 0.25)[0]).not.toBeCloseTo(rampColor('delta', 0.4)[0], 3);
  });

  it('agrees at the neutral midpoint', () => {
    // Neutral grey at 0.5 is the anchor of the diverging scale.
    const neutral = rampColor('delta', 0.5);
    expect(neutral[0]).toBeCloseTo(0.92, 10);
    expect(neutral[1]).toBeCloseTo(0.92, 10);
    expect(neutral[2]).toBeCloseTo(0.92, 10);
  });

  it('is asymmetric: loss is more saturated than gain', () => {
    // A small loss is usually noise; a small gain is the thing worth seeing,
    // so the two arms ramp at different rates. The shader doubles both, so the
    // asymmetry is in the endpoint colours, not the slope.
    const loss = rampColor('delta', 0);
    const gain = rampColor('delta', 1);
    const chromaLoss = Math.max(...loss) - Math.min(...loss);
    const chromaGain = Math.max(...gain) - Math.min(...gain);
    expect(chromaLoss).toBeGreaterThan(chromaGain);
  });
});

describe('CSS output', () => {
  it('clamps and rounds channel values', () => {
    expect(toCssColor([-1, 0.5, 2])).toBe('rgb(0, 128, 255)');
  });

  it('emits a gradient with one stop per ramp point', () => {
    const gradient = rampCssGradient('ndvi');
    expect(gradient.split('rgb(')).toHaveLength(6); // 5 stops plus the lead
    expect(gradient).toContain('0%');
    expect(gradient).toContain('100%');
  });
});

describe('legends describe the scale honestly', () => {
  it('labels NDVI in the conventional bands', () => {
    const labels = ndviLegend().map((e) => e.label);
    expect(labels).toContain('Dense canopy');
    expect(labels).toContain('Water / bare');
  });

  it('labels change in terms of direction, not numbers', () => {
    expect(deltaLegend().map((e) => e.label)).toEqual(['Loss', 'No change', 'Gain']);
  });

  it('gives every entry a distinct colour', () => {
    for (const legend of [ndviLegend(), deltaLegend()]) {
      const colours = legend.map((e) => e.colour);
      expect(new Set(colours).size).toBe(colours.length);
    }
  });
});
