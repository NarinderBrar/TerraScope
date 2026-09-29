"""Bounded cache of open remote COG datasets.

Opening a 222 MB Sentinel-2 band over HTTPS is not the expensive part -- the
repeated *re-open* is. Each ``rasterio.open`` re-reads the TIFF directory and
re-establishes a session, and a display tile needs five of them.

Measured on the reference connection, four consecutive display tiles from one
scene take 14.8 s, 12.6 s, 5.1 s and 0.29 s. The first two pay for fetching the
blocks; the last is served entirely from GDAL's VSI cache. Keeping the dataset
handles alive across requests is what turns the last two into the last one.

The cache is bounded on both axes:

* at most ``max_datasets`` open handles, LRU evicted, so a client panning
  across many scenes cannot accumulate sockets or file descriptors;
* GDAL's own VSI cache is capped by ``VSI_CACHE_SIZE`` (see
  :mod:`app.gdal_config`), which bounds the decoded-block memory.

Eviction calls ``close()`` explicitly. Leaking GDAL datasets is how a
long-running container slowly runs out of file descriptors.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

import rasterio
from rasterio.io import DatasetReader

#: Five assets covers a full 4-band tile plus the quality layer.
DEFAULT_MAX_DATASETS = 8


class DatasetCache:
    """LRU cache of open datasets, safe to share across requests."""

    def __init__(self, max_datasets: int = DEFAULT_MAX_DATASETS) -> None:
        self._max = max(1, max_datasets)
        self._datasets: "OrderedDict[str, DatasetReader]" = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def open(self, href: str) -> DatasetReader:
        with self._lock:
            existing = self._datasets.get(href)
            if existing is not None:
                self._datasets.move_to_end(href)
                self.hits += 1
                return existing
        # Open outside the lock: a cold open takes seconds and there is no
        # point serialising concurrent misses behind each other. A duplicate
        # open from a racing thread is discarded below.
        dataset = rasterio.open(href)
        with self._lock:
            raced = self._datasets.get(href)
            if raced is not None:
                self._datasets.move_to_end(href)
                dataset.close()
                self.hits += 1
                return raced
            self._datasets[href] = dataset
            self.misses += 1
            while len(self._datasets) > self._max:
                _, evicted = self._datasets.popitem(last=False)
                try:
                    evicted.close()
                except Exception:  # pragma: no cover - best effort teardown
                    pass
            return dataset

    def close_all(self) -> None:
        with self._lock:
            while self._datasets:
                _, dataset = self._datasets.popitem()
                try:
                    dataset.close()
                except Exception:  # pragma: no cover
                    pass

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._datasets)

    def stats(self) -> dict[str, int | float]:
        with self._lock:
            total = self.hits + self.misses
            return {
                "open": len(self._datasets),
                "hits": self.hits,
                "misses": self.misses,
                "hitRate": round(self.hits / total, 4) if total else 0.0,
            }


#: Process-wide cache. A container is single-purpose, so sharing one instance
#: across requests is what makes the warm path fast.
DATASETS = DatasetCache()


class AssetPool:
    """Request-scoped handle holder that borrows from the shared cache.

    Kept as a context manager so the call sites read the same as before, but
    datasets now outlive the request instead of being closed with it.
    """

    def __init__(self, cache: DatasetCache | None = None) -> None:
        self._cache = cache or DATASETS

    def open(self, href: str) -> DatasetReader:
        return self._cache.open(href)

    def close(self) -> None:
        # Deliberately a no-op: the cache owns the lifetime. This is the one
        # behavioural difference from a naive per-request pool, and it is the
        # whole point of the module.
        return None

    def __enter__(self) -> "AssetPool":
        return self

    def __exit__(self, *exc: object) -> None:
        return None
