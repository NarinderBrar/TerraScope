# Skyfall scene registration

The integration plan's bounding boxes were placeholders. JAX_068 depicts the
UF Health campus north of downtown Jacksonville, not the downtown riverfront.
NYC_004 depicts the World Financial Center/Brookfield Place waterfront.
The [official scene gallery](https://skyfall-gs.jayinnn.dev/) identifies the latter.

The published [training dataset](https://huggingface.co/datasets/jayinnn/Skyfall-GS-datasets)
provides local cameras but omits `enu_observer_latlonalt.json` for JAX and a
geographic transform for the synthetic NYC scene. A geographic origin cannot
be recovered from camera matrices alone.

JAX_004 (Residential) and NYC_010 (Union Square) are also registered against cached
World Imagery tiles and enabled on the map. The Jacksonville City Hall (JAX_164),
Stadium (JAX_175), Office Building (JAX_214) and Lake Side (JAX_260) scenes are
also measured and enabled, bringing the total to eight. Their 24/58/35/41 fitted
and 7/15/9/11 withheld feature pairs have maximum withheld residuals of
2.29/2.87/3.00/3.13 metres respectively. Per-scene ground samples and conservative
coverage bounds are retained with those pairs. Every selectable scene must have
measured/recovered registration; standalone 3D previews are not supported.

The final Villa (JAX_168), Factory (JAX_264), E 12th St. (NYC_219) and Albany St.
(NYC_336) batch is also registered, completing all twelve published models. Their
80/56/68/15 fitted and 21/15/17/4 withheld pairs have maximum withheld residuals
of 2.54/2.18/2.25/1.32 metres. E 12th St. uses overlapping, already cached Union
Square imagery; its own measured transform and reference-reuse provenance are
retained in its evidence. Albany St.'s conservative footprint excludes sparse
river water. These are visual registrations, rather than surveyed positions.

## Measured registration

Registered decoded SOG point positions against geographic aerial imagery from
[Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer).
The explorer and 3D viewer share the World Imagery tile URL and attribution in
`src/map/worldImagery.ts`. Explorer zoom reaches level 20, with Esri reference
labels and coarse imagery underneath unavailable detail. Numeric Sentinel-2
tiles remain capped at level 14 even when the camera zooms closer.
No reference tiles are stored in the repository. The 3D ground uses a camera-driven
imagery quadtree up to zoom 20, rather than one fixed mosaic. Frustum culling and
projected tile size choose at most 128 nonoverlapping visible patches. Nearby
ground receives finer imagery than the horizon. All tile corners use the fixed
registration, independently of the model's footprint or current camera coverage.
A world overview and coarser parents remain available while detail loads; child
meshes crop the exact UV region of their best available ancestor without layering
coplanar meshes. Missing service detail also falls back up to three parent levels.
The loader uses six concurrent requests, cancels obsolete work, retries failures
with backoff, and retains at most 256 textures of 256 × 256 pixels (about 85 MiB
of uncompressed GPU imagery including mipmaps), with up to 16× anisotropic filtering.
Hiding the map stops requests; leaving the scene destroys its meshes and textures.
The ground remains a registered flat imagery plane, without terrain elevation.

A one-unit-per-pixel, Z-buffered top-down model projection, centered at local
(0,0), was matched to zoom-18 reference tiles. Manually identified landmarks
initialized a constrained SIFT/RANSAC similarity fit. Inspected overlays for
campus roads, pond, buildings and the NYC waterfront. The retained matched
feature coordinates, tile origins and raster transforms are recorded in
[splat-registration](./splat-registration/). Multiple features may belong to
one structure; these are fit residuals, not independent survey accuracy.

| Scene | Retained feature pairs | Median / max fit residual | Ground metres per model unit | Rotation from east |
| --- | ---: | ---: | ---: | ---: |
| JAX_068 | 33 | 2.44 / 3.77 m | 1.00255 | -0.02104° |
| NYC_004 | 18 | 1.73 / 4.05 m | 0.90368 | -1.74028° |
| JAX_004 | 41 | 1.21 / 2.80 m | 1.00242 | -0.03364° |
| NYC_010 | 39 | 0.94 / 2.24 m | 0.99353 | -0.01454° |

For the two new scenes, decoded the actual SOGs to PLY and projected their
opaque point centers into the same local raster. Landmark seeds initialized
spatially constrained SIFT matching; RANSAC rejected inconsistent matches.
Deduplicated matched features, held out every fifth feature in X-sorted order,
and refitted a similarity transform using only the remaining pairs. Held-out
residuals are 1.20 m median / 3.25 m maximum for JAX_004 (11 features), and
1.19 m / 1.91 m for NYC_010 (10 features). These are registration checks, not
independent surveyed accuracy; some features can belong to the same structure.
Inspected overlays across residential roads, ponds, Union Square and surrounding
blocks. Evidence JSONs include the fitted and held-out pairs, actual source-SOG
hash, final geographic transform, footprint and sampled local street heights.

`src/data/splatGeoreference.ts` converts between model XY and EPSG:3857.
Each scene stores a fixed origin and 2×2 transform, including Mercator scale.
Coverage bounds only choose map tiles: they never set model scale or position.
The local Z ground planes are 14 (JAX_068), -45 (NYC_004), 21 (JAX_004)
and -40 (NYC_010), just below reconstructed streets instead of below the
deepest noisy splat. The model and map share the
same Z-up to Y-up root rotation.

Scene selection bounds and city shortcut centers use the registered footprints.
Tests check fitted and held-out reference feature pairs, rotated coordinate frames, tile-edge
placement and invariance when map coverage changes.

This is visual imagery registration, not survey accuracy. Imagery acquisition dates, roof parallax,
reconstruction distortions and terrain height variation can leave local seams.
Do not replace these fixed transforms with model-AABB fitting. Future scenes
need their own ENU origin or measured registration before displaying a map.

## Entering from the map

Switching captures the live map viewport bounds, independently of any marked
selection. The viewer starts with a north-up perspective camera directly above
the registered ground plane, at the same geographic center and visible extent.
Mercator-space midpoint, scale and registration rotation preserve all four map
ground-plane edges. Camera altitude is half the visible ground height divided
by tan(vertical FOV / 2). Perspective is used throughout, so tilting introduces
natural foreshortening and depth without switching projections. Roofs above the
ground plane show normal perspective parallax. Reset restores this entry view.
Orbit, pan and zoom remain available.
Ground tile coverage follows the camera as it pans, tilts or zooms beyond the
entry viewport. Regional zoom-out adjusts the camera clipping planes with distance.
The 2D map stays visible while the model and imagery load; the first completed
3D frame fades in over 320 ms (disabled for reduced-motion preferences).

## Progressive LOD continuity

All three streamed levels retain the same registered model frame and scene
transform. Refinement never changes the geographic origin, scale, rotation,
ground plane, footprint or camera framing. Fine-chunk/source position comparisons
are recorded in each streamed scene's `alignment.json`; see
[the streaming workflow](SPLAT_STREAMING.md).
