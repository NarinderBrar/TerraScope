# TerraScope 3D View Plan

## Goal

Add an optional 3D globe and terrain view to TerraScope while preserving its existing 2D WebGPU map and raster-analysis semantics. The 3D view should use the same selected scene or date pair, display settings, and vertical swipe divider. Users can orbit and zoom the globe, then enable terrain relief for an area of interest.

The first release is a globe with date-swipe comparison and coarse-to-fine imagery. Terrain is a later phase because it requires an elevation data source, an elevation tile format, and additional seam and memory handling.

## Product behavior

- A clear 2D / 3D mode control switches between the existing flat map and a 3D globe.
- The selected scene, comparison scene, layer, quality policy, and swipe position remain shared application state.
- The swipe line stays vertical in screen space. The shader selects Date A on one side and Date B on the other, including when the globe is rotated.
- Globe controls support orbit, pan, zoom, reset-to-north, and a return-to-2D action.
- The globe retains a coarse parent surface while higher-detail imagery loads.
- The initial implementation is usable without terrain data; terrain can be enabled as a separate display option once available.
- Unsupported regions, including areas outside TerraScope's current Web Mercator imagery coverage, are rendered with a clear fallback rather than invalid measurements.

## Existing TerraScope pieces to preserve

- React owns UI state; `MapScene` owns mutable camera, scheduling, GPU resources, and render loop.
- `RasterClient` requests calibrated numeric EOT1 imagery tiles.
- The current raster service resolves approved STAC items, reads COG windows with GDAL, calibrates reflectance, and serializes numeric bands and validity masks.
- `RasterRenderer` and its WGSL shaders implement natural colour, false colour, individual bands, NDVI, difference, and the 2D date swipe.
- Current camera and tile selection use XYZ Web Mercator coordinates. Imagery is limited by the service's supported zoom and Web Mercator latitude range.

The 3D renderer should consume the same numeric tile contract and analysis policy. It should not treat the JPEG basemap as analytical data.

## Proposed architecture

```text
React UI (mode, date pair, layer, swipe, terrain toggle)
                 │ shared settings and input events
                 ▼
          MapScene / scene controller
        ┌────────┴──────────────┐
        │                       │
   2D map path              3D view path
 existing camera            GlobeCamera
 and WebGPU map              │
        │               GlobeTileSelector
        │          frustum + horizon + screen error
        │                       │
        └────── RasterClient / visible tile scheduler
                                │
                       numeric date A / date B tiles
                                │
                     shared WebGPU device and shaders
                                │
                  globe meshes + raster/terrain pipeline
```

Keep the 3D path in separate modules (for example `apps/web/src/globe/`) instead of turning `MapScene` into a single large renderer. Add a small scene-mode interface so the UI can pass shared settings and subscribe to camera/status snapshots without owning GPU state.

### Tile hierarchy and selection

Start with a hierarchy that matches the current imagery source: XYZ Web Mercator tiles. Each node represents a geographic tile footprint and records its parent/children, bounds, imagery key, estimated screen-space error, and load state. A tile's footprint is tessellated into globe geometry using inverse Web Mercator for latitude; its numeric raster texture is sampled using the tile's UVs.

Each frame:

1. Update the globe camera and camera-relative transforms.
2. Traverse from a coarse root level.
3. Reject nodes outside the camera frustum or hidden behind the globe horizon.
4. Estimate projected tile error (in pixels) from tile resolution, camera distance, and viewport size.
5. Request children when error exceeds a target and the node can refine.
6. Draw the parent until the necessary child tiles are resident; then refine without exposing holes.
7. Prioritize visible tiles near the screen center and cancel or deprioritize requests made stale by camera movement.
8. Evict least-recently-used GPU resources within a fixed byte budget.

This borrows the useful streaming ideas from hierarchical 3D tile renderers, while keeping the imagery numeric and the rendering WebGPU-native. It does not require adopting the 3D Tiles content format.

### Globe geometry and precision

