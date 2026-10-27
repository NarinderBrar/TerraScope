import type { MapView } from '../app/MapScene';
import type { SplatSceneMeta } from '../data/splatScenes';
import { projectSplatFootprints } from './splatFootprints';
import { preloadSplatViewer } from '../splat/preload';

export function SplatFootprints({ view, hoveredId, onOpen }: {
  view: MapView;
  hoveredId: string | null;
  onOpen: (scene: SplatSceneMeta) => void;
}): React.JSX.Element {
  return <div className="splat-footprints" role="group" aria-label="Available 3D scenes">
    {/* Pointer events pass through to the map's pan/zoom and geographic hit testing.
        Native buttons provide the same scene activation to keyboard users. */}
    {projectSplatFootprints(view.camera, view.viewport).reverse()
      .sort((a, b) => Number(a.scene.id === hoveredId) - Number(b.scene.id === hoveredId)).map((box) => <button
      type="button"
      className="splat-footprint"
      key={box.key}
      data-scene-id={box.scene.id}
      data-hovered={box.scene.id === hoveredId}
      aria-label={`Open ${box.scene.name} in 3D`}
      onFocus={preloadSplatViewer}
      onClick={() => onOpen(box.scene)}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {box.width >= 140 && box.height >= 45 && <span aria-hidden="true">{box.scene.name}</span>}
    </button>)}
  </div>;
}
