import type { EventHandler } from 'playcanvas';
import type { Coverage3D } from './coverage3D';

/** Paint persistent SVG nodes before the browser presents the same GPU frame.
 * React owns the nodes; their projected coordinates belong to the render loop.
 */
export function bindCoverageFrames(renderer: Pick<EventHandler, 'on' | 'off'>,
  getSvg: () => SVGSVGElement | null, visible: () => boolean,
  project: () => Coverage3D[], onFrame: (boxes: Coverage3D[], checked: boolean) => void) {
  const render = () => {
    const svg = getSvg(), enabled = visible();
    if (svg) svg.style.display = enabled ? '' : 'none';
    if (!enabled || !svg) { onFrame([], false); return; }
    const boxes = project(), byId = new Map(boxes.map(box => [box.scene.id, box]));
    for (const group of svg.querySelectorAll<SVGGElement>('[data-scene-id]')) {
      const box = byId.get(group.dataset.sceneId!);
      // Child visibility can override inherited SVG visibility. Display hides
      // the entire group when coverage crosses the horizon or leaves the view.
      group.style.display = box ? '' : 'none';
      group.setAttribute('visibility', box ? 'visible' : 'hidden');
      group.setAttribute('tabindex', box ? '0' : '-1');
      if (!box) continue;
      const circle = group.querySelector('circle')!, polygon = group.querySelector('polygon')!;
      circle.setAttribute('visibility', box.marker ? 'visible' : 'hidden');
      polygon.setAttribute('visibility', box.marker ? 'hidden' : 'visible');
      if (box.marker) {
        circle.setAttribute('cx', String(box.center.x)); circle.setAttribute('cy', String(box.center.y));
      } else polygon.setAttribute('points', box.points.map(p => `${p.x},${p.y}`).join(' '));
      group.setAttribute('aria-label', box.marker ? `Zoom to ${box.scene.name} coverage` : `Open ${box.scene.name} in 3D`);
      group.querySelector('title')!.textContent = `${box.scene.name} · ${box.marker ? 'zoom to coverage' : 'click to open'}`;
    }
    onFrame(boxes, true);
  };
  renderer.on('postrender', render);
  return () => renderer.off('postrender', render);
}
