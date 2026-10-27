# Progressive Gaussian splat tiles

The twelve registered Skyfall scenes load from spatial octrees at
`splats/streamed/<scene>/lod-meta.json`. The viewer requests coarse tiles first,
keeps them visible while finer tiles arrive, and refines according to the camera
and a two-million-visible-splat budget. Zooming closer requests finer detail;
zooming out can keep distant areas coarse. The entire city does not need to
reach LOD 1 at once.

| Viewer label | Engine level | Preparation |
| --- | --- | --- |
| LOD 3 | 2 | Approximately 6.25% of source count, merged Gaussians |
| LOD 2 | 1 | Approximately 25% of source count, merged Gaussians |
| LOD 1 | 0 | All source splats, with SOG attribute quantization |

The original scene origin, rotation, scale, ground height and geographic
footprint apply to every level. Camera framing uses the complete octree bounds
once at entry, never individual chunk bounds during refinement.

## Thread and resource ownership

`splat.worker.ts` fetches chunk metadata and WebP textures, decodes ImageBitmaps,
and computes position arrays from the encoded means using an OffscreenCanvas.
It transfers bitmap ownership and the position buffer to the main thread.
The native resource receives those positions directly, bypassing centre packing
and GPU readback on the main thread. The engine also uses its sorting worker.

GPU resource creation, texture uploads and rendering still happen on the main
thread. The converter targets 64K-splat chunks and rejects chunks above 128K.
The runtime limits work to two concurrent chunks and yields between texture
preparations. These bounds reduce long tasks; smoothness and upload cost still
need measurement on the target browser and GPU.

The native PlayCanvas octree selects and prioritizes visible spatial LODs, with
`lodUnderfillLimit = 2` for coarse-first loading and finer prefetch. Its adapter
retains coarse resources until replacements arrive. Unneeded resources expire
after a 60-tick cooldown. Closing the scene aborts requests, terminates the loading
worker and releases transferred images and GPU resources.

Only initial coarse loading uses the loading overlay. The smaller detail status
reports the finest level currently cached and whether work is pending; it does
not imply that every visible area has that quality. Detail failures retain the
current scene and expose **Retry detail** after three attempts. Initial coarse
failure instead offers the scene retry flow.

The coarse canvas is revealed independently of satellite imagery readiness;
slow map requests cannot keep ready splats invisible. Viewer code starts loading
on hover, pointer press or keyboard focus on a 3D entry point. Activation fetches
the index concurrently with graphics-device initialization, then starts spatial
streaming. A cold entry still needs the viewer module, graphics pipelines and
the first chunk's metadata/textures before there are splats to draw. These startup
costs differ from the subsequent worker-based refinement.

## Prepare and validate assets

```bash
npm run prepare:skyfall-lods -- --all
# Or supply scene IDs to prepare a smaller batch.
npm run prepare:skyfall-lods -- JAX_004 NYC_004
```

The tool uses installed `@playcanvas/splat-transform@2.3.1` on the CPU, reuses
intermediate merged PLYs under `SKYFALL_CACHE_DIR/lod` (default
`/tmp/terrascope-skyfall/lod`), validates the original manifest hash, and publishes
each scene directory atomically. Existing validated output is reused. Full-detail
counts, decreasing coarse counts, file ranges and bounded chunk sizes are checked
before publication. Original `.sog` files and geographic registration are retained.

After conversion, check coordinate continuity using Python with NumPy, SciPy and
OpenCV available:

```bash
python3 scripts/verify-splat-lod-alignment.py
npm test -- splatLods
```

The geometry check compares 512 uniformly sampled positions per chunk to the
corresponding conversion input in 3D: the registered SOG for LOD 1 and cached
merged PLYs for LODs 2 and 3. It requires a maximum distance below 0.15 model units
at every level and stores `alignment.json` alongside source hashes and conversion
counts in `provenance.json`. Keep the conversion cache until this check completes.
This checks conversion continuity; it
does not replace the imagery registration evidence in `docs/splat-registration`.

Host the complete `streamed` directory, including JSON and WebP files, at the
configured `VITE_SPLAT_BASE_URL` with CORS enabled when cross-origin. Uploading
only the old monolithic SOG files is insufficient. Vite copies the local assets
into the production build.

Automated tests cover position decoding, cancellation and late transfers,
concurrent loading and prioritization, coarse fallback during failures, retries,
native resource creation without centre readback, viewer loading states and all
twelve generated asset sets. Run `npm run test:splat` against a local dev server
for browser rendering and map/camera checks. Browser smoothness requires a real
GPU/browser check in an environment that can launch Chrome.
