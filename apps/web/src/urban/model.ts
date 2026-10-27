import type { SplatSceneMeta } from '../data/splatScenes';
import { geographicToModel } from '../data/splatGeoreference';
import type { RoadResult, ShadeResult, TrafficResult, UrbanData, UrbanFeature, UrbanOptions, XY } from './types';

export function metricFrame(scene: SplatSceneMeta) {
  const [a, b, c, d] = scene.georeference.modelToMercator;
  const k = Math.cos(scene.center.lat * Math.PI / 180);
  return { point: ([x, y]: XY): XY => [k * (a * x + b * y), k * (c * x + d * y)],
    metresPerUnit: Math.sqrt(Math.abs(a * d - b * c)) * k };
}
export const distance = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function inside(p: XY, polygon: XY[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
const driving = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$/;
export function drivable(f: UrbanFeature): boolean {
  return f.kind === 'road' && driving.test(f.tags.highway) && f.tags.access !== 'private'
    && f.tags.motor_vehicle !== 'no' && f.tags.access !== 'no';
}

/** Incremental capacity-aware assignment of explicitly assumed trips, not measured traffic. */
export function simulateTraffic(data: UrbanData, scene: SplatSceneMeta, options: UrbanOptions): TrafficResult {
  const frame = metricFrame(scene), roads: RoadResult[] = [];
  const nodes: XY[] = [], ids = new Map<string, number>();
  const arcs: { to: number; road: number }[][] = [];
  const node = (p: XY, f: UrbanFeature): number => {
    const key = `${p[0].toFixed(2)},${p[1].toFixed(2)},${f.tags.layer ?? '0'}`;
    if (!ids.has(key)) { ids.set(key, nodes.length); nodes.push(p); arcs.push([]); }
    return ids.get(key)!;
  };
  const signals = data.features.filter(f => f.kind === 'signal').map(f => frame.point(f.points[0]));
  for (const f of data.features.filter(drivable)) {
    const oneWay = f.tags.oneway === 'yes' || f.tags.oneway === '1' || f.tags.oneway === '-1' || f.tags.junction === 'roundabout' && f.tags.oneway !== 'no';
    const major = /motorway|trunk|primary|secondary/.test(f.tags.highway);
    const lanes = Math.min(12, Math.max(1, Number(f.tags.lanes) || (major ? 4 : 2)));
    const speedTag = parseFloat(f.tags.maxspeed);
    const freeSpeed = Math.min(130, Math.max(5, Number.isFinite(speedTag) ? speedTag * (/mph/.test(f.tags.maxspeed) ? 1.609344 : 1) : major ? 50 : 30));
    for (let i = 1; i < f.points.length; i++) {
      const a = f.points[i - 1], b = f.points[i], length = distance(frame.point(a), frame.point(b));
      if (length < .5) continue;
      const signalFriction = signals.some(p => Math.min(distance(p, frame.point(a)), distance(p, frame.point(b))) < 18) ? .7 : .85;
      let cap = lanes * (major ? 1500 : 900) * signalFriction;
      if (f.id === options.selectedRoad) {
        if (options.scenario === 'diversion') cap = 0;
        if (options.scenario === 'signals') cap *= 1.15;
        if (options.scenario === 'bus-lane') cap *= Math.max(0, lanes - 1) / lanes;
      }
      const id = roads.length;
      roads.push({ feature: f, a, b, length, capacity: cap, volume: 0, speed: freeSpeed, freeSpeed, load: 0 });
      const na = node(a, f), nb = node(b, f);
      if (f.tags.oneway !== '-1') arcs[na].push({ to: nb, road: id });
      if (!oneWay || f.tags.oneway === '-1') arcs[nb].push({ to: na, road: id });
      // Capacity is total across directions; both directions contribute to its load.
    }
  }
  const trips = options.demand * (options.scenario === 'bus-lane' && options.selectedRoad ? .8 : 1);
  if (nodes.length < 2) return { roads, delay: 0, peakLoad: 0, trips, unserved: trips };
  const count = Math.min(32, nodes.length), demandPerPair = trips / count / 4;
  let unserved = 0;
  for (let stage = 0; stage < 4; stage++) {
    for (let q = 0; q < count; q++) {
      const source = Math.floor(q * nodes.length / count), target = (source + Math.max(1, Math.floor(nodes.length * .47))) % nodes.length;
      const dist = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1), prevRoad = new Int32Array(nodes.length).fill(-1);
      const heap: [number, number][] = [];
      const push = (item: [number, number]): void => {
        let i = heap.length; heap.push(item);
        while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= item[0]) break; heap[i] = heap[p]; i = p; } heap[i] = item;
      };
      const pop = (): [number, number] => {
        const head = heap[0], tail = heap.pop()!;
        if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) {
          let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
          if (heap[c][0] >= tail[0]) break; heap[i] = heap[c]; i = c;
        } heap[i] = tail; } return head;
      };
      dist[source] = 0; push([0, source]);
      while (heap.length) {
        const [cost, at] = pop(); if (cost > dist[at]) continue; if (at === target) break;
        for (const arc of arcs[at]) {
          const r = roads[arc.road]; if (!r.capacity) continue;
          const time = r.length / (r.freeSpeed / 3.6) * (1 + .15 * Math.pow(r.volume / r.capacity, 4));
          if (cost + time < dist[arc.to]) { dist[arc.to] = cost + time; prev[arc.to] = at; prevRoad[arc.to] = arc.road; push([dist[arc.to], arc.to]); }
        }
      }
      if (!Number.isFinite(dist[target])) { unserved += demandPerPair; continue; }
      for (let at = target; at !== source && prev[at] >= 0; at = prev[at]) roads[prevRoad[at]].volume += demandPerPair;
    }
  }
  let delay = 0, peakLoad = 0;
  for (const r of roads) {
    r.load = r.capacity ? r.volume / r.capacity : 0;
    const factor = 1 + .15 * r.load ** 4;
    r.speed = r.capacity ? r.freeSpeed / factor : 0;
    delay += r.volume * r.length / (r.freeSpeed / 3.6) * (factor - 1) / 3600;
    peakLoad = Math.max(peakLoad, r.load);
  }
  return { roads, delay, peakLoad, trips, unserved };
}

