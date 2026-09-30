"""STAC client for the Earth Search catalog.

Security posture (see plan section 7): the raster service never accepts a
source URL from a client. Callers supply a collection + item id; this module
resolves the item itself, then validates every asset host against the
collection's allowlist. That keeps the service from becoming an open URL
fetcher even if a caller is compromised.
"""

from __future__ import annotations

import os
import time
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urlparse

import httpx

STAC_URL = os.environ.get("EARTH_SEARCH_URL", "https://earth-search.aws.element84.com/v1")

#: Only these hosts may ever be dereferenced for COG reads. Anything else is
#: rejected before a request is made. Redirect targets are re-validated.
ALLOWED_HOSTS: frozenset[str] = frozenset(
    {
        "sentinel-cogs.s3.us-west-2.amazonaws.com",
        "e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com",
        "sentinel-s2-l2a-cogs.s3.us-west-2.amazonaws.com",
    }
)

#: STAC item ids are path segments in our own URLs; keep them boring.
SAFE_ID = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)

MAX_ITEMS_PER_PAGE = 100
USER_AGENT = "TerraScope/0.1 (prototype earth-observation explorer)"


class StacError(RuntimeError):
    """Upstream catalog failure. Carries an HTTP status the API can surface."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class HostNotAllowed(StacError):
    def __init__(self, host: str) -> None:
        super().__init__(f"asset host {host!r} is not in the allowlist", status=400)
        self.host = host


def to_rfc3339(value: str, end_of_day: bool = False) -> str:
    """Normalise a date bound to a full RFC3339 instant.

    A bare date (YYYY-MM-DD) at the start of an interval becomes midnight UTC
    of that day; at the end of an interval it becomes the last second of that
    day, so a caller asking for "2024-06-27" includes all acquisitions on
    that calendar day.
    """
    text = value.strip()
    if not text:
        raise StacError("empty date bound", status=400)
    if text.endswith("Z") or _has_offset(text):
        return text
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            if end_of_day:
                return f"{text}T23:59:59Z"
            return f"{text}T00:00:00Z"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", text):
            return f"{text}:00Z"
    except Exception as exc:
        raise StacError(f"unparseable date {value!r}", status=400) from exc
    raise StacError(f"date {value!r} is not RFC3339 or YYYY-MM-DD", status=400)


def _has_offset(text: str) -> bool:
    """True for a trailing ``+HH:MM`` / ``-HH:MM`` UTC offset."""
    return bool(re.search(r"[+-]\d{2}:\d{2}$", text))


def validate_id(value: str, max_len: int = 128) -> str:
    """Reject anything that could escape a path segment or a cache key."""
    if not value or len(value) > max_len:
        raise StacError(f"invalid identifier length {len(value)}", status=400)
    if not set(value) <= SAFE_ID:
        raise StacError("identifier contains disallowed characters", status=400)
    return value


def validate_asset_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise StacError(f"asset scheme {parsed.scheme!r} rejected; https required", status=400)
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise HostNotAllowed(host)
    return url


def _client(timeout: float) -> httpx.Client:
    # follow_redirects=False so redirect targets can be re-validated below.
    return httpx.Client(
        timeout=httpx.Timeout(timeout, connect=min(timeout, 10.0)),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )


@dataclass
class StacClient:
    base_url: str = STAC_URL
    timeout: float = 20.0
    #: Parsed items, keyed by "collection/item". A display tile costs a catalog
    #: round trip only on the first request for a scene; the item is immutable
    #: for our purposes and re-fetching it per tile dominates warm latency.
    cache_size: int = 128
    _client: httpx.Client | None = None
    _items: "OrderedDict[str, dict[str, Any]]" = field(default_factory=OrderedDict)

    def _ensure(self) -> httpx.Client:
        # Long-lived so the connection pool is reused across requests; a
        # per-request client would re-run TLS for every tile.
        if self._client is None:
            self._client = _client(self.timeout)
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
        self._items.clear()

    # -- catalog ----------------------------------------------------------
    def search(
        self,
        *,
        collections: Iterable[str],
        bbox: tuple[float, float, float, float],
        start: str,
        end: str,
        max_cloud_cover: float | None = None,
        limit: int = 20,
        direction: str = "desc",
    ) -> dict[str, Any]:
        if direction not in ("asc", "desc"):
            raise StacError(f"sort direction {direction!r} must be 'asc' or 'desc'", status=400)
        body: dict[str, Any] = {
            "collections": list(collections),
            "bbox": list(bbox),
            # The end bound is pushed to the last instant of the day: a caller
            # asking for 2024-06-27 means the whole day, not its first
            # millisecond. Only applied to bare dates, so an explicit
            # timestamp still means exactly that instant.
            "datetime": f"{to_rfc3339(start, end_of_day=False)}/{to_rfc3339(end, end_of_day=True)}",
            "limit": max(1, min(int(limit), MAX_ITEMS_PER_PAGE)),
            "sortby": [{"field": "properties.datetime", "direction": direction}],
        }
        if max_cloud_cover is not None:
            body["query"] = {"eo:cloud_cover": {"lte": float(max_cloud_cover)}}

        return self.search_page(body)

    def search_page(self, body: dict[str, Any]) -> dict[str, Any]:
        """Run a previously validated STAC search body against the fixed endpoint.

        Pagination never accepts an upstream URL. The API layer unwraps only a
        constrained JSON body and this method always posts it to our configured
        catalog's `/search` route.
        """
        try:
            resp = self._ensure().post(f"{self.base_url}/search", json=body)
        except httpx.HTTPError as exc:
            raise StacError(f"catalog request failed: {exc}", status=504) from exc
        if resp.status_code == 400:
            raise StacError(f"catalog rejected the query: {resp.text[:200]}", status=400)
        if resp.status_code >= 400:
            raise StacError(f"catalog returned {resp.status_code}", status=502)
        return resp.json()

    def remember(self, collection: str, item: dict[str, Any]) -> None:
        """Keep an item a search already returned.

        A search response carries complete items. Caching them means the first
        tile or frame of a scene the user just found does not pay another
        catalog round trip (0.4-1.1 s measured) to fetch the same JSON again.
        """
        item_id = item.get("id")
        if not isinstance(item_id, str):
            return
        try:
            validate_id(collection, max_len=64)
            validate_id(item_id)
        except StacError:
            return
        key = f"{collection}/{item_id}"
        self._items[key] = item
        self._items.move_to_end(key)
        while len(self._items) > self.cache_size:
            self._items.popitem(last=False)

    def get_item(self, collection: str, item_id: str) -> dict[str, Any]:
        validate_id(collection, max_len=64)
        validate_id(item_id)
        key = f"{collection}/{item_id}"
        cached = self._items.get(key)
        if cached is not None:
            self._items.move_to_end(key)
            return cached
        url = f"{self.base_url}/collections/{collection}/items/{item_id}"
        try:
            resp = self._ensure().get(url)
        except httpx.HTTPError as exc:
            raise StacError(f"item request failed: {exc}", status=504) from exc
        if resp.status_code == 404:
            raise StacError(f"item {item_id!r} not found in {collection!r}", status=404)
        if resp.status_code >= 400:
            raise StacError(f"catalog returned {resp.status_code}", status=502)
        item = resp.json()
        self._items[key] = item
        while len(self._items) > self.cache_size:
            self._items.popitem(last=False)
        return item


def fetch_validated_prefix(url: str, nbytes: int = 65536, *, timeout: float = 30.0) -> bytes:
    """Fetch the leading ``nbytes`` of a COG, re-validating every redirect hop.

    Used for header inspection before handing the URL to GDAL, and to confirm
    that range reads are actually honoured upstream.
    """
    current = validate_asset_url(url)
    with httpx.Client(
        timeout=httpx.Timeout(timeout), follow_redirects=False, headers={"User-Agent": USER_AGENT}
    ) as client:
        for _ in range(4):
            resp = client.get(current, headers={"Range": f"bytes=0-{nbytes - 1}"})
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location")
                if not location:
                    raise StacError("redirect without Location", status=502)
                current = validate_asset_url(str(httpx.URL(current).join(location)))
                continue
            if resp.status_code not in (200, 206):
                raise StacError(f"asset returned {resp.status_code}", status=502)
            return resp.content
    raise StacError("too many redirects", status=502)


def supports_range_requests(url: str, *, timeout: float = 30.0) -> bool:
    """True when the upstream honours a byte range. Probed once per asset."""
    with httpx.Client(
        timeout=httpx.Timeout(timeout), follow_redirects=False, headers={"User-Agent": USER_AGENT}
    ) as client:
        resp = client.get(validate_asset_url(url), headers={"Range": "bytes=0-15"})
    return resp.status_code == 206



def now_ms() -> int:
    return int(time.time() * 1000)
