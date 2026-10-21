# Expanding the Skyfall scene catalog

## Integration requirement

Every selectable scene must align with the geographic map. Standalone previews
are not supported. Downloading and converting a model does not complete its
integration. Do not enable a scene using a guessed geographic transform.

## Current state

All 12 published scenes are registered and selectable, with satellite imagery,
green footprints and continuous map-to-3D camera framing. There are **zero pending
scenes** in the published catalog: eight Jacksonville models and four NYC models.
All real SOG assets decoded successfully on the CPU; hashes, counts and byte
sizes are validated against the manifest.

## Final batch: registered

Villa (JAX_168), Factory (JAX_264), E 12th St. (NYC_219) and Albany St. (NYC_336)
are enabled in the picker and **3D Footprints**, with measured registrations:

| Scene | Fit features | Withheld features | Maximum withheld error |
| --- | ---: | ---: | ---: |
| JAX_168 | 80 | 21 | 2.54 m |
| JAX_264 | 56 | 15 | 2.18 m |
| NYC_219 | 68 | 17 | 2.25 m |
| NYC_336 | 15 | 4 | 1.32 m |

Transforms, deduplicated feature pairs, withheld pairs, ground-height samples,
conservative coverage bounds and asset hashes are retained in
`docs/splat-registration/<ID>.json`. The final decoded-model projections were
inspected against reprojected Esri imagery across each footprint. Albany St.'s
footprint uses its dense landside core and excludes sparsely reconstructed water.

