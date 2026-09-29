/**
 * EOT1 decoder, checked against bytes the Python encoder produced.
 *
 * The point of these tests is that the fixtures are *real*: the base64 blobs
 * came out of the live service reading a real Sentinel-2 granule, so a drift
 * between the two implementations shows up as a wrong pixel count rather than
 * as two consistently-wrong decoders agreeing with each other.
 *
 * Regenerate with `node scripts/embed-tile-fixtures.mjs`.
 */

import { describe, expect, it } from 'vitest';
import { Eot1Error, MAX_TILE_BYTES, decode, readHeader } from '../src/data/eot1';
import { EOT1_HEADER_ALIGN, PROCESSING_VERSION } from '@terrascope/contracts';
import { RGB_TILE_BASE64, RGN_TILE_BASE64 } from './fixtures/tiles';

function bytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

const rgb = bytes(RGB_TILE_BASE64);
const rgn = bytes(RGN_TILE_BASE64);

describe('EOT1: header of a real rgb tile', () => {
  const { header, payloadStart } = readHeader(rgb);

  it('starts with the EOT1 magic', () => {
    expect(new TextDecoder().decode(new Uint8Array(rgb, 0, 4))).toBe('EOT1');
  });

  it('declares its own protocol and processing version', () => {
    expect(header.protocol).toBe('EOT1');
    expect(header.processingVersion).toBe(PROCESSING_VERSION);
  });

  it('reports 256x256', () => {
    expect(header.width).toBe(256);
    expect(header.height).toBe(256);
  });

  it('aligns the payload start', () => {
    expect(payloadStart % EOT1_HEADER_ALIGN).toBe(0);
    expect(payloadStart).toBeGreaterThan(8);
  });

  it('carries the display grid it was requested for', () => {
    expect(header.grid.tileSize).toBe(256);
    expect(header.grid.z).toBe(13);
    expect(header.grid.x).toBe(1335);
    expect(header.grid.y).toBe(3156);
  });

  it('carries geographic bounds matching the grid', () => {
    expect(header.bounds).toHaveLength(4);
    const [west, south, east, north] = header.bounds;
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    // The reference scene is in northern California.
    expect(west).toBeGreaterThan(-122);
    expect(east).toBeLessThan(-121);
    expect(north).toBeGreaterThan(38);
    expect(south).toBeLessThan(39);
  });

  it('records rgb band order', () => {
    expect(header.bands.map((b) => b.name)).toEqual(['red', 'green', 'blue']);
  });

  it('is calibrated exactly once', () => {
    expect(header.calibrated).toBe(true);
    expect(header.calibration.applied).toBe(true);
    expect(header.calibration.appliedOnce).toBe(true);
  });

  it('carries the calibration actually read from STAC, not a guess', () => {
    // Sentinel-2 L2A publishes DN -> reflectance as 1e-4 * DN - 0.1.
    for (const name of ['red', 'green', 'blue']) {
      expect(header.calibration.perBand[name].scale, `${name} scale`).toBe(0.0001);
      expect(header.calibration.perBand[name].offset, `${name} offset`).toBe(-0.1);
    }
  });

  it('declares the NDVI denominator guard it used', () => {
    expect(header.calibration.ndviEpsilon).toBe(0.001);
  });

  it('separates coverage from index validity', () => {
    const names = header.masks.map((m) => m.name);
    expect(names).toContain('coverage:red');
    expect(names).toContain('red');
    expect(names).toContain('quality');
  });

  it('declares per-band resampling and the source GSDs', () => {
    expect(header.sources.resampling.red).toBe('bilinear');
    expect(header.sources.resampling.green).toBe('bilinear');
    expect(header.sources.sourceResolutionM.red).toBe(10);
    // SCL is published at 20 m even though the reflectance bands are 10 m, and
    // it is resampled separately and categorically. Getting either wrong is
    // how a cloud mask ends up soft-edged.
    expect(header.sources.qualityResolutionM).toBe(20);
    expect(header.sources.qualityResampling).toBe('nearest');
  });

  it('preserves attribution', () => {
    expect(header.attribution).toMatch(/Copernicus|Sentinel/);
  });

  it('names the processing baseline and EPSG of the source item', () => {
    // Baseline determines the calibration constants, so a tile that does not
    // say which one it came from cannot be interpreted correctly.
    expect(header.sources.processingBaseline).toBeTruthy();
    expect(header.sources.epsg).toBe(32610);
  });
});