- Use a WGS84-compatible ellipsoid (or explicitly documented spherical approximation for the first visual prototype) to convert longitude/latitude/height to 3D positions.
- Keep camera and geographic calculations in JavaScript double precision. Send camera-relative positions to WGSL as float32 to avoid jitter at planetary scale.
- Generate tile meshes with enough subdivisions that the curved tile edges and interior match the globe. Add skirts or edge stitching to hide cracks between adjacent terrain levels.
- Keep a consistent winding order and handle antimeridian wrapping explicitly.
- Clamp/mark imagery outside the existing EPSG:3857 coverage (approximately ±85.05° latitude); do not silently imply full polar Sentinel coverage.

### Rendering and swipe comparison

- Extend the existing tile WGSL with a globe projection path, or add a dedicated globe shader sharing the current band-composition and analysis logic.
- Store numeric bands and masks in GPU resources as today; compute/display NDVI and difference under the same validity rules.
- Use one shared swipe parameter for 2D and 3D. Evaluate the divider against fragment screen coordinates, not globe longitude, so the divider remains fixed as the camera rotates.
- Keep Date A and Date B registered to identical globe geometry and tile footprint. If a date tile is missing, use the existing explicit missing/loading state and avoid blending invalid pixels as valid measurements.
- Make mode changes preserve selected scenes, visualization settings, and comparison state. Define whether camera state is remembered independently per mode.

### Terrain extension

Terrain needs a source and access path independent of Sentinel imagery. Before implementation, select a DEM source and verify license, attribution, resolution, vertical datum, no-data behavior, availability, and whether redistribution/caching is allowed.

Introduce an `ElevationProvider` interface that returns elevation tiles plus their bounds, resolution, datum, and validity mask. The terrain mesh uses the same geographic footprint as the imagery tile, with height samples displacing the ellipsoid surface. Cache elevation separately from imagery because their source, resolution, and update lifecycle differ.

Terrain-specific requirements:

- Support parent elevation while finer samples load.
- Add skirts or neighbor stitching to avoid cracks where levels differ.
- Keep the terrain LOD selector independent from imagery LOD, while allowing both to share a geographic node footprint where practical.
- Document vertical exaggeration and vertical datum in UI or metadata.
- Keep the flat globe as a valid fallback when elevation is missing.

## Delivery phases

### Phase 0 — Design validation

- Decide initial globe shape (sphere prototype versus WGS84 ellipsoid), tile hierarchy, supported latitude range, and camera interaction model.
- Specify the camera-to-tile screen-error calculation and memory accounting.
- Confirm the 3D renderer can reuse the existing WebGPU device/context and does not create a second canvas renderer.
- Choose representative scenes and date pairs for visual checks, including antimeridian and high-latitude areas.
- Record open decisions below before expanding scope.

### Phase 1 — Globe rendering prototype

- Add a 3D mode with a single coarse imagery level and generated globe mesh.
- Upload an existing EOT1 tile and render RGB, NDVI, masks, and missing-data state on the globe.
- Add orbit, zoom, reset view, and mode switching.
- Verify camera-relative precision and screen-space divider behavior.

Exit criteria: globe can be rotated and zoomed; imagery follows the surface; a scene pair displays opposite sides of the vertical swipe; NDVI and mask behavior match the 2D path for sampled pixels.

### Phase 2 — Hierarchical globe imagery

- Implement visible-tile traversal, frustum/horizon rejection, screen-space error, prioritized requests, stale-request cancellation, parent fallback, and LRU GPU eviction.
- Load both comparison dates with aligned footprints.
- Add globe render stats for visible, requested, resident, failed, and evicted tiles plus estimated GPU bytes.
- Add robust antimeridian handling and polar-edge behavior.

Exit criteria: fast orbit/zoom does not leave permanent holes, resource use remains within a configured budget, and both dates refine coherently.

### Phase 3 — Terrain data and mesh

- Select and document a suitable DEM provider and license.
- Implement elevation request, decoding, caching, and provenance separately from EOT1 imagery.
- Displace globe tile vertices and add crack mitigation across tile-level boundaries.
- Add terrain on/off and vertical exaggeration controls.

