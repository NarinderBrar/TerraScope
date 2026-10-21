import { describe, expect, it } from 'vitest';
import { SKYFALL_SCENES } from '../src/data/splatScenes';
import { createCamera, panBy, screenToLonLat } from '../src/map/MapCamera';
import { hitSplatFootprint, projectSplatFootprints } from '../src/map/splatFootprints';

const viewport = { width: 1200, height: 900, dpr: 1 };

describe('registered 3D coverage projection', () => {
  it.each(SKYFALL_SCENES)('projects the geographic bounds of $id precisely', (scene) => {
    const camera = createCamera(scene.center, 15);
    const box = projectSplatFootprints(camera, viewport).find((item) => item.scene.id === scene.id)!;
    const nw = screenToLonLat(camera, viewport, box.left, box.top);
    const se = screenToLonLat(camera, viewport, box.left + box.width, box.top + box.height);
    expect(nw.lon).toBeCloseTo(scene.bounds.west, 9);
    expect(nw.lat).toBeCloseTo(scene.bounds.north, 9);
    expect(se.lon).toBeCloseTo(scene.bounds.east, 9);
    expect(se.lat).toBeCloseTo(scene.bounds.south, 9);
    expect(hitSplatFootprint(camera, viewport, { x: box.left + box.width / 2, y: box.top + box.height / 2 })?.id).toBe(scene.id);
    expect(projectSplatFootprints(camera, { ...viewport, dpr: 2 })).toEqual(projectSplatFootprints(camera, viewport));
  });

  it('follows panning and fractional zoom without rounding', () => {
    const scene = SKYFALL_SCENES[0];
    const camera = createCamera(scene.center, 15);
    const original = projectSplatFootprints(camera, viewport)[0];
    const moved = projectSplatFootprints(panBy(camera, 35, -20), viewport)[0];
    expect(moved.left - original.left).toBeCloseTo(35, 7);
    expect(moved.top - original.top).toBeCloseTo(-20, 7);
    const zoomed = projectSplatFootprints({ ...camera, zoom: 15.5 }, viewport)[0];
    expect(zoomed.width / original.width).toBeCloseTo(Math.sqrt(2), 7);
  });

  it('clips close coverage to the viewport and ignores uncovered locations', () => {
    const camera = createCamera(SKYFALL_SCENES[0].center, 20);
    expect(projectSplatFootprints(camera, viewport)[0]).toMatchObject({ left: 0, top: 0, width: 1200, height: 900 });
    expect(hitSplatFootprint(camera, viewport, { x: -1, y: 400 })).toBeUndefined();
    expect(projectSplatFootprints(createCamera({ lon: -121, lat: 38 }, 15), viewport)).toEqual([]);
    expect(projectSplatFootprints(camera, { ...viewport, width: 0 })).toEqual([]);
  });

  it('keeps coverage aligned across repeated worlds', () => {
    const scene = SKYFALL_SCENES[0];
    const camera = createCamera(scene.center, 15);
    const wrapped = createCamera({ ...scene.center, lon: scene.center.lon + 360 }, 15);
    const a = projectSplatFootprints(camera, viewport)[0];
    const b = projectSplatFootprints(wrapped, viewport)[0];
    expect(b.left).toBeCloseTo(a.left, 7);
    expect(b.top).toBeCloseTo(a.top, 7);
    const copies = projectSplatFootprints(createCamera(scene.center, 2), { ...viewport, width: 2400 }, [scene]);
    expect(copies.length).toBeGreaterThan(1);
    expect(new Set(copies.map((box) => box.key)).size).toBe(copies.length);
  });

  it('resolves overlapping NYC coverage by proximity in every repeated world', () => {
    const east12 = SKYFALL_SCENES.find((scene) => scene.id === 'NYC_219')!;
    for (const shift of [0, -360, 360]) {
      const camera = createCamera({ ...east12.center, lon: east12.center.lon + shift }, 16);
      const point = { x: viewport.width / 2, y: viewport.height / 2 };
      const covering = projectSplatFootprints(camera, viewport).filter((box) => point.x >= box.left && point.x <= box.left + box.width
        && point.y >= box.top && point.y <= box.top + box.height);
      expect(covering.map((box) => box.scene.id)).toEqual(['NYC_010', 'NYC_219']);
      expect(hitSplatFootprint(camera, viewport, point)?.id).toBe('NYC_219');
    }
  });
});
