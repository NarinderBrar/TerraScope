# Map and 3D navigation

The map fills the window. One right-hand panel contains place search, a single
2D/3D camera switch, the scene picker and footprint visibility. Mark Area, the
Shift-drag hint, the separate globe button, satellite comparison tools and the
Switch to 3D Urban View prompt are removed from the current explorer UI. Legacy
analysis helpers remain in source but are not mounted by App.

Entering 3D uses the same geographic center, viewport and map scale, initially
looking straight down. Orbit gestures still enter 3D automatically. A camera
snapshot tracks the live surface intersection and equivalent Mercator scale.
Switching back to 2D applies that center/zoom rather than resetting to the old
entry viewport. Registered splat viewers expose the same snapshot when their
camera switch or Back to Map control is used. Round trips preserve geographic
center and equivalent map zoom within the 2D renderer's supported zoom range.
All splat controls, including the
scene title, reset, glow and Urban Lab, are docked in a right-side panel.

Local 3D uses a flat satellite surface with no terrain elevation. Zooming out
crossfades this surface into a spherical Earth over a camera-distance band of
150–800 km. Both surfaces share the same PlayCanvas camera; there is no renderer
or location reset. At larger distances the focal point eases toward Earth's
center. This path also applies to registered splat viewers; their measured
Mercator scale, rotation and ground datum place the Earth tangent frame.
Zoom limits are expanded for these 3D cameras without resetting camera state. The Earth
uses 16 low-resolution Esri tiles and a dark sphere while imagery loads. Tiles
are prefetched once the camera is about 30 km away, with four bounded requests.
Mercator imagery at the outer tile rows is stretched to close polar caps; this
is presentation geometry, not measured polar imagery or terrain.

The globe sphere uses an east/up/south frame anchored at the map's geographic
center. No Gaussian model or splat registration changes. Local imagery, globe
imagery and registered splats use the same existing imagery attribution.

3D footprint clicks intersect a ground ray and select the nearest registered
scene center among overlapping bounds. Dragging more than five pixels cancels
activation. The chosen scene receives the live 3D camera's geographic center and
scale. Flat footprint lines are hidden once the globe dominates; at that scale
they are not useful selection targets. 2D coverage remains keyboard accessible.

Checks cover 2D/3D geographic camera round trips, Earth anchor geometry, continuous
blend weights, ground-ray picking, no extra Earth camera, panel controls and
existing area/footprint interactions. Typecheck and production build pass.
Interactive real-GPU rendering and live tile availability still require host
browser review, especially transition smoothness and navigation near the poles.
