/**
 * Public, provider-neutral contract types.
 *
 * Nothing in this file may name a Cloudflare binding, a GDAL type, or a
 * provider-specific asset key. Provider specifics live in the raster service's
 * provider adapters; the browser only ever sees what is declared here.
 */

/** A band the numeric tile protocol can carry, in canonical order. */
export const NUMERIC_BANDS = ['red', 'green', 'blue', 'nir'] as const;
export type NumericBand = (typeof NUMERIC_BANDS)[number];

/** Byte-exact tile profiles. The profile is part of the cache key. */
export const TILE_PROFILES = ['rgb', 'rednir', 'rgbn'] as const;
export type TileProfile = (typeof TILE_PROFILES)[number];

export const BAND_COUNT: Record<TileProfile, number> = {
  rgb: 3,
  rednir: 2,
  rgbn: 4,
};

export function profileBands(profile: TileProfile): NumericBand[] {
  switch (profile) {
    case 'rgb':
      return ['red', 'green', 'blue'];
    case 'rednir':
      return ['red', 'nir'];
    case 'rgbn':
      return ['red', 'green', 'blue', 'nir'];
  }
}

/** Bumped whenever tile semantics change. Invalidates every cached tile. */
export const PROCESSING_VERSION = 'eot-1';

export interface SceneBandInfo {
  available: boolean;
  resolutionM?: number;
  /** Asset key in the source STAC item, when resolvable. */
  asset?: string;
}

/**
 * Minimal GeoJSON geometry, declared locally.
 *
 * Pulling in `@types/geojson` for one `Geometry` union would add a dependency
 * to a package that is shared by the browser, the worker, and the typecheck,
 * for a shape the client never actually traverses.
 */
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'GeometryCollection'; geometries: GeoJsonGeometry[] };

export interface Scene {
  id: string;
  collection: string;
  datetime: string;
  bbox: number[];
  geometry: GeoJsonGeometry;
  /** Scene-wide cloud fraction. A search hint only, never the cloud fraction of a drawn area. */
  cloudCover: number | null;
  bands: Record<string, SceneBandInfo>;
  attribution: string;
  processingVersion: string;
  /** True when a quality/scene-classification asset backs the cloud-mask policy. */
  qualityAvailable: boolean;
}

export interface SearchRequest {
  bbox: [number, number, number, number];
  start: string;
  end: string;
  maxCloudCover?: number;
  limit?: number;
  cursor?: string;
}

export interface SearchResponse {
  scenes: Scene[];
  /** Opaque to clients. Server validates the destination; never a raw URL. */
  nextCursor: string | null;
  matched: number | null;
}

export interface SceneDetail {
  scene: Scene;
  /** Declared, human-readable statement of what the cloud mask excludes. */
  qualityPolicy: string;
  sourceResolutionM: Record<string, number>;
  supportedProfiles: TileProfile[];
}

export interface HealthResponse {
  status: string;
  uptimeSeconds: number;
  collections: string[];
  /** Alias of the service's `processingVersion`; see PROCESSING_VERSION. */
  version: string;
}

export interface DatasetConfig {
  collections: string[];
  profiles: TileProfile[];
  bands: readonly NumericBand[];
  maxZoom: number;
  minZoom: number;
  tileSize: number;
  crs: string;
  limits: {
    maxBboxAreaDeg2: number;
    maxResultsPerPage: number;
    maxDateRangeDays: number;
    maxSceneIdLength: number;
  };
  qualityPolicy: string;
  processingVersion: string;
}

// ---------------------------------------------------------------------------
// EOT1 numeric tile protocol
// ---------------------------------------------------------------------------

/**
 * Binary layout:
 *   [0..4)    magic  = 'EOT1' (ASCII)
 *   [4..8)    uint32 LE  header JSON length
 *   [8..8+n)  UTF-8 JSON header, zero padded to a 4-byte boundary
 *   payload   planar little-endian float32 arrays, then uint8 masks
 */
export const EOT1_MAGIC = 0x31544f45; // 'EOT1' read as LE uint32
export const EOT1_HEADER_ALIGN = 4;

