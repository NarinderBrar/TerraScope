# Gaussian splat scene integration

- Every selectable Gaussian splat scene must align with the geographic map.
- Do not add standalone 3D previews or expose unregistered models in the scene picker.
- A downloaded/converted model is not an integrated scene. Measure or recover its
  geographic origin, scale, rotation, ground height and footprint before enabling it.
- Retain the registration evidence under `docs/splat-registration/` and validate map
  placement and map-to-3D camera continuity before calling an integration complete.
- Never substitute city-center coordinates or a guessed transform for registration.
