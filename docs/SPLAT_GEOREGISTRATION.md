# Skyfall scene registration

The integration plan's bounding boxes were placeholders. JAX_068 depicts the
UF Health campus north of downtown Jacksonville, not the downtown riverfront.
NYC_004 depicts the World Financial Center/Brookfield Place waterfront.
The [official scene gallery](https://skyfall-gs.jayinnn.dev/) identifies the latter.

The published [training dataset](https://huggingface.co/datasets/jayinnn/Skyfall-GS-datasets)
provides local cameras but omits `enu_observer_latlonalt.json` for JAX and a
geographic transform for the synthetic NYC scene. A geographic origin cannot
be recovered from camera matrices alone.

## Measured registration

Registered decoded SOG point positions against geographic aerial imagery from
[Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer).
The viewer now requests detailed World Imagery tiles directly with imagery attribution.
No reference tiles are stored in the repository. Ground mosaics use up to zoom 18,
bounded by a 4096-pixel or smaller device texture limit, with up to 16× anisotropic
filtering to preserve detail at shallow camera angles.

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

`src/data/splatGeoreference.ts` converts between model XY and EPSG:3857.
Each scene stores a fixed origin and 2×2 transform, including Mercator scale.
Coverage bounds only choose map tiles: they never set model scale or position.
The local Z ground planes are 14 (JAX) and -45 (NYC), just below reconstructed
streets instead of below the deepest noisy splat. The model and map share the
same Z-up to Y-up root rotation.

Scene selection bounds and city shortcut centers use the registered footprints.
Tests check real reference feature pairs, rotated coordinate frames, tile-edge
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
Ground tile coverage includes the entry viewport, within the GPU texture budget.
The 2D map stays visible while the model and imagery load; the first completed
3D frame fades in over 320 ms (disabled for reduced-motion preferences).
