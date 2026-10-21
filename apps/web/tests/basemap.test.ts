// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Basemap, BASEMAP_ATTRIBUTION } from '../src/map/Basemap';
import { createCamera } from '../src/map/MapCamera';
import { WORLD_IMAGERY_ATTRIBUTION, worldImageryUrl } from '../src/map/worldImagery';
import type { MapScene } from '../src/app/MapScene';

it('uses Esri at level 20 while keeping overview imagery under unavailable detail', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const scene = {
    view: { camera: createCamera({ lon: -73.9897, lat: 40.7349 }, 20), viewport: { width: 1024, height: 768, dpr: 1 } },
    subscribe: () => () => {},
  } as unknown as MapScene;
  try {
    await act(async () => root.render(createElement(Basemap, { scene })));
    const images = [...container.querySelectorAll('img')];
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.src.includes('server.arcgisonline.com'))).toBe(true);
    const sharp = container.querySelector<HTMLImageElement>('.sharp img')!;
    const path = new URL(sharp.src).pathname.split('/');
    const [z, y, x] = path.slice(-3).map(Number);
    expect(z).toBe(20);
    expect(sharp.src).toBe(worldImageryUrl(z, x, y));
    expect(container.querySelector<HTMLImageElement>('.labels img')!.src).toContain('/Reference/World_Boundaries_and_Places/');
    expect(images.some((image) => image.src.includes('/tile/17/'))).toBe(true);
    expect(images.some((image) => image.src.includes('/tile/8/'))).toBe(true);
    await act(async () => sharp.dispatchEvent(new Event('error')));
    expect(sharp.style.visibility).toBe('hidden');
    const fallback = images.find((image) => image.src.includes('/World_Imagery/') && image.src.includes('/tile/17/'))!;
    expect(fallback.style.visibility).not.toBe('hidden');
    expect(BASEMAP_ATTRIBUTION).toContain(WORLD_IMAGERY_ATTRIBUTION);
    expect(BASEMAP_ATTRIBUTION).not.toContain('EOX');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
