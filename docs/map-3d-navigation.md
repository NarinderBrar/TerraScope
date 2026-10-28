# Map and 3D navigation

The map fills the window and starts in continuous 3D navigation, initially
looking straight down at the geographic view. One right-hand panel contains
place search, the scene picker and footprint visibility. Both 2D/3D switches
have been removed. Mark Area, the
Shift-drag hint, the separate globe button, satellite comparison tools and the
Switch to 3D Urban View prompt are removed from the current explorer UI. Legacy
analysis helpers remain in source but are not mounted by App.

Drag to pan, right- or middle-drag to orbit, and scroll to zoom. No manual mode selection
is required. Search results recenter the continuous map. Escape does not switch
the map into a different renderer. A camera snapshot tracks the live surface
intersection and equivalent Mercator scale. Back to Map returns from a registered
splat scene with its current center, scale, tilt and heading; the old scene stays
visible until the map has rendered. The internal 2D canvas remains hidden and
inert as a geographic-state service, without a second basemap tile layer.
Panning changes a geographic surface anchor in a floating local frame; it does
not translate the camera pivot sideways. At globe scale, ray/sphere trackball
motion rotates the surface while the sphere's center remains fixed. The ground
reference, footprint lines and registered splat root follow the geographic frame
without modifying the recorded registrations or re-downloading cached tiles.
Orbiting changes heading around the anchored surface normal. Near the ground,
tilt ranges from nadir to 85 degrees. Beyond 30 km, both the tilt limit and
vertical gesture sensitivity progressively decrease; at 2,000 km and beyond,
the tilt limit is one degree. The globe therefore stays almost centered during
far-view orbit gestures. Focus latitude follows the supported Mercator range.
All splat controls, including the
scene title, reset, glow and Urban Lab, are docked in a right-side panel.

Local 3D uses a flat satellite surface with no terrain elevation. Zooming out
crossfades this surface into a spherical Earth over a camera-distance band of
150–800 km. Both surfaces share the same PlayCanvas camera; there is no renderer
or location reset. At larger distances the focal point eases toward Earth's
center. This path also applies to registered splat viewers; their measured
Mercator scale, rotation and ground datum place the Earth tangent frame.
Zoom limits are expanded for these 3D cameras without resetting camera state.
The Earth starts with a coarse overview, then refines visible patches according
to projected texel size and camera distance, under a 196-patch budget and a
256-texture residency limit. Six requests run concurrently; decoded imagery is
shared with the ground layer. Imagery is prefetched once the camera is about
30 km away. Lower-resolution textures remain as cropped fallbacks until finer
tiles load. Parent and child meshes never overlap. Tile-edge skirts close
mixed-detail seams, and the dark background sphere is recessed below all coarse
patches. Fully visible imagery uses opaque, front-facing depth-tested rendering
instead of transparent sorting; transparency is used only during the crossfade.
While the globe is visible, clipping is fitted every frame to the camera's
distance above the sphere, including the registered scene's unit scale. The
near plane is one quarter of the sphere clearance. This keeps the surface and
underlay distinct in the depth buffer at far zoom; the city-scale near plane
previously quantized both to the same depth. City clipping is restored when
the globe fades out, including when tile selection is throttled.
Mercator imagery at the outer tile rows is stretched to close polar caps; this
is presentation geometry, not measured polar imagery or terrain.

The globe sphere uses an east/up/south frame anchored at the map's geographic
center. No Gaussian model or splat registration changes. Local imagery, globe
imagery and registered splats use the same existing imagery attribution.

3D coverage is projected from the live floating camera frame into a green SVG
overlay on both the map and globe. Near-plane clipping keeps inclined partial
boxes visible; the globe's back side is excluded. Tiny boxes become location
markers: clicking one zooms to its actual registered bounds. Clicking a nearby
box opens the scene with the live camera's center, scale and orientation.
Overlapping bounds select the closest projected scene center. Dragging more
than five pixels cancels activation. Outlines and markers also support Enter
and Space. When no coverage is in view, explicit buttons offer Jacksonville
and New York City; enabling coverage itself does not move the camera.
Projection and SVG coordinates update synchronously after every rendered GPU
frame. Persistent SVG nodes avoid throttled position updates and React commit
latency while orbiting, panning or zooming. React state only tracks coverage
availability for the empty-view message; keyboard activation uses the latest
frame's projected bounds.

Checks cover default continuous navigation, no mode switches, search, geographic
camera round trips, Earth anchor geometry, continuous blend weights, ground-ray
picking, no extra Earth camera, and map/splat handoffs.
Interactive real-GPU rendering and live tile availability still require host
browser review, especially transition smoothness and navigation near the poles.