describe('EOT1: decoded arrays of a real rgb tile', () => {
  const tile = decode(rgb);

  it('exposes one Float32Array per band, all of tile size', () => {
    expect(Object.keys(tile.bands).sort()).toEqual(['blue', 'green', 'red']);
    for (const plane of Object.values(tile.bands)) {
      expect(plane).toBeInstanceOf(Float32Array);
      expect(plane.length).toBe(256 * 256);
    }
  });

  it('exposes one Uint8Array per mask, all of tile size', () => {
    for (const plane of Object.values(tile.masks)) {
      expect(plane).toBeInstanceOf(Uint8Array);
      expect(plane.length).toBe(256 * 256);
    }
  });

  it('reports full coverage inside the granule', () => {
    const coverage = tile.masks['coverage:red'];
    expect(coverage).toBeDefined();
    const valid = coverage.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
    // The reference tile sits well inside the granule, so coverage is total.
    // A partial result here would mean the coverage mask and the value planes
    // have come out of step.
    expect(valid).toBe(coverage.length);
  });

  it('holds calibrated reflectance in a plausible range', () => {
    const { red } = tile.bands;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < red.length; i += 1) {
      if (red[i] < min) min = red[i];
      if (red[i] > max) max = red[i];
    }
    // Calibrated surface reflectance. A nodata sentinel or an uncalibrated
    // DN above 10000 would both be caught here.
    expect(min).toBeGreaterThanOrEqual(-0.1);
    expect(max).toBeLessThanOrEqual(1.5);
    expect(max).toBeGreaterThan(0.1);
  });

  it('keeps every mask byte a strict 0 or 1', () => {
    // Masks are uint8 with only two meaningful values. A packed bitmask read
    // with the wrong stride shows up here as values like 3 or 255.
    for (const [name, plane] of Object.entries(tile.masks)) {
      for (let i = 0; i < plane.length; i += 1) {
        if (plane[i] !== 0 && plane[i] !== 1) {
          throw new Error(`mask ${name} has value ${plane[i]} at ${i}, expected 0 or 1`);
        }
      }
    }
  });

  it('has an index mask no more permissive than coverage', () => {
    const coverage = tile.masks['coverage:red'];
    const analytic = tile.masks['red'];
    let analyticCount = 0;
    let coverageCount = 0;
    for (let i = 0; i < coverage.length; i += 1) {
      if (analytic[i] === 1) analyticCount += 1;
      if (coverage[i] === 1) coverageCount += 1;
    }
    expect(analyticCount).toBeLessThanOrEqual(coverageCount);
  });

  it('views rather than copies, so every plane aliases the one buffer', () => {
    // A copy would have a buffer of exactly 4 * pixels bytes. Views share the
    // whole tile buffer, which is what makes decoding allocation-free.
    const { red } = tile.bands;
    expect(red.buffer.byteLength).toBe(rgb.byteLength);
    expect(red.length * 4).toBeLessThan(rgb.byteLength);
  });

  it('stays under the size cap', () => {
    expect(rgb.byteLength).toBeLessThanOrEqual(MAX_TILE_BYTES);
  });
});

describe('EOT1: a four-band tile carries NIR as well', () => {
  const tile = decode(rgn);

  it('exposes red, green, blue, nir', () => {
    expect(Object.keys(tile.bands).sort()).toEqual(['blue', 'green', 'nir', 'red']);
  });

  it('is larger than the three-band tile', () => {
    expect(rgn.byteLength).toBeGreaterThan(rgb.byteLength);
  });

  it('has coverage for every band plus the shared quality mask', () => {
    const names = Object.keys(tile.masks);
    for (const band of ['red', 'green', 'blue', 'nir']) {
      expect(names).toContain(`coverage:${band}`);
    }
    expect(names).toContain('quality');
  });
});

