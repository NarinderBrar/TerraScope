# Segmented splat appearance

The dashboard has one **Segmented view** switch. It colours all available
categories together with a luminous holographic grid, fast upward scan bands,
vertical light trails, and a different pulse phase for each category. Switching
it off restores original splat RGB. No camera, model, Gaussian geometry,
registration, alpha, or LOD stream is replaced. The existing entry reveal remains.
Reduced motion keeps colours static. A nearest-sampled class atlas prevents
interpolation between category IDs. Unknown regions appear as muted context.

The inputs are the completed `semantic_categories_v1` exports from
`Ref/LangSplat/output/semantic_categories_v1`, generated from existing LangSplat
features. They are experimental similarity fields, not validated segmentation
or evidence of new model training. Buildings and vegetation dominate. Road and
vehicle results are sparse; no AC units were detected. The legend only shows
classes with supported labels and names missing classes explicitly.

Regenerate the combined appearance assets from the OrbitWorks/TerraScope root:

```bash
../.venv-langsplat/bin/python scripts/prepare_segmented_view.py
../.venv-langsplat/bin/python scripts/test_prepare_segmented_view.py
```

The packer validates batch completion, source SHA against the registered scene
catalogue, category identities, common bounds/layout, and input binary checksums.
The strongest category wins at each voxel; ties prefer the lower class ID.
Weights below 6/255 remain unknown, matching the previous 0.02 glow cutoff.
Class IDs are 1 buildings, 2 vegetation, 3 roads, 4 vehicles, 5 AC units, 0 unknown.
This preserves the source 512×512×64 volume packed into an 8×8 atlas.

Each `apps/web/public/semantics/SCENE-segments.json` retains source identity,
registered local bounds, input metadata/binary checksums, final counts, and the
packed binary checksum. The associated R8 atlas is 16 MiB per scene and loaded
only when enabled, then reused until the session closes. The viewer independently
validates metadata and binary integrity before enabling the appearance. Existing
registration evidence under `docs/splat-registration/` remains authoritative;
no registration or source geometry changes are introduced by these assets.

Tests cover all 12 packed atlas hashes and class counts, metadata mismatches,
normal appearance restoration, download retry, delayed enable cancellation,
and dashboard toggling without scene recreation or camera resets. NullGraphicsDevice
tests do not execute GPU shaders; WebGPU/WebGL visual confirmation remains manual.

## Dark vector basemap

Segmented view selects a dark cartographic basemap on both the registered ground
and globe; normal appearance restores Esri satellite imagery. The map checkbox
and attribution follow the selected style and preserve the user's visibility
choice. A failed classification load leaves the satellite style selected.

The basemap fetches actual MVT/PBF geometry from the
[Esri World Basemap vector service](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer),
using the endpoint documented in [Esri's custom basemap guide](https://developers.arcgis.com/documentation/mapping-and-location-services/mapping/basemaps/custom-basemap-styles/).
A small geometry-only decoder follows the [MVT 2.1 specification](https://github.com/mapbox/vector-tile-spec/tree/master/2.1).
Land, parks, water, building footprints and roads receive a restrained dark
palette. Labels and symbols are omitted to keep the holograms legible. Vector
geometry is drawn locally to 512 px canvases and uploaded to the existing
georeferenced ground/globe meshes; it does not create a second camera or map
canvas. Detail overzoom redraws source geometry into the precise geographic
subregion. The source endpoint is currently capped at zoom 16 with bounded parent
fallback. Unavailable data reports a map failure instead of reverting silently
to satellite imagery.

Decoded dark tiles have their own 64-tile cache (64 MiB); GPU residency is bounded
separately for each style. Switching cancels requests for the previous style,
removes its meshes and reuses cached resources when switching back. Late
responses cannot bind satellite tiles to the dark style. Registration, splat
streaming and camera position are unaffected.

Tests exercise MVT geometry/rings/holes, malformed input, feature styling, exact
parent cropping, aborts, asynchronous style isolation, cached restoration, ground
and globe switching, and dashboard labels/attribution. Live service access and GPU
visuals require a network-enabled browser; this execution environment cannot
resolve the tile service hostname.
