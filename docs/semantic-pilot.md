# Union Square semantic pilot

## Coverage refinement and holographic buildings

The nine reported scenes (all eight JAX scenes and NYC_004) now have a second
export pass. `LangSplat/scripts/semantic_refinement.py` uses their original full
512-D SAM/CLIP features with building/house/roof/stadium/seating and
vegetation/tree/grass/shrub prompts. Roads, parking, bridges, pavement, boats,
water, ponds and bare ground compete as background. Multi-level mask scores
project through the measured cameras onto visible original Gaussian centres,
with a depth test and multi-view median/upper-quartile fusion. Colour supports
plausible vegetation and short similar-colour gaps near an existing mask.
Uncertain latent fallback is capped below the activation ramp. This is a hybrid
correction using LangSplat image features, not a new validated semantic model.

The previous street-height gate is removed for these fields: vegetation includes
low grass and varying terrain, and the building category includes lower facades.
The spatial grid increases from 256x256x64 to 512x512x64, packed into a 4096-square
R8 atlas (16 MiB per category). Existing 2k atlases remain supported. Original
geometry and measured geographic placement stay fixed. Old fields are backed up
under `LangSplat/output/semantic_refinement_v2/previous_exports/`.

JAX_175 also has an explicit assistant-reviewed source-image outline for the
whole stadium facility, implementing the user's requested building coverage.
The annotation and its source image checksum are retained in
`LangSplat/validation/semantic_refinement_v2/JAX_175-stadium.json`. This is a review
correction, not a claim that LangSplat automatically learned a complete stadium.

Pressing **Start glow** with **Buildings** selected applies a blue holographic
body with luminous cyan grid lines (4 m XY, 3 m vertical), staggered vertical
light trails, fine horizontal stripes, and a moving scan band with a bright core.
The matched body darkens slightly to distinguish the luminous lines against
bright satellite colours. These are shader colours
on original splats, not a reconstructed triangle wireframe or mesh-edge outline.
Vegetation uses the same holographic treatment with emerald/mint light and a
finer grid (2 m XY, 1.5 m vertical) to suit trees and low planting.
Both categories pulse between 30% and 50% so the dim
phase remains visible; reduced-motion mode keeps the scan and trails static.
The scan and pulse update at most 10 Hz; static reduced-motion parameters are not
repeatedly dirtied. Live GPU appearance needs host-browser review.

The lightweight 512 px/16-point-grid SAM pass missed some small areas entirely.
A finer pipeline is prepared for the same nine scenes: up to 24 source images at
1024 px, a 32-point SAM grid, one crop layer, bounded SAM/CLIP batches and CPU
offloading. Run on the GPU-enabled host from OrbitWorks:

```bash
env -u PYTHONPATH .venv-langsplat/bin/python -u LangSplat/scripts/refine_requested_scenes.py
```

Before the full batch, run the same command with
`--smoke-test --scenes JAX_068` to check one image. The runner now uses compressed
SAM masks, packed preview filtering and streamed CLIP crop batches to address
system-RAM SIGKILLs. It prints image progress and peak memory and stops the batch
on SIGKILL. See `LangSplat/PILOT.md` for recovery details and verification limits.

This extracts richer masks and re-exports full-dimensional corrections while
retaining the trained 3D checkpoint. It does not need another geometry fit.
`--current-features` reruns CPU corrections on the earlier masks; `--prepare-only`
prepares the finer images/cameras without a GPU. A quality report and stage logs
record completion or failures; failed extraction leaves the existing scene
exports available. Source-image overlays and sampled-field comparisons are under
`LangSplat/output/semantic_refinement_v2/`. Their coverage changes are diagnostics
on correction inputs, not held-out semantic accuracy. Misses and false matches
remain possible, particularly where the original masks contain no object.

## Original trained baseline

## Extending training to all registered scenes

`LangSplat/scripts/train_pending_scenes.py` prepares and trains pending scenes
sequentially with the pilot's 6 GB recipe. It retains original Gaussian
coordinates, rectifies off-centre JAX images with rotation-only camera
homographies, fits a scene-specific autoencoder and language model, renders
previews, and exports both category fields. See `LangSplat/PILOT.md` for the
host command, stage logs, resume behavior and limitations.

The viewer discovers both category metadata files when opening each scene.
Controls enable only when both match that scene's registered source hash.
`src/data/splatSourceHashes.json` mirrors the registered SOG manifest and is
checked against it in tests. Reopen the scene after export to discover new
features. All 12 registered scenes now have completed language training and both category
exports. The two legacy-schema export failures (JAX_068 and NYC_004) were repaired
using their measured nested vertical calibration; no retraining was needed.
Training completion does not certify semantic accuracy.

## Current viewer: LangSplat category glow and height reveal