export interface Eot1BandLayout {
  name: string;
  /** Byte offset from the start of the payload region. */
  offset: number;
  /** Byte length of the band region. */
  length: number;
  dtype: 'float32';
}

export interface Eot1MaskLayout {
  name: string;
  offset: number;
  length: number;
  dtype: 'uint8';
}

export interface Eot1Header {
  protocol: 'EOT1';
  width: number;
  height: number;
  /** Payload band order. */
  bands: Eot1BandLayout[];
  /**
   * Validity masks, uint8, 1 = valid. Two kinds, deliberately distinct:
   *
   * - `coverage:<band>`  this sample has real source data. Drives *rendering*,
   *   so a pixel the sensor did see is never shown as a hole just because it
   *   is unsuitable for analysis.
   * - `<band>`           the sample is also plausible for *indices* (calibrated
   *   reflectance inside the declared range). Drives NDVI and every reduction.
   * - `quality`          the SCL policy mask, shared across bands.
   *
   * Keeping them apart is what lets display and analysis disagree without
   * either of them silently modifying the other's numbers.
   */
  masks: Eot1MaskLayout[];
  /** Display grid for this tile. */
  grid: { crs: string; tileSize: number; z: number; x: number; y: number };
  /** Geographic bounds of the tile: [west, south, east, north] in WGS84. */
  bounds: [number, number, number, number];
  /** True when scale/offset have already been applied exactly once. */
  calibrated: boolean;
  /** Source metadata, preserved for provenance and export. */
  sources: {
    collection: string;
    itemId: string;
    itemVersion: string | null;
    datetime: string;
    /** Native GSD of each source asset, in metres. */
    sourceResolutionM: Record<string, number>;
    /** 'bilinear' for continuous reflectance, 'nearest' for categorical. */
    resampling: Record<string, string>;
    /** Ground resolution of the *output* pixel. Not the sensor's GSD. */
    outputResolutionM: number;
    qualityResolutionM?: number;
    qualityResampling?: string;
    processingBaseline?: string | null;
    epsg?: number | null;
    qualityPolicy?: string;
    reflectancePolicy?: string;
  };
  calibration: {
    applied: boolean;
    appliedOnce: boolean;
    /** The NDVI denominator guard used to produce any derived index. */
    ndviEpsilon: number;
    reflectanceRange: [number, number];
    /** Per band: the exact values read from the item's STAC metadata. */
    perBand: Record<string, { scale: number; offset: number; nodata: number | null; asset?: string }>;
  };
  processingVersion: string;
  /** Provenance of the source data, preserved verbatim for export. */
  attribution: string;
}

/** Decoded tile, ready for upload to the GPU. */
export interface NumericTile {
  header: Eot1Header;
  /** Band name -> Float32Array of width*height. */
  bands: Record<string, Float32Array>;
  /** Mask name -> Uint8Array of width*height. 1 = valid. */
  masks: Record<string, Uint8Array>;
}

export interface TileKey {
  collection: string;
  scene: string;
  z: number;
  x: number;
  y: number;
  profile: TileProfile;
}

// ---------------------------------------------------------------------------
// Region statistics
// ---------------------------------------------------------------------------

export interface RegionStatsRequest {
  collection: string;
  sceneA: string;
  sceneB?: string;
  /** [west, south, east, north] in WGS84. */
  bbox: [number, number, number, number];
  /** Target ground sample distance in metres. Declared, never inferred. */
  resolutionM: number;
  qualityPolicy: string;
  threshold?: number;
}

export interface RegionStatsResponse {
  request: RegionStatsRequest;
  /** Fraction of requested samples that were valid in BOTH dates. */
  validCoverageFraction: number;
  sampleCount: number;
  commonValidCount: number;
  meanNdviA: number | null;
  meanNdviB: number | null;
  meanDelta: number | null;
  fractionAboveThreshold: number | null;
  fractionBelowThreshold: number | null;
  /** 32-bin histogram over the declared NDVI range. */
  histogram: { bins: number; min: number; max: number; counts: number[] };
  histogramDelta: { bins: number; min: number; max: number; counts: number[] };
  /** Set when results are derived from overview-level reads. */
  approximate: boolean;
  attribution: string;
  processingVersion: string;
}
