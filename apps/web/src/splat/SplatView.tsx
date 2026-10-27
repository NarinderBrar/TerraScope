import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoBounds, SplatSceneMeta } from '../data/splatScenes';
import type { SplatSession } from './session';
import type { GroundMapStatus } from './GroundMapLayer';
import { WORLD_IMAGERY_ATTRIBUTION } from '../map/worldImagery';
import type { SplatStreamStatus } from './sogChunk';
import { UrbanPanel } from '../urban/UrbanPanel';
import type { UrbanOverlayState } from '../urban/types';
import { BuildingHighlightsControl } from '../urban/BuildingHighlightsControl';
import type { GlowCategory } from './LangSplatBuildingGlow';
import { hasSceneGlow } from './glowMetadata';
import type { GeographicView } from '../map/navigation3D';

export interface SplatViewProps {
  active: boolean;
  sceneMeta: SplatSceneMeta;
  entryBounds: GeoBounds;
  entryOrientation?: GeographicView['orientation'];
  onReady?: () => void;
  onClose: (view?: GeographicView, destination?: 'map' | '2d') => void;
}

export function SplatView({ active, sceneMeta, entryBounds, entryOrientation, onReady, onClose }: SplatViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<SplatSession | null>(null);
  const [glowAvailability, setGlowAvailability] = useState<{scene: string; available: boolean} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting 3D viewer…');
  const [progress, setProgress] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapVisible, setMapVisible] = useState(true);
  const mapVisibleRef = useRef(true);
  const [mapStatus, setMapStatus] = useState<GroundMapStatus>('loading');
  const [streamStatus, setStreamStatus] = useState<SplatStreamStatus | null>(null);
  const [urbanOpen, setUrbanOpen] = useState(false);
  const urbanRef = useRef<UrbanOverlayState | null>(null);
  const updateUrban = useCallback((state: UrbanOverlayState | null) => {
    urbanRef.current = state;
    sessionRef.current?.setUrbanState?.(state);
  }, []);
  const setBuildingsEnabled = useCallback((enabled: boolean): Promise<void> =>
    sessionRef.current?.setBuildingsEnabled?.(enabled) ?? Promise.resolve(), []);
  const setGlowCategory = useCallback((category: GlowCategory): Promise<void> =>
    sessionRef.current?.setGlowCategory?.(category) ?? Promise.resolve(), []);
  const close = useCallback((destination: 'map' | '2d' = 'map') => onClose(sessionRef.current?.getMapView?.() ?? undefined, destination), [onClose]);

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
      session.setUrbanState?.(urbanRef.current);
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
    void hasSceneGlow(sceneMeta.id, controller.signal).then(available => {
      if (!controller.signal.aborted) setGlowAvailability({ scene: sceneMeta.id, available });
    });
    return () => controller.abort();
  }, [active, ready, sceneMeta.id, attempt]);
  const glowAvailable = glowAvailability?.scene === sceneMeta.id && glowAvailability.available;

  return (
    <div className={`splat-view-direct${active ? ' active' : ''}`} aria-hidden={!active} data-splat-engine="supersplat" data-ready={ready} data-splat-lod={streamStatus?.bestLod ?? undefined}>
      <canvas ref={canvasRef} className={`splat-canvas${entryOrientation ? ' from-3d' : ''}${ready ? ' ready' : ''}`} aria-label={`Interactive 3D Gaussian splat of ${sceneMeta.name}`} tabIndex={0} />
      <aside className="splat-controls-overlay splat-right-panel" aria-label="3D scene controls">
        <header><strong>TerraScope</strong><span>Map &amp; 3D explorer</span></header>
        <div><h3>{sceneMeta.name}</h3><span>Skyfall-GS · SuperSplat 3D</span></div>
        <button type="button" role="switch" aria-label="3D view" aria-checked="true" className="map-camera-toggle" onClick={() => close('2d')}>
          <span>2D</span><span className="camera-toggle-track"><span /></span><span>3D</span>
        </button>
        <label className="splat-map-toggle"><input type="checkbox" checked={mapVisible} onChange={(event) => {
          const visible = event.target.checked;
          setMapVisible(visible);
          mapVisibleRef.current = visible;
          sessionRef.current?.setMapVisible(visible);
        }} />Satellite map</label>
        <button type="button" className="secondary" disabled={loading || !!error} onClick={() => sessionRef.current?.reset()}>Reset view</button>
        <button type="button" className="secondary" disabled={!ready} aria-expanded={urbanOpen} onClick={() => setUrbanOpen(open => !open)}>{urbanOpen ? 'Close Urban Lab' : 'Urban Lab'}</button>
        {active && ready && <BuildingHighlightsControl key={`buildings-${sceneMeta.id}-${attempt}`} available={glowAvailable} setEnabled={setBuildingsEnabled} setCategory={setGlowCategory} />}
        {!loading && streamStatus && <span className="splat-detail-status" role="status">
          LOD {streamStatus.bestLod ?? 3} · {streamStatus.failed ? 'Some detail unavailable' : streamStatus.pending ? 'Refining…' : 'Ready'}
          {streamStatus.failed > 0 && <button type="button" className="secondary" onClick={() => sessionRef.current?.retryDetail()}>Retry detail</button>}
        </span>}
        <button type="button" className="primary" autoFocus onClick={() => close()}>← Back to Map</button>
        {active && ready && urbanOpen && <UrbanPanel scene={sceneMeta} onChange={updateUrban} />}
      </aside>
      {loading && <div className="splat-message" role="status"><p>{status}</p><progress max={1} value={progress} /></div>}
      {error && <div className="splat-message" role="alert"><p>Unable to load this 3D scene: {error}</p><button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>}
      {mapVisible && !loading && !error && <div className="splat-map-status" role="status" data-map-status={mapStatus}>
        {mapStatus === 'loading' ? 'Loading satellite map…' : mapStatus === 'ready' ? 'Satellite map · imagery aligned' : <><span>Satellite map unavailable</span> <button type="button" onClick={() => sessionRef.current?.reloadMap()}>Retry map</button></>}
      </div>}
      <div className="splat-help">Drag to orbit · right-drag to pan · scroll to zoom · Esc to return</div>
      <a className="splat-attribution" href="https://huggingface.co/jayinnn/Skyfall-GS-ply" target="_blank" rel="noreferrer">Skyfall-GS models · Apache-2.0</a>
      {mapVisible && mapStatus === 'ready' && <span className="splat-map-attribution">{WORLD_IMAGERY_ATTRIBUTION}</span>}
    </div>
  );
}
