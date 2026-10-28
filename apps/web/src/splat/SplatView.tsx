import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';
import type { SplatSession } from './session';
import type { GroundMapStatus } from './GroundMapLayer';
import { WORLD_IMAGERY_ATTRIBUTION } from '../map/worldImagery';
import type { SplatStreamStatus } from './sogChunk';
import { SegmentedViewControl } from './SegmentedViewControl';
import { loadSegmentationMetadata, type SegmentationMetadata } from './segmentationMetadata';
import type { GeographicView } from '../map/navigation3D';

export interface SplatViewProps {
  active: boolean;
  sceneMeta: SplatSceneMeta;
  entryBounds: GeoBounds;
  entryOrientation?: GeographicView['orientation'];
  onReady?: () => void;
  onClose: (view?: GeographicView) => void;
}

export function SplatView({ active, sceneMeta, entryBounds, entryOrientation, onReady, onClose }: SplatViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<SplatSession | null>(null);
  const [segments, setSegments] = useState<SegmentationMetadata | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting 3D viewer…');
  const [progress, setProgress] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapVisible, setMapVisible] = useState(true);
  const mapVisibleRef = useRef(true);
  const [mapStatus, setMapStatus] = useState<GroundMapStatus>('loading');
  const [streamStatus, setStreamStatus] = useState<SplatStreamStatus | null>(null);
  const setSegmentedEnabled = useCallback((enabled: boolean): Promise<void> =>
    sessionRef.current?.setSegmentedEnabled?.(enabled) ?? Promise.reject(new Error('Viewer is not ready.')), []);
  const close = useCallback(() => onClose(sessionRef.current?.getMapView?.() ?? undefined), [onClose]);

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
    setStreamStatus(null);
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
      }, entryBounds, (next) => { if (!controller.signal.aborted) setStreamStatus(next); }, entryOrientation);
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
  }, [active, sceneMeta, entryBounds, entryOrientation, attempt]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close]);

  // Imagery streams independently. A slow Esri request must not hide coarse splats.
  const ready = !loading && !error;

  // Session creation resolves after frameend. Notify after React makes that
  // rendered canvas opaque, so removing the previous 3D view cannot reveal 2D.
  useEffect(() => {
    if (active && ready) onReady?.();
  }, [active, ready, onReady]);

  useEffect(() => {
    if (!active || !ready) return;
    const controller = new AbortController();
    setSegments(null);
    void loadSegmentationMetadata(sceneMeta.id, controller.signal).then(metadata => {
      if (!controller.signal.aborted) setSegments(metadata);
    }).catch(() => { if (!controller.signal.aborted) setSegments(null); });
    return () => controller.abort();
  }, [active, ready, sceneMeta.id, attempt]);
  const segmentMetadata = segments?.scene === sceneMeta.id ? segments : null;

  return (
    <div className={`splat-view-direct${active ? ' active' : ''}`} aria-hidden={!active} data-splat-engine="supersplat" data-ready={ready} data-splat-lod={streamStatus?.bestLod ?? undefined}>
      <canvas ref={canvasRef} className={`splat-canvas${entryOrientation ? ' from-3d' : ''}${ready ? ' ready' : ''}`} aria-label={`Interactive 3D Gaussian splat of ${sceneMeta.name}`} tabIndex={0} />
      <aside className="splat-controls-overlay splat-right-panel" aria-label="3D scene controls">
        <header><strong>TerraScope</strong><span>Map &amp; 3D explorer</span></header>
        <div><h3>{sceneMeta.name}</h3><span>Skyfall-GS · SuperSplat 3D</span></div>
        <label className="splat-map-toggle"><input type="checkbox" checked={mapVisible} onChange={(event) => {
          const visible = event.target.checked;
          setMapVisible(visible);
          mapVisibleRef.current = visible;
          sessionRef.current?.setMapVisible(visible);
        }} />Satellite map</label>
        {active && ready && <SegmentedViewControl key={`segments-${sceneMeta.id}-${attempt}`} metadata={segmentMetadata} setEnabled={setSegmentedEnabled} />}
        {!loading && streamStatus && <span className="splat-detail-status" role="status">
          LOD {streamStatus.bestLod ?? 3} · {streamStatus.failed ? 'Some detail unavailable' : streamStatus.pending ? 'Refining…' : 'Ready'}
          {streamStatus.failed > 0 && <button type="button" className="secondary" onClick={() => sessionRef.current?.retryDetail()}>Retry detail</button>}
        </span>}
        <button type="button" className="primary" autoFocus onClick={() => close()}>← Back to Map</button>
      </aside>
      {loading && <div className="splat-message" role="status"><p>{status}</p><progress max={1} value={progress} /></div>}
      {error && <div className="splat-message" role="alert"><p>Unable to load this 3D scene: {error}</p><button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>}
      {mapVisible && !loading && !error && <div className="splat-map-status" role="status" data-map-status={mapStatus}>
        {mapStatus === 'loading' ? 'Loading satellite map…' : mapStatus === 'ready' ? 'Satellite map · imagery aligned' : <><span>Satellite map unavailable</span> <button type="button" onClick={() => sessionRef.current?.reloadMap()}>Retry map</button></>}
      </div>}
      <div className="splat-help">Drag to pan · right-drag to orbit · scroll to zoom · Esc to return</div>
      <a className="splat-attribution" href="https://huggingface.co/jayinnn/Skyfall-GS-ply" target="_blank" rel="noreferrer">Skyfall-GS models · Apache-2.0</a>
      {mapVisible && mapStatus === 'ready' && <span className="splat-map-attribution">{WORLD_IMAGERY_ATTRIBUTION}</span>}
    </div>
  );
}