/** Solar position at local solar time. Clock/time-zone conversion is intentionally not implied. */
export function solarPosition(date: string, hour: number, latitude: number): { altitude: number; azimuth: number } {
  const day = Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.UTC(Number(date.slice(0, 4)), 0, 0)) / 86400000);
  const rad = Math.PI / 180, decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365) * rad;
  const lat = latitude * rad, h = (hour - 12) * 15 * rad;
  const altitude = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h));
  const azimuth = Math.atan2(-Math.sin(h) * Math.cos(decl), Math.sin(decl) * Math.cos(lat) - Math.cos(decl) * Math.sin(lat) * Math.cos(h));
  return { altitude: altitude / rad, azimuth: (azimuth / rad + 360) % 360 };
}

/** A ray from a pedestrian sample toward the sun intersects roof extrusions/tree crowns. */
export function shadeAt(point: XY, altitude: number, azimuth: number, buildings: { points: XY[]; height: number }[], trees: { point: XY; height: number; radius: number }[]): boolean {
  if (altitude <= 0) return false;
  const a = azimuth * Math.PI / 180, tangent = Math.tan(altitude * Math.PI / 180), dir: XY = [Math.sin(a), Math.cos(a)];
  for (const b of buildings) {
    const max = Math.max(0, b.height - 1.5) / tangent;
    // Check exact ray/edge crossings, avoiding grid-step gaps in narrow building shadows.
    if (inside(point, b.points)) return true;
    for (let i = 1; i < b.points.length; i++) {
      const p = b.points[i - 1], q = b.points[i], edge: XY = [q[0] - p[0], q[1] - p[1]], dx = p[0] - point[0], dy = p[1] - point[1];
      const det = dir[0] * edge[1] - dir[1] * edge[0]; if (Math.abs(det) < 1e-8) continue;
      const t = (dx * edge[1] - dy * edge[0]) / det, u = (dx * dir[1] - dy * dir[0]) / det;
      if (t >= 0 && t <= max && u >= 0 && u <= 1) return true;
    }
  }
  for (const tree of trees) {
    // Spherical crown intersection with a 3D sunlight ray from 1.5 m eye height.
    const center = [tree.point[0] - point[0], tree.point[1] - point[1], tree.height - tree.radius - 1.5];
    const cos = Math.cos(altitude * Math.PI / 180), sin = Math.sin(altitude * Math.PI / 180);
    const along = center[0] * dir[0] * cos + center[1] * dir[1] * cos + center[2] * sin;
    const perpendicular2 = center[0] ** 2 + center[1] ** 2 + center[2] ** 2 - along ** 2;
    if (along >= 0 && perpendicular2 <= tree.radius ** 2) return true;
  }
  return false;
}

