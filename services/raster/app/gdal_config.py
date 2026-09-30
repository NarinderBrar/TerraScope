"""GDAL configuration for remote COG access.

Import this module *before* rasterio anywhere in the process. GDAL reads these
settings once, at first use, and later mutation has no effect -- which is why
they live here rather than being passed per-open.

The settings are the ones that matter for Cloud Optimized GeoTIFFs over HTTPS.
Without them GDAL issues one request per tile strip and a single display tile
costs tens of seconds; with them the same tile costs single-digit seconds.
"""

from __future__ import annotations

import os

#: Skip the HTTP directory listing that otherwise precedes every open.
GDAL_DISABLE_READDIR_ON_OPEN = "EMPTY_DIR"
#: Do not probe sibling extensions (a .ovr, a .aux.xml) for every asset.
CPL_VSIL_CURL_ALLOWED_EXTENSIONS = ".tif"
#: S3 does not support multipart/byteranges; multi-range causes ZIP/TIFF decode errors.
GDAL_HTTP_MULTIRANGE = "NO"
#: Coalesce adjacent ranges, which a tiled TIFF scan produces constantly.
GDAL_HTTP_MERGE_CONSECUTIVE_RANGES = "YES"
#: Read enough of the header at open time to plan the reads.
GDAL_INGESTED_BYTES_AT_OPEN = "16384"
#: GDAL rounds every block read up to a whole chunk. At 4 MiB one z12 band
#: fetched 16 MiB to use 1.3 MiB; at 16 KiB it fetches ~1.3 MiB in the same
#: number of requests, because consecutive chunks are merged anyway.
CPL_VSIL_CURL_CHUNK_SIZE = "16384"
#: Downloaded byte ranges live in /vsicurl's process-wide region cache, shared
#: by every dataset handle in every slot. That is the cache that makes a
#: revisited tile cheap, and its 16 MiB default holds less than one screen.
CPL_VSIL_CURL_CACHE_SIZE = str(256 * 1024 * 1024)
#: VSI_CACHE is a second cache *per open file* (VSI_CACHE_SIZE each). With
#: several slots of several handles it multiplies memory while duplicating
#: what the region cache above already holds, so it stays off.
VSI_CACHE = "FALSE"
#: Reuse connections; S2 COGs are all on the same regional endpoint.
GDAL_HTTP_MAX_RETRY = "3"
GDAL_HTTP_RETRY_DELAY = "1"
#: A stalled range request must fail (and be retried) rather than hold a tile
#: slot forever. Abort on sustained low throughput, not total duration, so a
#: slow-but-progressing transfer on a weak link is not cut off mid-block.
GDAL_HTTP_CONNECTTIMEOUT = "10"
GDAL_HTTP_LOW_SPEED_TIME = "10"
GDAL_HTTP_LOW_SPEED_LIMIT = "4096"
GDAL_HTTP_TIMEOUT = "120"

_SETTINGS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": GDAL_DISABLE_READDIR_ON_OPEN,
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": CPL_VSIL_CURL_ALLOWED_EXTENSIONS,
    "GDAL_HTTP_MULTIRANGE": GDAL_HTTP_MULTIRANGE,
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": GDAL_HTTP_MERGE_CONSECUTIVE_RANGES,
    "GDAL_INGESTED_BYTES_AT_OPEN": GDAL_INGESTED_BYTES_AT_OPEN,
    "CPL_VSIL_CURL_CHUNK_SIZE": CPL_VSIL_CURL_CHUNK_SIZE,
    "CPL_VSIL_CURL_CACHE_SIZE": CPL_VSIL_CURL_CACHE_SIZE,
    "VSI_CACHE": VSI_CACHE,
    "GDAL_HTTP_MAX_RETRY": GDAL_HTTP_MAX_RETRY,
    "GDAL_HTTP_RETRY_DELAY": GDAL_HTTP_RETRY_DELAY,
    "GDAL_HTTP_CONNECTTIMEOUT": GDAL_HTTP_CONNECTTIMEOUT,
    "GDAL_HTTP_LOW_SPEED_TIME": GDAL_HTTP_LOW_SPEED_TIME,
    "GDAL_HTTP_LOW_SPEED_LIMIT": GDAL_HTTP_LOW_SPEED_LIMIT,
    "GDAL_HTTP_TIMEOUT": GDAL_HTTP_TIMEOUT,
}


def apply() -> None:
    """Apply the COG settings, without clobbering explicit operator overrides."""
    for key, value in _SETTINGS.items():
        os.environ.setdefault(key, value)


def prefix(url: str) -> str:
    """Route a remote URL through GDAL's range-request driver.

    Without the ``/vsicurl/`` prefix GDAL can fall back to whole-file reads for
    some code paths, which for a 222 MB Sentinel-2 band is unusable.
    """
    if url.startswith("/vsi"):
        return url
    if url.startswith(("http://", "https://")):
        return f"/vsicurl/{url}"
    return url


apply()
