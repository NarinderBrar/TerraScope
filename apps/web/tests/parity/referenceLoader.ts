/**
 * NPZ reader for the CPU reference fixture.
 *
 * The archive is written by `numpy.savez_compressed`, which means two things
 * that a naive zip walker gets wrong:
 *
 *  1. members are **deflated**, not stored, so they need inflating;
 *  2. every local file header carries `0xFFFFFFFF` for the sizes and a ZIP64
 *     extra field holding the real values -- because the fixture crosses the
 *     4 GiB *uncompressed* mark in aggregate. The authoritative sizes are in
 *     the **central directory**, which is what this reader uses. Local headers
 *     are read only for the member name and the ZIP64 extra.
 */

export interface ReferenceMeta {
  scene: string;
  z: number;
  x: number;
  y: number;
  width: number;
  height: number;
  epsilon: number;
  datetime: string;
}

export interface ReferenceFixture {
  width: number;
  height: number;
  red: Float32Array;
  nir: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  coverageRed: Uint8Array;
  coverageNir: Uint8Array;
  redMask: Uint8Array;
  nirMask: Uint8Array;
  quality: Uint8Array;
  ndvi: Float32Array;
  ndviValid: Uint8Array;
  meta: ReferenceMeta;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export async function decodeReferenceBase64(
  base64: string,
  meta: ReferenceMeta,
): Promise<ReferenceFixture> {
  const bytes = base64ToBytes(base64);
  const entries = readCentralDirectory(bytes);
  const arrays = new Map<string, Float32Array | Uint8Array>();

  for (const entry of entries) {
    // `numpy.savez` writes arrays only; the descriptor travels separately as
    // cpu_reference.json, which the generator inlines alongside the archive.
    if (entry.name === 'meta') continue;
    const data = await readMember(bytes, entry);
    // Members are stored as `<name>.npy`; the fixture refers to them by the
    // bare name.
    const key = entry.name.endsWith('.npy') ? entry.name.slice(0, -4) : entry.name;
    arrays.set(key, readNpyMember(data, entry.name));
  }

  const pixels = meta.width * meta.height;

  const f32 = (name: string): Float32Array => {
    const value = arrays.get(name);
    if (!(value instanceof Float32Array) || value.length !== pixels) {
      throw new Error(`fixture array ${name} is missing or is not ${pixels} float32 samples`);
    }
    return value;
  };
  const u8 = (name: string): Uint8Array => {
    const value = arrays.get(name);
    if (!(value instanceof Uint8Array) || value.length !== pixels) {
      throw new Error(`fixture array ${name} is missing or is not ${pixels} uint8 samples`);
    }
    return value;
  };

  return {
    width: meta.width,
    height: meta.height,
    red: f32('red'),
    nir: f32('nir'),
    green: f32('green'),
    blue: f32('blue'),
    coverageRed: u8('coverage:red'),
    coverageNir: u8('coverage:nir'),
    redMask: u8('red_mask'),
    nirMask: u8('nir_mask'),
    quality: u8('quality'),
    ndvi: f32('ndvi'),
    ndviValid: u8('ndvi_valid'),
    meta,
  };
}

/**
 * Walk the central directory.
 *
 * This is the only place in the zip format where sizes are reliable; the local
 * headers in a ZIP64 archive are allowed to be placeholders.
 */
function readCentralDirectory(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('fixture is not a zip archive: no end-of-central-directory record');
  }