export function computeShade(data: UrbanData, scene: SplatSceneMeta, options: UrbanOptions): ShadeResult {
  const frame = metricFrame(scene), unit = frame.metresPerUnit;
  const buildings = data.features.filter(f => f.kind === 'building').map(f => ({ points: f.points.map(frame.point), height: f.height }));
  const treeFeatures = data.features.filter(f => f.kind === 'tree');
  const trees = treeFeatures.map(f => ({ point: frame.point(f.points[0]), height: f.height, radius: 3 }));
  const samples: XY[] = [];
  const b = scene.bounds;
  const corners = [geographicToModel(scene.georeference, b.west, b.south), geographicToModel(scene.georeference, b.east, b.south), geographicToModel(scene.georeference, b.east, b.north), geographicToModel(scene.georeference, b.west, b.north)];
  const inBounds = (p: XY): boolean => inside(p, corners);
  for (const f of data.features.filter(f => f.kind === 'road' && (drivable(f) || /footway|pedestrian|path/.test(f.tags.highway)))) {
    for (let i = 1; i < f.points.length && samples.length < 900; i++) {
      const a = f.points[i - 1], end = f.points[i], len = distance(a, end), count = Math.ceil(len * unit / 15);
      const width = parseFloat(f.tags.width) || (drivable(f) ? 8 : 0);
      for (let j = 0; j < count && samples.length < 900; j++) {
        const t = (j + .5) / count;
        for (const side of drivable(f) ? [-1, 1] : [0]) {
          const off = side * (width / 2 + 1.5) / unit;
          const p: XY = [a[0] + (end[0] - a[0]) * t - (end[1] - a[1]) / len * off, a[1] + (end[1] - a[1]) * t + (end[0] - a[0]) / len * off];
          if (inBounds(p) && !buildings.some(b => inside(frame.point(p), b.points))) samples.push(p);
        }
      }
    }
  }
  // Proposed trees along sampled pedestrian corridors, 15 m apart, avoiding mapped crowns.
  const plannedTrees: XY[] = [];
  if (options.scenario === 'trees') for (const p of samples) {
    if (plannedTrees.length >= 80) break;
    if (trees.every(t => distance(t.point, frame.point(p)) > 8) && plannedTrees.every(q => distance(q, p) * unit > 15)) plannedTrees.push(p);
  }
  trees.push(...plannedTrees.map(p => ({ point: frame.point(p), height: 8, radius: 3 })));
  const sun = solarPosition(options.date, options.hour, scene.center.lat);
  const cells = samples.map(point => ({ point, shaded: shadeAt(frame.point(point), sun.altitude, sun.azimuth, buildings, trees) }));
  let canopyHits = 0, total = 0;
  for (let iy = 0; iy < 100; iy++) for (let ix = 0; ix < 100; ix++) {
    const p = frame.point(geographicToModel(scene.georeference, b.west + (ix + .5) / 100 * (b.east - b.west), b.south + (iy + .5) / 100 * (b.north - b.south)));
    total++; if (trees.some(t => distance(t.point, p) < t.radius)) canopyHits++;
  }
  return { cells, percent: cells.length && sun.altitude > 0 ? 100 * cells.filter(c => c.shaded).length / cells.length : null,
    canopyPercent: 100 * canopyHits / total, sunAltitude: sun.altitude, sunAzimuth: sun.azimuth, plannedTrees };
}
