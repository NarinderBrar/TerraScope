import { useEffect, useRef, useState } from 'react';
import type { Scene } from '@terrascope/contracts';
import type { RenderSettings } from '../gpu/RasterRenderer';
import { RasterClient } from '../data/RasterClient';
import { GlobeController } from './GlobeController';
import type { GpuContext } from '../gpu/GpuContext';

export interface GlobeViewProps {
  active: boolean;
  client: RasterClient;
  context: GpuContext | null;
  sceneA: Scene | null;
  sceneB: Scene | null;
  settings: RenderSettings;
  center: { lon: number; lat: number };
}

export function GlobeView({
  active,
  client,
  context,
  sceneA,
  sceneB,
  settings,
  center,
}: GlobeViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GlobeController | null>(null);
  const startedRef = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new GlobeController(canvas, client);
    controllerRef.current = controller;
    startedRef.current = false;
    controller.setActive(active);
    controller.setInitialCenter(center.lon, center.lat);
    controller.setInputs(sceneA, sceneB, settings);
    const observer = new ResizeObserver(() => controller.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      controller.dispose();
      controllerRef.current = null;
    };
    // Renderer lifecycle is tied to this canvas and the client instance.
    // Inputs are synchronized by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, client]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!active || !controller || !context || startedRef.current) return;
    startedRef.current = true;
    controller.setInitialCenter(center.lon, center.lat);
    void controller.init(context).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [active, center.lat, center.lon, context]);

  useEffect(() => {
    controllerRef.current?.setActive(active);
  }, [active]);

  useEffect(() => {
    controllerRef.current?.setInputs(sceneA, sceneB, settings);
  }, [sceneA, sceneB, settings]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = drag.current;
    if (!start) return;
    controllerRef.current?.orbit(event.clientX - start.x, event.clientY - start.y);
    drag.current = { x: event.clientX, y: event.clientY };
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault();
    controllerRef.current?.zoom(event.deltaY);
  };

  return (
    <div className={`globe-view${active ? ' active' : ''}`} aria-hidden={!active}>
      <canvas
        ref={canvasRef}
        className="globe-canvas"
        aria-label="Interactive 3D Earth globe"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={onWheel}
      />
      <div className="globe-controls">
        <button type="button" className="secondary mini-btn" onClick={() => controllerRef.current?.reset()}>
          Reset globe
        </button>
        <span>Drag to orbit · scroll to zoom</span>
      </div>
      {error && <div className="banner error">3D view: {error}</div>}
      <span className="globe-attribution">Satellite basemap © EOX IT Services · Contains modified Copernicus Sentinel data</span>
    </div>
  );
}
