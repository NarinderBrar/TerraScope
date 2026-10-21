# Skyfall-GS city models

Source: https://huggingface.co/jayinnn/Skyfall-GS-ply (Apache-2.0).

- `JAX_068.sog` comes from `JAX_068_final.ply`.
- `NYC_004.sog` comes from `NYC_004_final.ply`.
- `JAX_004.sog` comes from `JAX_004_final.ply`.
- `NYC_010.sog` comes from `NYC_010_final.ply`.
- `JAX_164.sog` comes from `JAX_164_final.ply`.
- `JAX_175.sog` comes from `JAX_175_final.ply`.
- `JAX_214.sog` comes from `JAX_214_final.ply`.
- `JAX_260.sog` comes from `JAX_260_final.ply`.
- `JAX_168.sog` comes from `JAX_168_final.ply`.
- `JAX_264.sog` comes from `JAX_264_final.ply`.
- `NYC_219.sog` comes from `NYC_219_final.ply`.
- `NYC_336.sog` comes from `NYC_336_final.ply`.

All twelve are selectable and have measured map registration, satellite overlays
and map-to-3D camera continuity. There is no standalone 3D preview mode.

The viewer loads `streamed/<scene>/lod-meta.json` and its bounded JSON/WebP chunks
progressively, from LOD 3 (coarse) toward LOD 1 (full source count). Prepare these
with `npm run prepare:skyfall-lods -- --all` after preparing the original SOGs.
Keep the complete `streamed` directory when hosting assets. See
[streaming and validation](../../../../docs/SPLAT_STREAMING.md) for thread
ownership, preparation and alignment checks.

From the repository root, run `npm run prepare:skyfall` to download missing
source models into `/tmp/terrascope-skyfall` and convert missing assets with
`@playcanvas/splat-transform@2.3.1`. Override `SKYFALL_CACHE_DIR` to reuse another
local source directory. Use `SKYFALL_GPU=1` to select a hardware adapter by index, or set `SKYFALL_GPU=cpu` to bypass GPU compression. Existing
SOG outputs are reused; remove a specific output to regenerate it.

The preparation tool also supports all 12 published Skyfall models:

```bash
npm run prepare:skyfall -- --list
npm run prepare:skyfall -- JAX_004 NYC_010
npm run prepare:skyfall -- --all
```

Explicit IDs prepare only that batch; `--all` prepares the full catalog.
Successful preparation updates `manifest.json` with the model's measured size,
count and hashes. Failed downloads/conversions are removed before a retry.
The default command prepares all twelve integrated scenes listed above. Additional
models need verified geographic registration before they can appear on the map;
see [the expansion workflow](../../../../docs/SKYFALL_EXPANSION.md).

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
