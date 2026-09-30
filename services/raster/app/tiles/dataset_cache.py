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
* downloaded bytes are capped by ``CPL_VSIL_CURL_CACHE_SIZE`` (see
  :mod:`app.gdal_config`), shared by every handle in every slot.

Eviction calls ``close()`` explicitly. Leaking GDAL datasets is how a
long-running container slowly runs out of file descriptors.
"""

from __future__ import annotations

import os
import queue
import threading
from collections import OrderedDict

import rasterio
from rasterio.io import DatasetReader

#: Five assets covers a full 4-band tile plus the quality layer.
DEFAULT_MAX_DATASETS = 8


class DatasetCache:
    """LRU cache of open datasets. Owned by one request at a time (a slot)."""

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


#: Number of tiles that may be built concurrently. Each slot owns its own
#: dataset handles, because a GDAL dataset must never be read from two threads
#: at once -- that is what corrupted reads and deadlocked ``/vsicurl`` when one
#: process-wide cache was shared by every request thread.
TILE_WORKERS = max(1, int(os.environ.get("TILE_WORKERS", "4")))

#: Idle slots. LIFO so the most recently used (warmest) handles are reused
#: first. Every cache in here is owned by at most one request at a time.
_SLOTS: "queue.LifoQueue[DatasetCache]" = queue.LifoQueue()
for _ in range(TILE_WORKERS):
    _SLOTS.put(DatasetCache())

#: Retained for callers that only want a handle to "a" cache for inspection.
#: Requests never read through it; they borrow a slot via :class:`AssetPool`.
DATASETS = DatasetCache()


class AssetPool:
    """Request-scoped borrow of one dataset-cache slot.

    Entering (or the first ``open``) blocks until a slot is free, which is also
    what bounds concurrent GDAL work to ``TILE_WORKERS``. Exiting returns the
    slot with its handles still open, so the next request on the same scene
    starts warm.
    """

    def __init__(self, cache: DatasetCache | None = None) -> None:
        self._fixed = cache
        self._slot: DatasetCache | None = None

    def _cache(self) -> DatasetCache:
        if self._fixed is not None:
            return self._fixed
        if self._slot is None:
            self._slot = _SLOTS.get()
        return self._slot

    def open(self, href: str) -> DatasetReader:
        return self._cache().open(href)

    def acquire(self) -> None:
        """Borrow the slot now. Required before opening from several threads:
        the lazy borrow in ``_cache`` is not atomic, and two racing threads
        would each take a slot and leak one."""
        self._cache()

    def close(self) -> None:
        if self._slot is not None:
            slot, self._slot = self._slot, None
            _SLOTS.put(slot)

    def __enter__(self) -> "AssetPool":
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