The toolbar exposes a **Glow target** dropdown (Buildings / Vegetation) and
**Start glow** / **Stop glow** for every scene with matching published exports. Coverage is fixed at the former
maximum setting; there is no coverage slider. The shader cutoff is 0.02.
The original full-detail streamed splats stay active. A work-buffer shader changes
only RGB at centers supported by the selected LangSplat category evidence, leaving
geometry, final opacity, camera and geographic registration unchanged. No OSM labels or outlines
are used by this effect. Other scenes have a disabled button until trained.

`LangSplat/scripts/export_building_glow.py` decodes the repaired level-0 features
using the fitted autoencoder and local CLIP text encoder. It builds a 256x256x64
relevance volume from opaque, observed Gaussians, comparing building relevance
with tree and road queries. Continuous score/margin ramps retain weaker evidence;
neighborhood support and spatial smoothing suppress isolated fragments. The
continuous field retains weaker matches for the fixed maximum-coverage cutoff.
Maximum coverage is a display setting, not a measured fraction of buildings or
classifier accuracy. This replaced strict export gates that highlighted too few
buildings in the host screenshot. Vegetation uses the learned “trees” query
against building/road alternatives; it is not a separately trained vegetation
classifier. Export with `--category vegetation` to reproduce its independent atlas.
Points within two measured ground metres of the representative street datum are
excluded for buildings; vegetation uses a 0.2 m clearance. These heuristics
can miss lower facades and weakly represented buildings; they do not establish
improved classification accuracy.

The R8 volume is packed into a 2048x2048 atlas. The shader transforms WORLD centers
back through the actual registered model-root inverse, then interpolates this
evidence at full-detail splat centers. This is approximate spatial transfer from
the reduced pilot, not a per-Gaussian ID mapping. Orange building or green
vegetation additive tint pulses over 1.8 seconds, capped at 50% peak strength,
without replacing the original texture appearance. This is a color
glow/tint, not a postprocessing bloom halo. Reduced-motion users get a steady
highlight. Updates are capped to 10 Hz to avoid invalidating the complete city
work buffer on every display frame. Disabling restores original shader behavior;
the feature texture is cached until viewer disposal.

Only the selected category is emphasized; there is no alternate class-colored
PLY in this viewer flow. Each category atlas loads lazily and is reused when
switching back. Metadata and binary evidence are under
`apps/web/public/semantics/NYC_010-{building,vegetation}-glow.*`; lineage is retained
in corresponding files under `docs/splat-registration/`. Binary checksum, source hash,
coordinate frame and atlas dimensions are validated on load. The underlying
building queries failed the earlier small validation screen, so matches remain
experimental and can be incorrect or incomplete. Real-GPU shader compilation
and interactive visual review remain to be performed on the host browser.

All scenes reveal their splats from bottom to top over 2.4 seconds, starting
after the first coarse tiles are ready. A shared shader softly gates alpha by
original model-local Z and the actual asset height bounds; it never moves or
rescales points. Revealing stops after the top is fully visible and normal
streaming refinement continues. This is a visibility animation, not a promise
that network requests download in vertical order. Glow and reveal share one
work-buffer modifier so category changes and stopping glow do not interrupt
the scene reveal. Reduced-motion users get immediate visibility and steady glow.

## Earlier OSM outline experiment

An earlier toolbar exposed **Highlight buildings** / **Hide building highlights**
over the original full-detail splats. The class-colored replacement and separate
tree button were removed from the viewer after host screenshots showed noisy
Gaussian-level coloring. Those experimental assets and utilities remain for
offline diagnosis; the sections below document that earlier pilot.

That highlight used **OSM mapped building outlines**, not LangSplat
segmentation. Only valid closed building footprints are drawn, under the same
registered model root as the splats. Other feature types are excluded. Roof
outlines and vertical edges are added where OSM supplies a height or building
levels (levels use the existing approximate 3 m conversion). Otherwise only the
footprint is drawn, without inventing a generic building height. Lines show
through the splats intentionally as a schematic annotation. Full-detail splats,
camera and map stay active throughout; no replacement PLY is loaded.

That control was available on all existing registered scenes using OSM data, not
restricted to the trained NYC_010 pilot. Requests run on demand, reuse Urban
Lab's data cache, support retries and abort on viewer disposal. Missing OSM
buildings, registration residuals and estimated heights can still affect
placement; this is not pixel-accurate recoloring of reconstructed facades.
Interactive browser verification of the new outline presentation is pending.

## Earlier language-feature experiments

NYC_010 now has an opt-in **Find trees · experimental** control in its registered
splat viewer. Green crosses mark original Gaussian centers with high text
relevance to “trees”. They are vegetation candidates, not individual trees or
an inventory. The full-detail streamed splats and geographic transform are
unchanged. Other scenes do not expose this control.

## Validation performed

