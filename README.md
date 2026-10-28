# TerraScope

TerraScope is a WebGPU Earth-observation explorer for live Sentinel-2 Level-2A imagery. It searches Earth Search, reads selective COG windows in a GDAL service, sends calibrated numeric EOT1 tiles, and performs interactive NDVI and two-date visualization in the browser.

The urban viewer includes all **12 map-aligned Skyfall Gaussian splat scenes**:
eight Jacksonville locations and four New York City locations. Every scene has
measured registration and a clickable green footprint; there is no standalone
preview mode. See the [scene catalog and registration evidence](docs/SKYFALL_EXPANSION.md).

## What works

- Continuous map navigation: drag to pan, right-drag to orbit, and zoom out to
  transition automatically into the globe. No 2D/3D switch is required.
- **Urban Lab** inside registered 3D scenes: OpenStreetMap buildings, roads, trees,
  stops and crossings; animated simulated traffic; sun and pedestrian shade;
  before/proposed road closures, signal-capacity assumptions, bus lanes and mature
  trees. Includes source labels and scenario JSON export. See [models and limits](docs/URBAN_LAB.md).
- Explorer and 3D ground maps share Esri World Imagery. Explorer zoom reaches level 20, with lower-resolution imagery retained where detail is unavailable; Sentinel-2 analysis tiles keep their existing level-14 grid.
- **3D Footprints** highlights registered splat coverage with transparent green boxes. Click a green area to open its map-aligned scene; dragging and scrolling still pan and zoom. Coverage stays enabled when returning from 3D, and registered scenes appear automatically. Overlapping coverage opens the scene whose centre is nearest the click.
- The 3D satellite ground streams with the camera beyond the city model, refining imagery as you approach and retaining a coarse overview while tiles load. Pan, orbit and regional zoom-out share the same registered frame.
- Gaussian splats stream spatially from LOD 3 (coarse) toward LOD 1 (full detail), with chunk decoding and position preparation in a Web Worker. Coarse tiles stay visible during refinement; detail retries keep the scene open. See [preparation and validation](docs/SPLAT_STREAMING.md).
- Worldwide bbox/date/cloud scene discovery with validated pagination.
- Native WebGPU map with cursor-centred zoom, pan, cancellation, bounded residency, and coarse-parent fallback.
- Natural colour, false colour, individual bands, NDVI, date swipe, and masked NDVI difference.
- Pixel inspection with reflectance, NDVI, acquisition date, coordinates, and quality state.
- Bounded rectangular statistics at an explicit resolution, common-mask temporal comparison, histograms, and JSON/CSV export.
- Share links restoring camera, query, scene pair, and visualization settings.
- Session performance measurements for frame time, transfer volume, decoding, memory estimate, and cache hits.
- FastAPI/GDAL raster container plus Cloudflare Worker Static Assets, Cache API, and R2 tile caching.

NDVI difference describes index change; it does not identify crop damage, deforestation, or cause.

## Local development

Requirements: Node.js 20+, Python 3.12, GDAL/rasterio-compatible native libraries, and a WebGPU-capable browser.

```bash
npm install
python3 -m venv services/raster/.venv
services/raster/.venv/bin/pip install -r services/raster/requirements.txt
services/raster/scripts/serve.sh
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/raster` to the service on port 8080.

## Verification

```bash
npm run verify
npm run build
npm run typecheck:edge
```

`npm run test:gpu` runs the WebGPU parity fixture in Chromium. Linux environments may require Vulkan/WebGPU browser flags. Network integration tests are opt-in:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 services/raster/.venv/bin/python -m pytest -m network
```

## Deployment

The production Worker configuration is [apps/edge/wrangler.jsonc](apps/edge/wrangler.jsonc). Create the named R2 buckets, ensure Docker is running, authenticate Wrangler, then use:

```bash
npm run deploy:staging
npm run deploy
```

Cloudflare Containers requires an eligible paid Workers account. Set R2 lifecycle rules for derived tiles according to the intended retention window. No credentials belong in frontend variables or committed files. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