  let entryCount = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);

  // ZIP64: the 32-bit fields saturate, and the real values move into a record
  // the end-of-central-directory points at.
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
      throw new Error('fixture claims ZIP64 but has no ZIP64 end-of-central-directory locator');
    }
    const zip64Offset = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(zip64Offset, true) !== 0x06064b50) {
      throw new Error('bad ZIP64 end-of-central-directory record');
    }
    entryCount = Number(view.getBigUint64(zip64Offset + 32, true));
    directoryOffset = Number(view.getBigUint64(zip64Offset + 48, true));
  }

  const entries: Entry[] = [];
  let offset = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new Error(`corrupt fixture: bad central directory header at byte ${offset}`);
    }
    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const patched = readZip64Extra(
        bytes,
        offset + 46 + nameLength,
        extraLength,
        uncompressedSize === 0xffffffff,
        compressedSize === 0xffffffff,
        localHeaderOffset === 0xffffffff,
      );
      uncompressedSize = patched.uncompressedSize;
      compressedSize = patched.compressedSize;
      localHeaderOffset = patched.localHeaderOffset;
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Pull the real values out of a ZIP64 extended information extra field.
 *
 * Fields appear in a fixed order and only for the values that saturated, so
 * the cursor is advanced conditionally rather than by a fixed stride.
 */
function readZip64Extra(
  bytes: Uint8Array,
  start: number,
  extraLength: number,
  needUncompressed: boolean,
  needCompressed: boolean,
  needOffset: boolean,
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = start;
  const end = start + extraLength;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (id !== ZIP64_EXTRA_ID) {
      cursor += 4 + size;
      continue;
    }
    let field = cursor + 4;
    const uncompressed = needUncompressed ? Number(view.getBigUint64(field, true)) : 0;
    if (needUncompressed) field += 8;
    const compressed = needCompressed ? Number(view.getBigUint64(field, true)) : 0;
    if (needCompressed) field += 8;
    const localOffset = needOffset ? Number(view.getBigUint64(field, true)) : 0;
    return {
      uncompressedSize: uncompressed,
      compressedSize: compressed,
      localHeaderOffset: localOffset,
    };
  }
  throw new Error('fixture needs ZIP64 sizes but carries no ZIP64 extra field');
}

async function readMember(bytes: Uint8Array, entry: Entry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (view.getUint32(header, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`corrupt fixture: bad local file header for ${entry.name}`);
  }
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const dataStart = header + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new Error(`fixture member ${entry.name} runs past the end of the archive`);
  }
  const raw = bytes.subarray(dataStart, dataEnd);

  switch (entry.method) {
    case ZIP_STORED:
      return raw;
    case ZIP_DEFLATED:
      return inflateRaw(raw, entry.name, entry.uncompressedSize);
    default:
      throw new Error(`fixture member ${entry.name} uses unsupported compression method ${entry.method}`);
  }
}

/**
 * Inflate a raw deflate stream.
 *
 * `DecompressionStream` is present in Node 18+ and in every browser that ships
 * WebGPU, so this needs neither a polyfill nor a dependency.
 */
async function inflateRaw(data: Uint8Array, name: string, expectedSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      `fixture member ${name} is deflated but DecompressionStream is unavailable; ` +
        'use Node 18+ to run the parity suite.',
    );
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }
  if (total !== expectedSize) {
    throw new Error(
      `fixture member ${name} inflated to ${total} bytes, expected ${expectedSize}`,
    );
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readNpyMember(data: Uint8Array, name: string): Float32Array | Uint8Array {
  if (data.length < 10) throw new Error(`${name}: truncated .npy header`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(0) !== 0x93) throw new Error(`${name}: bad .npy magic`);
  const magic = String.fromCharCode(data[1], data[2], data[3], data[4], data[5]);
  if (magic !== 'NUMPY') throw new Error(`${name}: not a .npy member`);

  const major = view.getUint8(6);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(data.subarray(headerStart, headerStart + headerLength));
  const body = data.byteOffset + headerStart + headerLength;

  if (header.includes("'fortran_order': True")) {
    throw new Error(`${name}: fortran_order arrays are not supported`);
  }
  if (header.includes('<f4')) {
    return new Float32Array(data.buffer.slice(body));
  }
  if (header.includes('|u1')) {
    return new Uint8Array(data.buffer.slice(body));
  }
  throw new Error(`${name}: unsupported dtype in header ${header.trim()}`);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  const nodeBuffer = (globalThis as Record<string, unknown>).Buffer as
    | { from(s: string, e: string): Uint8Array }
    | undefined;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(base64, 'base64'));
  throw new Error('no base64 decoder available in this environment');
}