Exit criteria: DEM values and vertical datum are traceable; neighboring tiles do not show visible gaps under normal camera motion; imagery remains aligned with elevation.

### Phase 4 — Product integration and hardening

- Integrate shared scene selection, compare controls, share-link state, accessibility, and responsive layout.
- Add device-loss recovery and a clear unsupported-WebGPU state consistent with TerraScope.
- Tune tile concurrency, cache budget, shader cost, and startup/refinement behavior on representative hardware.
- Update architecture and deployment documentation.

## Performance and reliability requirements

- Tile work is bounded by explicit request concurrency, per-frame traversal/draw guards, and GPU-memory budgets.
- Retain coarse parents until required children are uploaded, preventing blank globe patches during refinement.
- Camera movement must not trigger duplicate in-flight requests for the same scene/date/tile key.
- Failed requests have bounded retry/backoff and are visible in diagnostics.
- CPU decoding and mesh generation should be profiled; move expensive decoding/geometry generation to workers only when measurement justifies it.
- Expose GPU memory estimates and tile counts so cache pressure is observable.
- Date A and Date B use a shared geometry footprint and share elevation resources.

## Validation strategy

- Unit-check geographic tile bounds, XYZ-to-geographic conversion, ellipsoid position conversion, UV orientation, antimeridian wrapping, horizon visibility, and SSE/refinement thresholds.
- Compare known pixel values and NDVI output between 2D and 3D for the same EOT1 tile and scene pair.
- Visually inspect parent-to-child transitions, swipe alignment, masks, polar boundaries, and tile seams.
- Exercise rapid orbit/zoom, date changes during in-flight requests, cache pressure, missing tiles, and GPU device loss.
- Measure frame time, first-visible-tile time, refinement time, bytes downloaded, and resident GPU bytes on representative desktop and integrated GPUs.

These are proposed checks for implementation; this planning change does not run or add tests.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing XYZ imagery is Web Mercator and does not cover the poles | Make coverage explicit; show a no-data/fallback cap; consider a polar-cap source only as a later provider extension |
| Globe and terrain precision causes jitter | Double-precision CPU transforms and camera-relative float32 GPU coordinates |
| Adjacent tiles at different LOD crack | Parent fallback, skirts or stitching, and neighbor-aware refinement |
| Two dates exceed memory budget | Share geometry/elevation, use measured byte accounting, evict by LRU, and cap comparison residency |
| Existing 2D interaction model does not translate to orbit controls | Separate 3D camera/input controller while keeping scene and visualization state shared |
| DEM license, datum, or coverage is unsuitable | Decide provider before terrain milestone; preserve flat-globe mode |
| Reprojecting Web Mercator tile rows onto a globe causes visible distortion | Use sufficient mesh subdivision and test high latitudes; later consider a geographic/cube-sphere raster endpoint if needed |

## Open decisions

1. Should the first user-facing 3D mode be a flat textured globe, or should terrain relief be required for initial release?
2. Which DEM provider is permitted for the intended use and caching model?
3. Should the globe tile hierarchy stay in XYZ Web Mercator initially, or should the raster service add a globe-native tiling scheme for the long term?
4. What GPU memory budget and target hardware should govern simultaneous residency of two dates?
5. Should 3D camera position/orientation be included in share links?

## References

- TerraScope renderer and service: `docs/ARCHITECTURE.md`, `apps/web/src/app/MapScene.ts`, `apps/web/src/gpu/RasterRenderer.ts`, `apps/web/src/map/MapCamera.ts`, and `services/raster/app/api/routes.py`.
- NASA-AMMOS 3DTilesRendererJS concepts: [repository and documentation](https://github.com/NASA-AMMOS/3DTilesRendererJS). Use its hierarchical traversal, screen-space error, asynchronous loading, parent fallback, and cache behavior as design references; the proposed implementation remains WebGPU-native and TerraScope-specific.
