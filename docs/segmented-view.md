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