Viewer IDs come from the [author's project-page source](https://github.com/jayin92/skyfall-gs-page/blob/main/index.html).
Published locations are search hints, not runtime transforms. Source HTML is
retained under `reference/<ID>/author-location.html`. E 12th St.'s author page
omits the model ID and uses tab-separated coordinates; lookup now verifies the
canonical viewer URL and supports that coordinate format without guessing.

E 12th St. was measured using the already cached, overlapping Union Square
reference mosaic. Its actual tile origin and reference-reuse provenance are
recorded in the evidence. All four corners of its conservative footprint fit
inside that available reference imagery. The model-to-map fit comes from its
own feature matches, independently of Union Square's model registration.

E 12th St. overlaps Union Square coverage. Footprint clicks choose the nearest
registered scene centre among boxes containing the click, so both models remain
reachable. Hover draws that scene on top, and the picker also permits explicit
selection. Repeated-world and pointer-activation tests cover this overlap.

To reproduce model preparation and reference capture on the host:

```bash
npm run prepare:skyfall -- JAX_168 JAX_264 NYC_219 NYC_336 &&
npm run prepare:skyfall-reference -- JAX_168 JAX_264 NYC_219 NYC_336
```

These commands prepare inputs; they do not create or replace measured registration
records. Existing complete inputs are reused. Browser GPU rendering still needs
the host smoke test; unit tests verify reference residuals and camera continuity.

## Registered Jacksonville batch

[City Hall (JAX_164)](https://superspl.at/scene/5ff93d97),
[Stadium (JAX_175)](https://superspl.at/scene/6905e63a),
[Office Building (JAX_214)](https://superspl.at/scene/e3b02d34) and
[Lake Side (JAX_260)](https://superspl.at/scene/5a2ccc44) are now registered and
available in the picker and **3D Footprints**. The author's coordinates were used
only to locate reference imagery; each runtime transform comes from model/image
feature correspondences. The real SOGs decoded on the CPU and match their
manifest hashes, counts and byte sizes.

| Scene | Fit features | Withheld features | Maximum withheld error |
| --- | ---: | ---: | ---: |
| JAX_164 | 24 | 7 | 2.29 m |
| JAX_175 | 58 | 15 | 2.87 m |
| JAX_214 | 35 | 9 | 3.00 m |
| JAX_260 | 41 | 11 | 3.13 m |

The deduplicated reference pairs, withheld pairs, measured transforms, sampled
street heights, conservative model coverage bounds and asset hashes are retained
under `docs/splat-registration/`. Decoded-model projections were compared with
reprojected aerial imagery across the footprint, including bridge, road, park
and building outlines. Fit/withheld residuals and camera continuity are checked
by the test suite. GPU rendering still needs the host browser smoke test.

To reproduce model preparation and the reference cache on the host:

```bash
npm run prepare:skyfall -- JAX_164 JAX_175 JAX_214 JAX_260 &&
npm run prepare:skyfall-reference -- JAX_164 JAX_175 JAX_214 JAX_260
```

Existing completed models and tiles are reused. These commands prepare inputs;
they do not create or replace the measured registration records.

## Existing registration evidence

JAX_004 and NYC_010 were registered against the cached reference imagery. Their
41/39 fitted feature pairs and 11/10 held-out feature pairs are retained under
`docs/splat-registration/`. Held-out maximum residuals are 3.25 m and 1.91 m.
Visual overlays were inspected across the footprint. See
[SPLAT_GEOREGISTRATION.md](./SPLAT_GEOREGISTRATION.md) for methods and limitations.

The downloaded assets contain 1,524,134 and 3,083,544 splats respectively. Both
real SOGs decoded successfully on the CPU. Their hashes, counts and byte sizes
are recorded in `apps/web/public/splats/manifest.json`.

## Reproduce the reference-imagery cache

The execution sandbox cannot resolve `server.arcgisonline.com`. On the host,
from the repository root, run:

```bash
npm run prepare:skyfall-reference -- JAX_004 NYC_010
```

This caches zoom-18 World Imagery JPEG tiles and a geolocated tile index under
`/tmp/terrascope-skyfall/reference/<ID>/`. It searches a 700-ground-metre radius
around each author-provided location. Those locations are search hints, not
model-to-map transforms. Existing complete tiles are reused on retry. No scene
is enabled by this command. The cached imagery is for measuring alignment;
the application continues fetching imagery from the existing runtime service.

Set `SKYFALL_CACHE_DIR` to a persistent source cache directory, or set
`SKYFALL_REFERENCE_DIR` to override the reference cache root directly.

For future scenes, match top-down model projections to geolocated imagery, fit
and inspect the transforms, retain held-out reference features, record the
evidence, and enable the scenes only after registration is validated.

## Published catalog

`apps/web/src/data/skyfallCatalog.json` contains all 12 IDs and names from the
[official gallery](https://skyfall-gs.jayinnn.dev/). The
[published fused models](https://huggingface.co/jayinnn/Skyfall-GS-ply/tree/main)
include JAX_004, JAX_068, JAX_164, JAX_168, JAX_175, JAX_214, JAX_260, JAX_264,
NYC_004, NYC_010, NYC_219 and NYC_336. These are city-block models, not continuous
coverage of either city.

To prepare selected models or the full catalog:

```bash
npm run prepare:skyfall -- --list
npm run prepare:skyfall -- JAX_004 NYC_010
npm run prepare:skyfall -- --all
```

The default command without arguments prepares all twelve integrated scenes.
The full source collection is about 3 GB. Compression retains all source splats
and spherical harmonics bands. Set `SKYFALL_GPU=cpu` to compress without a hardware
compute adapter. Existing SOGs are reused; remove one to regenerate it. Do not
run multiple preparation commands against the same cache/output directories
at once. Completed assets update the manifest; failed work is cleaned up.

## Register and enable future scenes

1. Recover a geographic transform from source metadata, or measure a registration
   against geolocated aerial imagery as described in
   [SPLAT_GEOREGISTRATION.md](./SPLAT_GEOREGISTRATION.md).
2. Save reference features and the transform in `docs/splat-registration/<ID>.json`.
   Verify geographic position, scale, rotation, ground height and footprint.
   Inspect the overlay across roads and buildings throughout the footprint.
3. Add the verified metadata to `SKYFALL_SCENES` in
   `apps/web/src/data/splatScenes.ts`, using the exact catalog name and city.
   The selector and geographic discovery then include it automatically.
4. Run the checks, including map-to-3D camera continuity and real-reference
   residual tests, then visually verify the actual model against map imagery.

```bash
npm run test:skyfall
npm run typecheck
npm test
npm run build
```

With the dev server running on a host that allows browser/GPU access:

```bash
SPLAT_TEST_SCENES=JAX_168,JAX_264,NYC_219,NYC_336 SPLAT_SCREENSHOTS=/tmp/terrascope-new-scenes npm run test:splat
```

The default smoke test covers all twelve integrated scenes. It checks scene selection,
rendering, ground imagery, reset, cancellation and returning to the map. It does
not establish geographic accuracy; inspect the registration overlays as well.

Browser rendering cannot be verified in the execution sandbox because local
server sockets fail with `listen EPERM`. Unit tests, type checking, asset
validation and production builds can run there.

The viewer loads one model at a time. Use `VITE_SPLAT_BASE_URL` for external
model hosting where needed; see the asset README for hosting details.
