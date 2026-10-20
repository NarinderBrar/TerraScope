# Skyfall-GS city models

Source: https://huggingface.co/jayinnn/Skyfall-GS-ply (Apache-2.0).

- `JAX_068.sog` comes from `JAX_068_final.ply`.
- `NYC_004.sog` comes from `NYC_004_final.ply`.

From the repository root, run `npm run prepare:skyfall` to download missing
source models into `/tmp/terrascope-skyfall` and convert missing assets with
`@playcanvas/splat-transform@2.3.1`. Override `SKYFALL_CACHE_DIR` to reuse another
local source directory. Use `SKYFALL_GPU=1` to select a hardware adapter by index, or set `SKYFALL_GPU=cpu` to bypass GPU compression. Existing
SOG outputs are reused; remove a specific output to regenerate it.

All source splats and spherical harmonics bands are retained; SOG quantizes
model attributes. Geographic discovery and map placement use per-scene imagery
registration; see `docs/SPLAT_GEOREGISTRATION.md`. The original plan's city
bounding boxes are superseded. This is visual registration, not a surveyed georeference.

Vite copies these assets into the production build. If the hosting platform's
asset size limit is exceeded, serve the SOGs from object storage and build with
`VITE_SPLAT_BASE_URL=https://your-model-host/splats` with appropriate CORS
headers. Workers Static Assets has a [25 MiB per-file limit](https://developers.cloudflare.com/workers/platform/limits/#static-assets).
For such a build, exclude local SOG files from the static-asset upload. Load time depends on device,
network and model size; the plan's two-second target requires measurement on the
target deployment.
