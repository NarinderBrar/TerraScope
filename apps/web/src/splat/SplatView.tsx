import { useEffect, useRef, useState } from 'react';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';
import type { SplatSession } from './session';
import type { GroundMapStatus } from './GroundMapLayer';

export interface SplatViewProps {
  active: boolean;
  sceneMeta: SplatSceneMeta;
  entryBounds: GeoBounds;
  onClose: () => void;
}

export function SplatView({ active, sceneMeta, entryBounds, onClose }: SplatViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<SplatSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting 3D viewer…');
  const [progress, setProgress] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapVisible, setMapVisible] = useState(true);
  const mapVisibleRef = useRef(true);
  const [mapStatus, setMapStatus] = useState<GroundMapStatus>('loading');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
    const controller = new AbortController();
    let session: SplatSession | undefined;
    setLoading(true);
    setError(null);
    setProgress(undefined);
    setStatus('Starting 3D viewer…');
    setMapStatus('loading');
    void import('./session').then(async ({ createSplatSession }) => {
      session = await createSplatSession(canvas, sceneMeta, controller.signal, (message, fraction) => {
        if (controller.signal.aborted) return;
        setStatus(message);
        setProgress(fraction);
      }, (message) => {
        if (controller.signal.aborted) return;
        setError(message);
        setLoading(false);
      }, (next) => {
        if (!controller.signal.aborted) setMapStatus(next);
      }, entryBounds);
      if (controller.signal.aborted) { session.dispose(); return; }
      sessionRef.current = session;
      session.setMapVisible(mapVisibleRef.current);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => {
      controller.abort();
      session?.dispose();
      sessionRef.current = null;
    };
  }, [active, sceneMeta, entryBounds, attempt]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  const ready = !loading && mapStatus !== 'loading' && !error;

  return (
    <div className={`splat-view-direct${active ? ' active' : ''}`} aria-hidden={!active} data-splat-engine="supersplat" data-ready={ready}>
      <canvas ref={canvasRef} className={`splat-canvas${ready ? ' ready' : ''}`} aria-label={`Interactive 3D Gaussian splat of ${sceneMeta.name}`} tabIndex={0} />
      <div className="splat-controls-overlay">
        <div><h3>{sceneMeta.name}</h3><span>Skyfall-GS · SuperSplat 3D</span></div>
        <label className="splat-map-toggle"><input type="checkbox" checked={mapVisible} onChange={(event) => {
          const visible = event.target.checked;
          setMapVisible(visible);
          mapVisibleRef.current = visible;
          sessionRef.current?.setMapVisible(visible);
        }} />Satellite map</label>
        <button type="button" className="secondary" disabled={loading || !!error} onClick={() => sessionRef.current?.reset()}>Reset view</button>
        <button type="button" className="primary" autoFocus onClick={onClose}>← Back to Map</button>
      </div>
      {loading && <div className="splat-message" role="status"><p>{status}</p><progress max={1} value={progress} /></div>}
      {error && <div className="splat-message" role="alert"><p>Unable to load this 3D scene: {error}</p><button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>}
      {mapVisible && !loading && !error && <div className="splat-map-status" role="status" data-map-status={mapStatus}>
        {mapStatus === 'loading' ? 'Loading satellite map…' : mapStatus === 'ready' ? 'Satellite map · imagery aligned' : <><span>Satellite map unavailable</span> <button type="button" onClick={() => sessionRef.current?.reloadMap()}>Retry map</button></>}
      </div>}
      <div className="splat-help">Drag to orbit · right-drag to pan · scroll to zoom · Esc to return</div>
      <a className="splat-attribution" href="https://huggingface.co/jayinnn/Skyfall-GS-ply" target="_blank" rel="noreferrer">Skyfall-GS models · Apache-2.0</a>
      {mapVisible && mapStatus === 'ready' && <span className="splat-map-attribution">Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community</span>}
    </div>
  );
}
