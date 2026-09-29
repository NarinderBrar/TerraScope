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
#: Ask for several byte ranges per request; COG tiles are scattered.
GDAL_HTTP_MULTIRANGE = "YES"
#: Coalesce adjacent ranges, which a tiled TIFF scan produces constantly.
GDAL_HTTP_MERGE_CONSECUTIVE_RANGES = "YES"
#: Read enough of the header at open time to plan the reads.
GDAL_INGESTED_BYTES_AT_OPEN = "16384"
#: Larger transfer chunk than the 16 KiB default.
CPL_VSIL_CURL_CHUNK_SIZE = "4194304"
#: Cache decoded tiles so the second pass over a band hits memory.
VSI_CACHE = "TRUE"
#: Total decoded-block memory across all open datasets. Bounds container RSS.
VSI_CACHE_SIZE = str(128 * 1024 * 1024)
#: Reuse connections; S2 COGs are all on the same regional endpoint.
GDAL_HTTP_MAX_RETRY = "3"
GDAL_HTTP_RETRY_DELAY = "1"

_SETTINGS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": GDAL_DISABLE_READDIR_ON_OPEN,
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": CPL_VSIL_CURL_ALLOWED_EXTENSIONS,
    "GDAL_HTTP_MULTIRANGE": GDAL_HTTP_MULTIRANGE,
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": GDAL_HTTP_MERGE_CONSECUTIVE_RANGES,
    "GDAL_INGESTED_BYTES_AT_OPEN": GDAL_INGESTED_BYTES_AT_OPEN,
    "CPL_VSIL_CURL_CHUNK_SIZE": CPL_VSIL_CURL_CHUNK_SIZE,
    "VSI_CACHE": VSI_CACHE,
    "VSI_CACHE_SIZE": VSI_CACHE_SIZE,
    "GDAL_HTTP_MAX_RETRY": GDAL_HTTP_MAX_RETRY,
    "GDAL_HTTP_RETRY_DELAY": GDAL_HTTP_RETRY_DELAY,
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
