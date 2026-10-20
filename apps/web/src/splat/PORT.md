# SuperSplat / PlayCanvas viewer integration

Reference project: `/home/narinder/Documents/supersplat`, version 3.5.2,
commit `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`.

`supersplat/pc-app.ts` and `supersplat/controllers.ts` are ported from that
project. The MIT license is preserved in `supersplat/LICENSE`. The pointer
controller's listener cleanup captures the previous cleanup callback instead
of recursing through the reassigned callback. Its camera import is type-only.

`supersplat/camera.ts` is a TerraScope adapter implementing the camera contract
used by those controls, including SuperSplat's azimuth/elevation convention.
The native PlayCanvas GSplat asset/component path renders the existing SOG city
models. PlayCanvas is pinned to 2.23.0, matching the reference project.

This is a viewer integration using SuperSplat's app/control setup and its
PlayCanvas engine stack. The complete SuperSplat editor, its custom editing
renderer, selection, palettes, export and document UI are not embedded.
No iframe or separately running SuperSplat server is required.

`session.ts` owns the PlayCanvas app, native asset lifecycle, resize, abort,
reset and context-loss handling. The entire Z-up model frame is rotated to the
Y-up frame expected by SuperSplat controls. The satellite ground layer is in the
same model frame and uses a PlayCanvas unlit textured mesh on both backends.
Its geographic placement uses the fixed per-scene transforms in `splatGeoreference.ts`
and `splatScenes.ts`; `groundMapPlan.ts` only chooses tiles and projects them.
Registration measurements and limitations are documented in `docs/SPLAT_GEOREGISTRATION.md`.

The former SplatShop/Babylon runtime has been removed. `splat-transform@2.3.1`
remains a development dependency for preparing the existing SOG assets; it is
not imported by the browser viewer.
