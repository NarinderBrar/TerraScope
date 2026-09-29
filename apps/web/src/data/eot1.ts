/**
 * EOT1 decoder.
 *
 * A reimplementation of `services/raster/app/protocol/eot1.py`. Every
 * validation the server performs is repeated here, for the same reason: once
 * a tile reaches the browser, the offsets and lengths in its header are
 * untrusted input, and a hostile header must be rejected before anything is
 * allocated or uploaded to the GPU.
 *
 * `tests/eot1.test.ts` checks this decoder against bytes the Python encoder
 * produced, and `tests/eot1-hostile.test.ts` feeds it the malformed headers
 * the server is expected to be robust to. The two implementations must not
 * drift; the shared constants below are the seam.
 */

import {
  EOT1_HEADER_ALIGN,
  type Eot1BandLayout,
  type Eot1Header,
  type Eot1MaskLayout,
  type NumericTile,
} from '@terrascope/contracts';

const MAGIC = 0x31544f45; // 'EOT1', little-endian

/** Ceiling on a whole tile. 4 bands at 512x512 float32 is 4 MiB. */
export const MAX_TILE_BYTES = 8 * 1024 * 1024;
export const MAX_HEADER_BYTES = 64 * 1024;

export class Eot1Error extends Error {
  override readonly name = 'Eot1Error';
}

function align(n: number, boundary: number): number {
  return Math.ceil(n / boundary) * boundary;
}

/**
 * Parse and bounds-check the header. Allocates nothing.
 *
 * Bounds are checked against the *buffer*, not against the header's own
 * claims, so a header that lies about its offsets cannot walk off the end of
 * the array. The per-plane sample count is checked against width*height, so a
 * header claiming a 1x1 tile over a 4 MiB payload is rejected rather than
 * silently showing one pixel.
 */
export function readHeader(buffer: ArrayBuffer): { header: Eot1Header; payloadStart: number } {
  if (buffer.byteLength < 8) {
    throw new Eot1Error('payload is shorter than the magic and header length');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Eot1Error(`bad magic 0x${view.getUint32(0, true).toString(16)}; not an EOT1 tile`);
  }
  const headerLength = view.getUint32(4, true);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new Eot1Error(`header length ${headerLength} is out of range`);
  }
  const payloadStart = 8 + align(headerLength, EOT1_HEADER_ALIGN);
  if (buffer.byteLength < payloadStart) {
    throw new Eot1Error('header runs past the end of the payload');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 8, headerLength)),
    );
  } catch (cause) {
    throw new Eot1Error(`header is not valid UTF-8 JSON: ${(cause as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Eot1Error('header is not a JSON object');
  }
  const header = parsed as Eot1Header;

  if (header.protocol !== 'EOT1') {
    throw new Eot1Error(`unsupported protocol ${JSON.stringify(header.protocol)}`);
  }
  const { width, height } = header;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Eot1Error(`tile dimensions ${width}x${height} are not integers`);
  }
  if (width <= 0 || height <= 0) {
    throw new Eot1Error(`tile dimensions ${width}x${height} are not positive`);
  }
  const pixels = width * height;
  // A tile is also capped by MAX_TILE_BYTES, but the pixel count is checked
  // first so a hostile 1e9x1e9 header is rejected before any allocation.
  if (!Number.isSafeInteger(pixels) || pixels > MAX_TILE_BYTES / 4) {
    throw new Eot1Error(`tile of ${width}x${height} exceeds the pixel cap`);
  }

  const payloadLength = buffer.byteLength - payloadStart;
  if (payloadLength < 0) {
    throw new Eot1Error('payload is truncated');
  }
  checkLayout(header.bands, pixels, 4, payloadLength);
  checkLayout(header.masks, pixels, 1, payloadLength);
  return { header, payloadStart };
}

function checkLayout(
  layout: Array<Eot1BandLayout | Eot1MaskLayout> | undefined,
  pixels: number,
  elementBytes: number,
  payloadLength: number,
): void {
  if (layout === undefined || layout === null) return;
  if (!Array.isArray(layout)) {
    throw new Eot1Error('layout is present but is not an array');
  }
  for (const entry of layout) {
    if (entry === null || typeof entry !== 'object') {
      throw new Eot1Error('layout contains a non-object entry');
    }
    const { name, offset, length } = entry;
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
      throw new Eot1Error(`layout entry has an unusable name ${JSON.stringify(name)}`);
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new Eot1Error(`layout ${name} has a non-integer extent [${offset}, +${length})`);
    }
    // The `offset + length` sum is computed in doubles and compared against a
    // payload length that is itself bounded by MAX_TILE_BYTES, so it cannot
    // overflow into a false pass.
    if (offset + length > payloadLength) {
      throw new Eot1Error(
        `layout ${name} [${offset}, +${length}) extends past the ${payloadLength}B payload`,
      );
    }
    if (length % elementBytes !== 0) {
      throw new Eot1Error(`layout ${name} length ${length} is not a multiple of ${elementBytes}`);
    }
    const samples = length / elementBytes;
    if (samples !== pixels) {
      throw new Eot1Error(`layout ${name} holds ${samples} samples, expected ${pixels}`);
    }
    // Alignment: every plane starts on a multiple of its own element size, so
    // the typed-array views below are always valid.
    if (offset % elementBytes !== 0) {
      throw new Eot1Error(`layout ${name} offset ${offset} is not ${elementBytes}-byte aligned`);
    }
  }
}

/**
 * Decode bands and masks as views over the same buffer, with no copy.
 *
 * A 4-band 256x256 tile is 1 MiB of float32; copying every resident tile on
 * arrival would defeat the point of streaming. The views are valid only while
 * `buffer` is alive, which the tile cache guarantees by holding a reference.
 *
 * The views are not guaranteed 4-byte aligned relative to their own backing
 * buffer if `buffer` is a slice, so a check is done per plane: `new Float32Array`
 * throws on a misaligned offset anyway, but the message from the engine is
 * opaque, so it is caught and rethrown with the plane name.
 */
export function decode(buffer: ArrayBuffer): NumericTile {
  if (buffer.byteLength > MAX_TILE_BYTES) {
    throw new Eot1Error(`tile is ${buffer.byteLength}B, over the ${MAX_TILE_BYTES}B cap`);
  }
  const { header, payloadStart } = readHeader(buffer);
  const { width, height } = header;
  const pixels = width * height;

  const bands: Record<string, Float32Array> = {};
  for (const entry of header.bands ?? []) {
    bands[entry.name] = view(
      () => new Float32Array(buffer, payloadStart + entry.offset, pixels),
      entry.name,
    );
  }
  const masks: Record<string, Uint8Array> = {};
  for (const entry of header.masks ?? []) {
    masks[entry.name] = view(
      () => new Uint8Array(buffer, payloadStart + entry.offset, pixels),
      entry.name,
    );
  }
  return { header, bands, masks };
}

function view<T>(make: () => T, name: string): T {
  try {
    return make();
  } catch (cause) {
    throw new Eot1Error(`band ${name} could not be mapped: ${(cause as Error).message}`);
  }
}

/** Copy a plane into a standalone array, for readback or export. */
export function copyPlane(plane: Float32Array | Uint8Array): Float32Array | Uint8Array {
  return plane.slice();
}
