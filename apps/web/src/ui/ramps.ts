/**
 * Colour ramps and legend data.
 *
 * The ramps here are the same functions as `ndviRamp` and `deltaRamp` in
 * `tile.wgsl`, transcribed to JavaScript so the legend swatches cannot drift
 * from what the shader draws. `tests/ramps.test.ts` samples both at a grid of
 * stops and requires exact agreement, which is the only way to keep a
 * hand-written legend honest.
 */

export type RampKind = 'ndvi' | 'delta';

/**
 * Bands the single-band layer can show.
 *
 * The numbers are the `band_index` the shader's `channel()` switches on, and
 * they index the rgba32float texture's components. They are declared next to
 * the ramps rather than in the shader because the legend and the pixel must
 * agree on which component is which.
 */
export type RampBand = 'red' | 'green' | 'blue' | 'nir';

export const RAMP_BANDS: Record<RampBand, number> = {
  red: 0,
  green: 1,
  blue: 2,
  nir: 3,
};

export const BAND_LABELS: Record<RampBand, string> = {
  red: 'Red (B04)',
  green: 'Green (B03)',
  blue: 'Blue (B02)',
  nir: 'Near-infrared (B08)',
};

/** The shader's NO_DATA colour, so legends and gaps look the same. */
export const NO_DATA = 'rgb(20, 23, 26)';

export interface Stop {
  /** Position on the ramp, 0..1. For `delta`, remapped from [-1, 1]. */
  t: number;
  r: number;
  g: number;
  b: number;
}

const NDVI_STOPS: Stop[] = [
  { t: 0.0, r: 0.37, g: 0.24, b: 0.13 },
  { t: 0.25, r: 0.74, g: 0.68, b: 0.4 },
  { t: 0.5, r: 0.87, g: 0.88, b: 0.65 },
  { t: 0.75, r: 0.3, g: 0.62, b: 0.24 },
  { t: 1.0, r: 0.05, g: 0.3, b: 0.1 },
];

/**
 * Change ramp stops, in UI space where `t` runs 0 (max loss) to 1 (max gain).
 *
 * The duplicated endpoints at 0.25/0.75 are not a mistake, they are the
 * shader's amplification: `deltaRamp` mixes by `clamp(±value * 2)`, so anything
 * beyond ±0.5 is already at full colour. The linear segments between them then
 * reproduce the shader exactly -- `f = (0.5 - t) / 0.25` is the same
 * `clamp(2 - 4t)` the shader computes.
 *
 * An earlier version of this table had only the three endpoints and spread the
 * colour across the whole half. That made the legend quietly wrong: it labelled
 * mid-range change with a colour the shader was never drawing, which is the
 * exact failure `tests/ramps.test.ts` exists to prevent.
 */
const DELTA_STOPS: Stop[] = [
  { t: 0.0, r: 0.62, g: 0.2, b: 0.12 },
  { t: 0.25, r: 0.62, g: 0.2, b: 0.12 },
  { t: 0.5, r: 0.92, g: 0.92, b: 0.92 },
  { t: 0.75, r: 0.1, g: 0.45, b: 0.2 },
  { t: 1.0, r: 0.1, g: 0.45, b: 0.2 },
];

function mix(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/**
 * Evaluate a ramp.
 *
 * Interpolation is linear in sRGB, matching the WGSL, which mixes the same
 * float32 stop values. Interpolating in *linear* light would be more
 * physically correct for a light source and less correct for a data
 * overlay: an index ramp is a label, and labels read better when the ramp's
 * perceived spacing matches the numbers.
 */
export function rampColor(kind: RampKind, t: number): [number, number, number] {
  const stops = kind === 'ndvi' ? NDVI_STOPS : DELTA_STOPS;
  const v = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i += 1) {
    const lo = stops[i];
    const hi = stops[i + 1];
    if (v <= hi.t) {
      const f = (v - lo.t) / (hi.t - lo.t);
      return [mix(lo.r, hi.r, f), mix(lo.g, hi.g, f), mix(lo.b, hi.b, f)];
    }
  }
  const last = stops[stops.length - 1];
  return [last.r, last.g, last.b];
}

export function toCssColor(colour: [number, number, number]): string {
  const channel = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${channel(colour[0])}, ${channel(colour[1])}, ${channel(colour[2])})`;
}

export function rampCssGradient(kind: RampKind): string {
  const stops = kind === 'ndvi' ? NDVI_STOPS : DELTA_STOPS;
  return stops
    .map((s) => `${toCssColor([s.r, s.g, s.b])} ${(s.t * 100).toFixed(0)}%`)
    .join(', ');
}

export interface LegendEntry {
  label: string;
  colour: string;
}

/**
 * Legend for an index layer.
 *
 * The NDVI labels are the conventions from the literature, not invented here:
 * the breakpoints are the ones the vegetation-index literature uses to
 * distinguish bare soil, sparse vegetation, and dense canopy, and the change
 * labels say what the colours mean rather than repeating the numbers.
 */
export function ndviLegend(): LegendEntry[] {
  const at = (v: number): string => toCssColor(rampColor('ndvi', v * 0.5 + 0.5));
  return [
    { label: 'Water / bare', colour: at(-1) },
    { label: 'Bare soil', colour: at(0) },
    { label: 'Sparse vegetation', colour: at(0.3) },
    { label: 'Moderate', colour: at(0.6) },
    { label: 'Dense canopy', colour: at(1) },
  ];
}

export function deltaLegend(): LegendEntry[] {
  return [
    { label: 'Loss', colour: toCssColor(rampColor('delta', 0)) },
    { label: 'No change', colour: toCssColor(rampColor('delta', 0.5)) },
    { label: 'Gain', colour: toCssColor(rampColor('delta', 1)) },
  ];
}
