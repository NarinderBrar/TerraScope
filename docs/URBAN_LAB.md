# Urban Lab

Open any registered Gaussian splat scene, then choose **Urban Lab** in the 3D
toolbar. Loading urban data is opt-in and independent of splat streaming. Close
the lab to clear the overlays; returning to the map cancels pending requests.

## Features

- OSM building wireframes, mapped trees, bus stops, crossings and traffic signals.
  Choose a mapped feature to inspect its tags and highlight its location.
- Capacity-coloured road segments and animated traffic particles, with pause.
- Date and local solar-hour controls, pedestrian shade samples and mapped crown
  cover, including before/proposed comparisons.
- Road closure with alternative routing, assumed signal-capacity improvement,
  one reserved bus lane with an assumed mode shift, and proposed mature trees.
- JSON export of scenario inputs, mapped features, registration, assumptions and
  comparison metrics.

## Registration and data

`apps/web/src/urban/osm.ts` requests the selected scene's bounds from the public
Overpass API and caches successful responses in memory for this browser session.
Failures are visible and retryable; partial Overpass responses are rejected.
Requests time out after 45 seconds and are cancelled when leaving the lab.
No synthetic map data replaces a failed request. OSM attribution and individual
feature source links are provided in the panel and exported report.

Every geographic vertex uses `geographicToModel` and the existing measured
scene reference. Rendering uses the **same model root** as the splats and ground
map, including its Z-up rotation and measured street datum (20 cm below the median
source-SOG street patches; see `docs/SPLAT_GEOREGISTRATION.md`). Road lines and
particles use small metre-based clearances rather than model-unit lifts. Calculation
coordinates use the reference's affine transform and latitude correction to
convert model units to ground metres and true east/north. No scene registrations
or selection eligibility are changed by this feature.

Analysis outlines render through the splat for readability. They are schematic
overlays, not measurements extracted from reconstructed appearance. A flat
registered ground plane is assumed; slopes and elevated-road heights are not
reconstructed. Feature/imagery dates and mapping coverage can differ.

## Traffic model

The TypeScript model in `urban/model.ts` is a screening model inspired by the
local StreetScope workflow. It is not a vehicle microsimulator. Driving OSM ways
are joined at shared coordinates and layer values; mapped one-way direction and
access exclusions are respected. Lengths use ground metres. Tagged lanes and
speed limits are used when parseable (including mph); otherwise road-class
defaults apply. Total bidirectional capacity uses 1,500 vehicles/h/lane on major
roads and 900 on other roads, with assumed junction friction. There are no
observed traffic counts, signal phases, turning restrictions or bus schedules.

The demand slider specifies assumed car trips per hour. Up to 32 deterministic
origin/destination pairs are distributed across graph nodes. Four incremental
assignments route a quarter of the demand using shortest paths and the BPR
delay curve `t = t0 × (1 + 0.15 × (volume/capacity)^4)`. This assumes spatially
distributed demand rather than estimating actual travel patterns. Both travel
directions contribute to total road capacity. Reported delay is vehicle-hours
per modelled hour; peak load is the maximum segment volume/capacity ratio.
Unroutable demand is explicitly reported, including baseline disconnected
components. Lower delay after a closure is not a benefit if trips became
unroutable. Particle density/speed illustrates segment results; particle counts
are not simulated vehicle counts or trajectories.

Scenario assumptions are explicit:

| Scenario | Change |
| --- | --- |
| Diversion | Set the target OSM way's capacity to zero and route the same demand through alternatives. |
| Signals | Increase the target way's assumed capacity by 15%. This does not simulate signal cycles. |
| Bus lane | Reserve one lane on the target way and reduce network car demand by an assumed 20%. Bus operations are outside the model. |
| Trees | Add up to 80 proposed mature crowns, at least 15 m apart along sampled pedestrian corridors, avoiding existing mapped crowns and mapped buildings. |

Before/proposed always share demand, date and hour. Results are conditional
scenario estimates; they require traffic counts and calibration for forecasting.

## Sun, shade and canopy

Solar altitude/azimuth use latitude, seasonal declination and **local solar
time**, not civil clock time. A 1.5 m pedestrian ray intersects building
extrusions and spherical tree crowns. Building heights use tagged metres, then
3 m per tagged level, then 9 m. Tree height defaults to 8 m; crowns assume a
3 m radius. Proposed trees use mature 8 m height / 3 m crown radius.

Pedestrian locations are sampled about every 15 m on mapped paths or on both
sides of roads at mapped/assumed half-width plus 1.5 m. They exclude mapped
building interiors and are bounded to the selected geographic footprint. Work
is capped at roughly 900 samples. Planting candidates are schematic and need
utility, access and land-ownership checks. Before/proposed use identical sample
locations. Shade is unavailable at night or where there are no samples. Crown
cover is estimated with a 100 × 100 grid over the geographic bounds and includes
only mapped/proposed crowns; unmapped trees are not inferred from splat colours.
No temperature, thermal comfort or measured heat prediction is made.

## Verification

`npm run typecheck`, `npm test`, `npm run build`.

`urbanModel.test.ts` covers closure rerouting, unroutable trips, one-way direction,
congestion response, bus-lane assumptions, mph conversion, shadow direction and
tree intersection, solar position, planting comparison, and rotated/scaled
geographic registration. `urbanPanel.test.ts` covers scenario updates, playback,
cleanup, cancellation, fetch failures and retry.
`urbanOverlay.test.ts` verifies that rendering uses the registered rotated root,
particle playback pauses, and disabling the lab removes its drawing calls.
