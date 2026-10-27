import { Color, Vec3, type Entity } from 'playcanvas';
import type { PCApp } from '../splat/supersplat/pc-app';
import type { SplatSceneMeta } from '../data/splatScenes';
import type { UrbanOverlayState, XY } from './types';
import { metricFrame } from './model';

/** All overlays use the exact registered model root, including its Z-up rotation. */
export function createUrbanOverlay(app: PCApp, root: Entity, scene: SplatSceneMeta) {
  let state: UrbanOverlayState | null = null, time = 0;
  let positions: Vec3[] = [], colors: Color[] = [];
  const unit = metricFrame(scene).metresPerUnit;
  // The map datum is 20 cm below the measured street. Keep the overlay on
  // that street rather than adding the previous arbitrary one-model-unit lift.
  const ground = scene.georeference.groundZ + .25 / unit;
  const world = (p: XY, h = 0): Vec3 => root.getWorldTransform().transformPoint(new Vec3(p[0], p[1], ground + h / unit));
  const line = (a: XY, b: XY, color: Color, ha = 0, hb = ha): void => { positions.push(world(a, ha), world(b, hb)); colors.push(color, color); };
  const ring = (p: XY, radius: number, height: number, color: Color): void => {
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, b = (i + 1) * Math.PI / 6;
      line([p[0] + radius / unit * Math.cos(a), p[1] + radius / unit * Math.sin(a)], [p[0] + radius / unit * Math.cos(b), p[1] + radius / unit * Math.sin(b)], color, height);
    }
  };
  const cyan = new Color(.2, .8, 1), green = new Color(.3, 1, .4), yellow = new Color(1, .8, .2), selected = new Color(1, 1, 1);
  return {
    setState(next: UrbanOverlayState | null): void {
      state = next; positions = []; colors = [];
      if (!state) return;
      const { data, options: o, traffic, shade, selectedFeature } = state;
      for (const f of data.features) {
        const highlight = f.id === selectedFeature || f.id === o.selectedRoad && o.scenario !== 'baseline';
        if (f.kind === 'building' && (o.buildings || highlight)) {
          for (let i = 1; i < f.points.length; i++) { line(f.points[i - 1], f.points[i], highlight ? selected : cyan, f.height); line(f.points[i], f.points[i], highlight ? selected : cyan, 0, f.height); }
        }
        if (f.kind === 'tree' && (o.vegetation || highlight)) { line(f.points[0], f.points[0], green, 0, f.height - 3); ring(f.points[0], 3, f.height - 2, highlight ? selected : green); }
        if (['signal', 'bus-stop', 'crossing'].includes(f.kind) && (o.transit || highlight)) {
          const p = f.points[0]; line(p, p, highlight ? selected : yellow, 0, 5); ring(p, 2, 5, highlight ? selected : yellow);
        }
      }
      for (const r of traffic.roads) {
        const highlight = r.feature.id === selectedFeature || r.feature.id === o.selectedRoad && o.scenario !== 'baseline';
        if (o.traffic || highlight) line(r.a, r.b, highlight ? selected : !r.capacity ? new Color(1, .2, .7) : r.load > 1 ? new Color(1, .2, .15) : r.load > .7 ? yellow : cyan, .05);
      }
      if (o.shade && shade.sunAltitude > 0) for (const c of shade.cells) {
        const d = 2 / unit, color = c.shaded ? cyan : yellow;
        line([c.point[0] - d, c.point[1]], [c.point[0] + d, c.point[1]], color, .05);
        line([c.point[0], c.point[1] - d], [c.point[0], c.point[1] + d], color, .05);
      }
      for (const p of shade.plannedTrees) { line(p, p, green, 0, 6); ring(p, 3, 6, green); ring(p, 2, 8, green); }
    },
    update(delta: number): void {
      if (!state) return;
      if (state.options.playing) time += Math.min(delta, .1);
      // Depth testing is disabled intentionally: these are schematic analysis overlays,
      // visible above reconstructed roofs; their geometry stays registered to roads.
      if (positions.length) app.drawLines(positions, colors, false);
      if (!state.options.traffic) return;
      const particles: Vec3[] = [], particleColors: Color[] = [];
      let budget = 1600;
      for (const r of state.traffic.roads) {
        if (!r.volume || !r.capacity || budget <= 0) continue;
        const tags = r.feature.tags;
        const oneWay = ['yes', '1', '-1'].includes(tags.oneway) || tags.junction === 'roundabout' && tags.oneway !== 'no';
        const n = Math.min(10, Math.max(oneWay ? 1 : 2, Math.ceil(r.volume / 100)));
        for (let j = 0; j < n && budget-- > 0; j++) {
          const reverse = tags.oneway === '-1' || !oneWay && j % 2 === 1;
          const t = ((time * r.speed / 3.6 / r.length + j / n) % 1);
          const u = reverse ? 1 - t : t, tail = Math.max(0, Math.min(1, u + (reverse ? 1 : -1) * Math.min(.1, 3 / r.length)));
          particles.push(world([r.a[0] + (r.b[0] - r.a[0]) * u, r.a[1] + (r.b[1] - r.a[1]) * u], .35), world([r.a[0] + (r.b[0] - r.a[0]) * tail, r.a[1] + (r.b[1] - r.a[1]) * tail], .35));
          particleColors.push(selected, selected);
        }
      }
      if (particles.length) app.drawLines(particles, particleColors, false);
    },
  };
}