The source images have 27 conservative reference patches: three each for
buildings, roads and trees in one training view and two camera holdouts.
Labels were interpreted visually by the agent after viewing model previews.
This is a retrospective diagnostic, not a blinded benchmark. Positive tree
patches are in Union Square's park; they do not establish accuracy for street
trees or other vegetation types. Patches are partial, spatially correlated and
not a representative sample of the city.

Per-class thresholds maximize balanced accuracy on labelled, observed pixels
in training frame 0005 only. Thresholds are frozen for frames 0000 and 0040.
Unknown positive pixels reduce end-to-end recall; unknown negative pixels do
not count as correctly classified negatives. The exploratory screen requires
precision at least 0.85, recall at least 0.70 and positive coverage at least 0.80
on each holdout. Buildings and roads failed for all three mask levels.

The default-level tree score passed this small screen with precision 0.998 /
0.954 and recall 0.987 / 0.982 on the two holdouts. The fine and medium tree
scores also passed, but default had the highest minimum holdout precision.
Choosing between levels using these holdouts makes them a model-selection set,
not an untouched final test. The autoencoder saw all 12 views.

## Export and placement

`LangSplat/scripts/export_tree_candidates.py` selects that default checkpoint,
checks its geometry and appearance against the registered RGB initializer, and
checks the original SOG hash against registration evidence. It decodes point
features on CPU with the local CLIP model and trained autoencoder. Export is
capped at 1,200 centers, one per 5 ground-metre horizontal cell, preserving the
chosen center's original XYZ. The scene's existing model root rotates these
points with the splats. There is no added vertical offset or guessed transform.

The image-derived cutoff (about 0.542) is a heuristic when applied to individual
Gaussian features. Rendered features include opacity blending; image-patch
validation does **not** validate per-point labels. The overlay explicitly says
matches can be incorrect or missing and markers are not a tree count. It does
not affect traffic, road capacity, shade, tree-coverage estimates or scenarios.
OSM remains the source of contextual roads and buildings in Urban Lab.

Provenance and retained source indices are in
`docs/splat-registration/NYC_010-semantics.json`. Marker data are in
`apps/web/public/semantics/NYC_010-trees.json`. The validation report, source-only
annotation overlays and camera-projected marker preview are under
`LangSplat/output/mask_comparison_v1/validation/` in the shared workspace.

CPU projection into holdout frame 0040 was visually inspected: candidates
cluster over park canopy and other vegetation, with some uncertain matches.
Tests check the exact registered root transform and original point heights,
lazy loading, payload rejection, toggling, retry and abort behavior. Typecheck,
web tests and production build pass. Interactive browser/map placement still
requires host review; this is an experimental overlay, not a completed
validation of semantic integration.

## Reproduce

From the OrbitWorks workspace root:

```bash
env -u PYTHONPATH .venv-langsplat/bin/python LangSplat/scripts/validate_pilot_regions.py
env -u PYTHONPATH .venv-langsplat/bin/python LangSplat/scripts/export_tree_candidates.py
```

Next validation should use independently reviewed full-object regions, more
negative classes (grass, shrubs, shadows, roofs, paved plazas), and another
camera/scene kept separate from model selection before hard labels or tree
counts are enabled.

## Normal / segmented appearance toggle

The 3D toolbar also offers **Segmented view**, which switches to a class-colored
Gaussian asset; the same button restores **Normal splat view**. Only NYC_010 is
enabled. Other scenes display a disabled control with a Union Square availability
note. Assets are loaded on demand and reused on subsequent toggles. The normal
model stays visible until segmented loading succeeds and remains available on
errors. Camera, ground map, geographic registration and entry framing are shared.

`LangSplat/scripts/export_segmented_splats.py` produces a binary PLY from the
192,722-Gaussian initializer. XYZ, rotations, scales and opacities are preserved
exactly; only appearance is replaced with degree-zero class colors. Orange is
building-like, blue road-like, green tree-like and gray uncertain. The strongest
query must score at least 0.35 and exceed the runner-up by 0.03. Those are
visualization heuristics, not validated segmentation thresholds. Missing feature
vectors remain gray. No object-instance IDs or object names are inferred.

The result contains 96,047 building-like, 72 road-like, 6,475 tree-like and 90,128
uncertain Gaussians. These are Gaussian counts, not object counts; especially the
tiny road-like set reflects weak road queries. The in-view legend explicitly
warns that building and road predictions are unreliable. This experimental mode
does not override the earlier decision to keep hard semantic labels out of the
analysis models. Normal mode retains the original full-detail streamed splats;
segmented mode uses the reduced-detail pilot, so appearance sharpness may differ.

The generated asset and metadata are in `apps/web/public/semantics/`, with
registration lineage and geometry checks retained in
`docs/splat-registration/NYC_010-segmented.json`. A test loads the actual exported
PLY through the native PlayCanvas parser and attaches it as a unified splat
component under the registered root using a null graphics device. This checks
resource compatibility and switching, not real-GPU rendering. Interactive
browser visual verification remains outstanding.
