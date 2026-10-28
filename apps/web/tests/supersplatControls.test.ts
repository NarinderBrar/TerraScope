import { afterEach, expect, it, vi } from 'vitest';
import { EventHandler } from 'playcanvas';
import { PointerController } from '../src/splat/supersplat/controllers';
import type { Camera } from '../src/splat/supersplat/camera';

afterEach(() => vi.unstubAllGlobals());

it('removes every pointer/window listener on teardown without recursive cleanup', () => {
  const target = new EventTarget() as EventTarget & { setPointerCapture: () => void };
  target.setPointerCapture = vi.fn();
  const windowTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  const removeWindowListener = vi.spyOn(windowTarget, 'removeEventListener');
  const removePointerListener = vi.spyOn(target, 'removeEventListener');
  const events = new EventHandler();
  const setAzimElev = vi.fn();
  const camera = {
    azim: 0, elevation: 0, controlMode: 'orbit', setAzimElev,
    scene: { app: { graphicsDevice: { canvas: target } }, events, config: { controls: { orbitSensitivity: 0.2 } } },
  } as unknown as Camera;
  const controller = new PointerController(camera, target as unknown as HTMLElement);
  const pointer = (type: string, offsetX: number): void => {
    const event = new Event(type);
    Object.assign(event, { pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, offsetX, offsetY: 10 });
    target.dispatchEvent(event);
  };
  pointer('pointerdown', 10);
  pointer('pointermove', 20);
  expect(setAzimElev).toHaveBeenCalledWith(-2, 0);
  setAzimElev.mockClear();
  expect(() => controller.destroy()).not.toThrow();
  expect(() => controller.destroy()).not.toThrow();
  expect(removeWindowListener.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['blur', 'keydown', 'keyup']));
  expect(removePointerListener.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'wheel', 'dblclick']));
  pointer('pointerdown', 10);
  pointer('pointermove', 20);
  expect(setAzimElev).not.toHaveBeenCalled();
});

it('supports regional zoom-out and adjusts the clipping planes with distance', async () => {
  const { Camera } = await import('../src/splat/supersplat/camera');
  const { Vec3 } = await import('playcanvas');
  const position = new Vec3();
  const mainCamera = {
    camera: { fov: 50, farClip: 1000, nearClip: .1 }, getPosition: () => position,
    setPosition: (x: number, y: number, z: number) => position.set(x, y, z), lookAt: vi.fn(),
  };
  const camera = Object.assign(Object.create(Camera.prototype) as Camera, {
    mainCamera, sceneRadius: 1000, distanceTween: { value: { distance: 1 } }, focalPoint: new Vec3(), azim: 0, elevation: -90,
  });
  camera.setDistance(500 * camera.fovFactor);
  expect(mainCamera.getPosition().y).toBeCloseTo(500000);
  expect(camera.camera.farClip).toBeGreaterThan(500000);
  expect(camera.camera.nearClip).toBeLessThan(10);
  camera.setDistance(.0001);
  expect(mainCamera.getPosition().y).toBeCloseTo(5);
  expect(camera.camera.nearClip).toBe(.1);
});

it('routes map left-drag to surface pan and right-drag to anchored orbit', () => {
  const target = new EventTarget() as EventTarget & { setPointerCapture: () => void; hasPointerCapture: () => boolean };
  target.setPointerCapture = vi.fn(); target.hasPointerCapture = () => false;
  vi.stubGlobal('window', new EventTarget());
  const surfaceControls = { pan: vi.fn(), orbit: vi.fn() };
  const camera = { surfaceControls, controlMode: 'orbit',
    scene: { app: { graphicsDevice: { canvas: target } }, events: new EventHandler(), config: { controls: { orbitSensitivity: .2 } } },
  } as unknown as Camera;
  const controller = new PointerController(camera, target as unknown as HTMLElement);
  const pointer = (type: string, button: number, buttons: number, x: number) => {
    const event = new Event(type);
    Object.assign(event, { pointerType: 'mouse', pointerId: 1, button, buttons, offsetX: x, offsetY: 20 });
    target.dispatchEvent(event);
  };
  try {
    pointer('pointerdown', 0, 1, 10); pointer('pointermove', 0, 1, 25); pointer('pointerup', 0, 0, 25);
    expect(surfaceControls.pan).toHaveBeenCalledWith(25, 20, 15, 0);
    expect(surfaceControls.orbit).not.toHaveBeenCalled();
    pointer('pointerdown', 2, 2, 10); pointer('pointermove', 2, 2, 25); pointer('pointerup', 2, 0, 25);
    expect(surfaceControls.orbit).toHaveBeenCalledWith(15, 0);
  } finally { controller.destroy(); }
});
