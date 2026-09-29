"""Shared fixtures.

`CA` is a populated agricultural valley with a mixed water/vegetation/urban
texture, chosen so NDVI has real spatial structure rather than a single flat
value. The reference tile is pinned so GPU/CPU parity is measured on identical
inputs across runs.
"""

from __future__ import annotations

from pathlib import Path

#: West, south, east, north.
CA = (-121.5, 38.0, -121.2, 38.2)

#: A clear-sky June acquisition over CA from the 2024 baseline-05.10 archive.
CLOUD_REFERENCE_SCENE = "S2B_10SFH_20240627_0_L2A"

#: z/x/y of the reference display tile, inside the granule.
TILE = (13, 1335, 3156)

REPO_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_DIR = Path(__file__).resolve().parent / "fixtures"
