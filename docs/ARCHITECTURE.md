# Architecture

The React SPA owns interaction and WebGPU rendering. `MapScene` keeps camera and GPU resources outside React, requests visible numeric tiles through `RasterClient`, retains one coarse parent during refinement, and evicts least-recently-used resources within a fixed budget.

The edge Worker serves the SPA and routes only `/raster/api/*` to a pool of Cloudflare Containers. Immutable EOT1 tile responses are checked by size, cached first in the regional Cache API and persistently in R2, and streamed without buffering in the Worker. Search, metadata, and statistics responses are not persisted by the tile cache.

The FastAPI container is the trust boundary for source imagery. It accepts collection and item identifiers—not arbitrary URLs—resolves approved Earth Search assets, validates redirect hosts, reads aligned COG windows with GDAL, applies calibration once, and uses nearest-neighbour sampling for categorical scene classification. Continuous reflectance uses bilinear resampling on the exact EPSG:3857 XYZ grid.

Analytical validity requires valid red and NIR reflectance, the selected quality policy, finite samples, and an NDVI denominator larger than `1e-3`. Two-date statistics use the common valid mask. Region statistics report sample fractions rather than falsely treating Web Mercator pixels as constant-area square kilometres.