describe('EOT1: rejects malformed input before allocating', () => {
  /** Rebuild a tile with a mutated header object, re-encoded the way the server would. */
  function rebuild(mutate: (h: Record<string, unknown>) => void, truncateTo?: number): ArrayBuffer {
    const { header, payloadStart } = readHeader(rgb);
    const object = JSON.parse(JSON.stringify(header)) as Record<string, unknown>;
    mutate(object);
    const encoded = new TextEncoder().encode(JSON.stringify(object));
    const aligned = Math.ceil(encoded.length / EOT1_HEADER_ALIGN) * EOT1_HEADER_ALIGN;
    const buffer = new ArrayBuffer(8 + aligned + (rgb.byteLength - payloadStart));
    const view = new DataView(buffer);
    view.setUint32(0, 0x31544f45, true);
    view.setUint32(4, encoded.length, true);
    new Uint8Array(buffer, 8, encoded.length).set(encoded);
    new Uint8Array(buffer, 8 + aligned).set(
      new Uint8Array(rgb, payloadStart, rgb.byteLength - payloadStart),
    );
    return truncateTo === undefined ? buffer : buffer.slice(0, truncateTo);
  }

  it('rejects bad magic', () => {
    const copy = rgb.slice(0);
    new DataView(copy).setUint32(0, 0xdeadbeef, true);
    expect(() => readHeader(copy)).toThrow(Eot1Error);
  });

  it('rejects a payload shorter than the magic', () => {
    expect(() => readHeader(new ArrayBuffer(4))).toThrow(Eot1Error);
  });

  it('rejects an absurd header length', () => {
    const copy = rgb.slice(0);
    new DataView(copy).setUint32(4, 0xffffffff, true);
    expect(() => readHeader(copy)).toThrow(Eot1Error);
  });

  it('rejects a zero header length', () => {
    const copy = rgb.slice(0);
    new DataView(copy).setUint32(4, 0, true);
    expect(() => readHeader(copy)).toThrow(Eot1Error);
  });

  it('rejects a header that is not JSON', () => {
    const encoded = new TextEncoder().encode('{not json');
    const buffer = new ArrayBuffer(8 + encoded.length);
    const view = new DataView(buffer);
    view.setUint32(0, 0x31544f45, true);
    view.setUint32(4, encoded.length, true);
    new Uint8Array(buffer, 8).set(encoded);
    expect(() => readHeader(buffer)).toThrow(Eot1Error);
  });

  it('rejects a header that is a JSON array', () => {
    // Aligned to 4 so the header survives the payload-alignment check and
    // reaches the parse, where the array is what is under test.
    const encoded = new TextEncoder().encode('[]');
    const aligned = Math.ceil(encoded.length / EOT1_HEADER_ALIGN) * EOT1_HEADER_ALIGN;
    const buffer = new ArrayBuffer(8 + aligned);
    const view = new DataView(buffer);
    view.setUint32(0, 0x31544f45, true);
    view.setUint32(4, encoded.length, true);
    new Uint8Array(buffer, 8).set(encoded);
    expect(() => readHeader(buffer)).toThrow(/not a JSON object/);
  });

  it('rejects the wrong protocol', () => {
    expect(() => readHeader(rebuild((h) => { h.protocol = 'EOT2'; }))).toThrow(/unsupported protocol/);
  });

  it('rejects zero and negative dimensions', () => {
    expect(() => readHeader(rebuild((h) => { h.width = 0; }))).toThrow(/not positive/);
    expect(() => readHeader(rebuild((h) => { h.height = -4; }))).toThrow(/not positive/);
  });

  it('rejects non-integer dimensions', () => {
    expect(() => readHeader(rebuild((h) => { h.width = 256.5; }))).toThrow(/not integers/);
  });

  it('rejects an absurd tile size', () => {
    expect(() => readHeader(rebuild((h) => { h.width = 1e9; h.height = 1e9; }))).toThrow(/pixel cap/);
  });

  it('rejects a band offset past the end of the payload', () => {
    expect(() =>
      readHeader(rebuild((h) => {
        (h.bands as Array<Record<string, unknown>>)[0].offset = 1 << 30;
      })),
    ).toThrow(/past the/);
  });

  it('rejects a band length past the end of the payload', () => {
    expect(() =>
      readHeader(rebuild((h) => {
        (h.bands as Array<Record<string, unknown>>)[0].length = 1 << 30;
      })),
    ).toThrow(/past the/);
  });

  it('rejects a band whose length disagrees with the tile dimensions', () => {
    expect(() =>
      readHeader(rebuild((h) => {
        (h.bands as Array<Record<string, unknown>>)[0].length = 4;
      })),
    ).toThrow(/samples, expected/);
  });

  it('rejects a misaligned band offset', () => {
    expect(() =>
      readHeader(rebuild((h) => {
        (h.bands as Array<Record<string, unknown>>)[0].offset = 2;
      })),
    ).toThrow(/aligned/);
  });

  it('rejects a negative offset', () => {
    expect(() =>
      readHeader(rebuild((h) => {
        (h.bands as Array<Record<string, unknown>>)[0].offset = -4;
      })),
    ).toThrow(/non-integer extent/);
  });

  it('rejects a truncated payload', () => {
    const truncated = rgb.slice(0, 4096);
    expect(() => readHeader(truncated)).toThrow(Eot1Error);
  });

  it('rejects a tile over the byte cap', () => {
    expect(() => decode(new ArrayBuffer(MAX_TILE_BYTES + 8))).toThrow(/cap/);
  });
});
