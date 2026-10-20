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
