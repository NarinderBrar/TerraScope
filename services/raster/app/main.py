"""Uvicorn entrypoint for the raster service."""

from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.api.routes:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
        # Tile requests fan out to four COG reads; the default 5s is too tight
        # for a cold container that must also open the catalog item.
        timeout_keep_alive=30,
    )
