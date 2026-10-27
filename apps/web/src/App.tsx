/**
 * The application shell.
 *
 * The explorer shares a geographic camera between 2D, local 3D and zoom-out
 * Earth views, with registered splat scenes opened from geographic footprints.
 * Legacy satellite analysis helpers are retained below but not mounted here.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  IDLE_PROGRESS,
  IDLE_COMPARE,
  MapScene,
  type MapStats,
  type MapStatus,
  type PixelInspection,
  type CompareState,
} from './app/MapScene';
import { selectFramesForView, pickComparisonPair } from './app/comparePlan';
import { MISSION_START, searchView } from './app/sceneSearch';
import { RasterClient, RasterError } from './data/RasterClient';
import { Basemap, BASEMAP_ATTRIBUTION } from './map/Basemap';
import { SplatFootprints } from './map/SplatFootprints';
import { hitSplatFootprint } from './map/splatFootprints';
import { MAX_ZOOM, MIN_ZOOM } from './map/MapCamera';
import { PlaceSearch, zoomForKind, type Place } from './ui/PlaceSearch';
import { Map3DView } from './map/Map3DView';
import { SplatView } from './splat/SplatView';
import { preloadSplatViewer } from './splat/preload';
import { SKYFALL_SCENES, selectionBounds, type GeoBounds, type ScreenPoint, type SplatSceneMeta } from './data/splatScenes';
import {
  BAND_LABELS,
  deltaLegend,
  ndviLegend,
  rampCssGradient,
  type RampBand,
} from './ui/ramps';
import type { GeographicView } from './map/navigation3D';
import type { RenderLayer, RenderSettings } from './gpu/RasterRenderer';
import type { DatasetConfig, RegionStatsResponse } from '@terrascope/contracts';

/** Comparison needs a view one granule can fill; wider views are mostly empty frames. */
const MIN_COMPARE_ZOOM = 10;

const LAYERS: Array<{ id: RenderLayer; label: string; icon: string; description: string }> = [
  { id: 'vegetation', label: 'Vegetation (Green / Gray)', icon: '🌿', description: 'Living vegetation in green (NDVI ≥ 0.25), non-vegetation in grayscale' },
  { id: 'ndvi', label: 'NDVI', icon: '📊', description: 'Normalized Difference Vegetation Index ramp (-1 to 1)' },
  { id: 'natural', label: 'Natural colour', icon: '🌍', description: 'True colour red, green, and blue bands' },
  { id: 'false', label: 'False colour (NIR)', icon: '🔴', description: 'Near-infrared, red, and green; vegetation appears red' },
  { id: 'band', label: 'Single band', icon: '🔍', description: 'Inspect individual spectral band stretched to full range' },
  { id: 'difference', label: 'NDVI difference', icon: '⇄', description: 'NDVI change between Date B and Date A across whole view' },
];

interface Dates {
  from: string;
  to: string;
}

interface SharedState {
  dates: Dates;
  view: { lon: number; lat: number; zoom: number };
  settings: Partial<RenderSettings>;
}

export function App(): React.JSX.Element {
  const initial = useRef(readSharedState());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<MapScene | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = new MapScene(canvas);
    const restored = initial.current;
    instance.setView({ lon: restored.view.lon, lat: restored.view.lat }, restored.view.zoom);
    instance.updateSettings(restored.settings);
    setScene(instance);
    void instance.init();
    return () => {
      setScene(null);
      instance.dispose();
    };
  }, []);

  return (
    <div className="app">
      <CanvasAndScene canvasRef={canvasRef} scene={scene} />
    </div>
  );
}

export function CanvasAndScene({
  canvasRef,
  scene,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scene: MapScene | null;
}): React.JSX.Element {
  const status = useSceneStatus(scene);
  const stats = useSceneStats(scene);
  const compare = useCompare(scene);
  const camera = useCamera(scene);
  const settings = useSceneSettings(scene);
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [inspection, setInspection] = useState<PixelInspection | null>(null);
  const [map3DEntry, setMap3DEntry] = useState<{ bounds: GeoBounds; center: { lon: number; lat: number }; orbit: { x: number; y: number }; orientation?: GeographicView['orientation'] } | null>(null);
  const last3DView = useRef<GeographicView | null>(null);
  const orbitDrag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const lastInspect = useRef(0);
  const [splatScene, setSplatScene] = useState<SplatSceneMeta | null>(null);
  const [showFootprints, setShowFootprints] = useState(false);
  const [hoveredSplat, setHoveredSplat] = useState<SplatSceneMeta | null>(null);
  const footprintPress = useRef<{ pointerId: number; x: number; y: number; scene: SplatSceneMeta } | null>(null);
  const [splatEntryBounds, setSplatEntryBounds] = useState<GeoBounds | null>(null);
  const [splatEntryOrientation, setSplatEntryOrientation] = useState<GeographicView['orientation']>();
  const [returningToMap, setReturningToMap] = useState(false);
  const finish3DHandoff = useCallback(() => { if (!returningToMap) setMap3DEntry(null); }, [returningToMap]);
  const finishMapReturn = useCallback(() => {
    if (returningToMap) { setSplatScene(null); setReturningToMap(false); }
  }, [returningToMap]);
  const [markMode, setMarkMode] = useState(false);
  const [, setMarkedBounds] = useState<GeoBounds | null>(null);
  const [aoiSelection, setAoiSelection] = useState<{ start: ScreenPoint; current: ScreenPoint } | null>(null);
  const marquee = useRef<{ pointerId: number; start: ScreenPoint; current: ScreenPoint } | null>(null);
  const selectionCamera = useRef<MapScene['camera'] | null>(null);

  useEffect(() => {
    // The published view can lag the live camera by a frame. A view notification
    // for the camera used to begin this gesture must not cancel that gesture.
    if (selectionCamera.current && scene?.camera !== selectionCamera.current) {
      setMarkedBounds(null);
      setAoiSelection(null);
      marquee.current = null;
      selectionCamera.current = null;
    }
  }, [camera, scene]);

  useEffect(() => {
    drag.current = null;
    footprintPress.current = null;
    setHoveredSplat(null);
    marquee.current = null;
    selectionCamera.current = null;
    setMarkedBounds(null);
    setAoiSelection(null);
    setMarkMode(false);
  }, [compare.active, !!map3DEntry]);

  useEffect(() => {
    const cancelSelection = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || splatScene) return;
      if (map3DEntry) {
        orbitDrag.current = null;
        if (last3DView.current) scene?.setView(last3DView.current.center, last3DView.current.zoom);
        setMap3DEntry(null);
      }
      footprintPress.current = null;
      setHoveredSplat(null);
      marquee.current = null;
      drag.current = null;
      setAoiSelection(null);
      setMarkedBounds(null);
      setMarkMode(false);
    };
    window.addEventListener('keydown', cancelSelection);
    return () => window.removeEventListener('keydown', cancelSelection);
  }, [splatScene, map3DEntry, scene]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>): ScreenPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) };
  };

  const openSplatScene = (target: SplatSceneMeta, view?: GeographicView): void => {
    if (!scene) return;
    preloadSplatViewer();
    // Use the live map viewport, preserving the geographic entry frame.
    setSplatEntryBounds(scene.viewBounds());
    setSplatEntryOrientation(view?.orientation);
    // Retain the live 3D canvas beneath the loading viewer until its first frame.
    if (!view) setMap3DEntry(null);
    setSplatScene(target);
    setHoveredSplat(null);
    footprintPress.current = null;
  };

  const footprintAt = (event: React.PointerEvent<HTMLCanvasElement>): SplatSceneMeta | undefined => {
    if (!showFootprints || !scene || compare.active || splatScene || markMode || event.shiftKey) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    return hitSplatFootprint(scene.camera, { width: rect.width, height: rect.height, dpr: 1 }, localPoint(event));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scene) return;
    const observer = new ResizeObserver(() => {
      footprintPress.current = null;
      setHoveredSplat(null);
      scene.resize();
      setMarkedBounds(null);
      setAoiSelection(null);
      marquee.current = null;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef, scene]);

  useEffect(() => {
    if (!compare.active) setInspection(null);
  }, [compare.active]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.isPrimary && (event.button === 1 || event.button === 2) && scene && !compare.active && !splatScene) {
      event.preventDefault();
      orbitDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0 || !event.isPrimary) return;
    footprintPress.current = null;
    const target = footprintAt(event);
    if (target) {
      preloadSplatViewer();
      footprintPress.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scene: target };
    }
    setHoveredSplat(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!compare.active && (event.shiftKey || markMode)) {
      const start = localPoint(event);
      selectionCamera.current = scene?.camera ?? null;
      marquee.current = { pointerId: event.pointerId, start, current: start };
      setAoiSelection({ start, current: start });
      setMarkedBounds(null);
      return;
    }
    drag.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!event.isPrimary) return;
    const orbiting = orbitDrag.current;
    if (orbiting && scene && orbiting.pointerId === event.pointerId) {
      const orbit = { x: event.clientX - orbiting.x, y: event.clientY - orbiting.y };
      if (Math.hypot(orbit.x, orbit.y) > 4) {
        if (!map3DEntry) last3DView.current = { center: { ...scene.camera.center }, zoom: scene.camera.zoom };
        setMap3DEntry(current => current ? { ...current, orbit }
          : { bounds: scene.viewBounds(), center: { ...scene.camera.center }, orbit });
      }
      return;
    }
    const press = footprintPress.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) footprintPress.current = null;
    const start = drag.current;
    if (!scene) return;
    if (marquee.current) {
      if (marquee.current.pointerId !== event.pointerId) return;
      marquee.current.current = localPoint(event);
      setAoiSelection({ start: marquee.current.start, current: marquee.current.current });
      return;
    }
    if (start) {
      scene.panByPixels(event.clientX - start.x, event.clientY - start.y);
      drag.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const target = footprintAt(event);
    if (target && target.id !== hoveredSplat?.id) preloadSplatViewer();
    setHoveredSplat(target ?? null);
    if (!compare.active) return;
    const now = performance.now();
    if (now - lastInspect.current < 80) return;
    lastInspect.current = now;
    const rect = event.currentTarget.getBoundingClientRect();
    setInspection(scene.inspectPixel(event.clientX - rect.left, event.clientY - rect.top));
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!event.isPrimary) return;
    if (orbitDrag.current?.pointerId === event.pointerId) {
      orbitDrag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const selection = marquee.current;
    if (selection && selection.pointerId !== event.pointerId) return;
    const press = footprintPress.current;
    const openFootprint = event.type === 'pointerup' && !selection && press?.pointerId === event.pointerId
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 5 && footprintAt(event)?.id === press.scene.id;
    footprintPress.current = null;
    if (selection && scene && event.type === 'pointerup') {
      const end = localPoint(event);
      if (Math.abs(end.x - selection.start.x) >= 4 && Math.abs(end.y - selection.start.y) >= 4) {
        const rect = event.currentTarget.getBoundingClientRect();
        setMarkedBounds(selectionBounds(scene.camera, { width: rect.width, height: rect.height, dpr: 1 }, selection.start, end));
        setAoiSelection({ start: selection.start, current: end });
      } else setAoiSelection(null);
      setMarkMode(false);
    } else if (selection) setAoiSelection(null);
    marquee.current = null;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (openFootprint && press) openSplatScene(press.scene);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!scene || marquee.current) return;
    footprintPress.current = null;
    setHoveredSplat(null);
    const rect = event.currentTarget.getBoundingClientRect();
    scene.zoomAroundPixels(event.deltaY, event.clientX - rect.left, event.clientY - rect.top);
  };

  const explorer2d = !compare.active && !splatScene && !map3DEntry;
  const isDifference = settings?.layer === 'difference';
  const showSwipeSeam = compare.active && !map3DEntry && !isDifference && settings?.swipeEnabled;

  return (
    <div className={`canvas-wrap${splatScene ? ' splat-active' : ''}${map3DEntry ? ' map3d-active' : ''}`} ref={containerRef}>
      <div className={`map-view-2d${map3DEntry || (splatScene && splatEntryOrientation) ? ' inactive' : ''}`}>
        {scene && <Basemap scene={scene} />}
        <canvas
          ref={canvasRef}
          className={compare.active ? 'map science' : `map${markMode ? ' marking' : ''}${showFootprints && hoveredSplat && !markMode ? ' over-splat' : ''}`}
          title={showFootprints && hoveredSplat ? `Open ${hoveredSplat.name} in 3D` : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onPointerLeave={() => setHoveredSplat(null)}
          onWheel={onWheel}
          onContextMenu={event => event.preventDefault()}
        />
        {explorer2d && showFootprints && scene && <SplatFootprints view={scene.view} hoveredId={hoveredSplat?.id ?? null} onOpen={openSplatScene} />}
        {aoiSelection && explorer2d && <div className="aoi-marquee" aria-hidden="true" style={{
          left: Math.min(aoiSelection.start.x, aoiSelection.current.x),
          top: Math.min(aoiSelection.start.y, aoiSelection.current.y),
          width: Math.abs(aoiSelection.current.x - aoiSelection.start.x),
          height: Math.abs(aoiSelection.current.y - aoiSelection.start.y),
        }} />}
      </div>
      {map3DEntry && <Map3DView bounds={map3DEntry.bounds} center={map3DEntry.center} orbit={map3DEntry.orbit} orientation={map3DEntry.orientation} showFootprints={showFootprints} onReady={finishMapReturn}
        onViewChange={view => { last3DView.current = view; }}
        onOpenFootprint={(target, view) => { scene?.setView(view.center, view.zoom); openSplatScene(target, view); }} />}
      {splatScene && <SplatView key={splatScene.id} active sceneMeta={splatScene} entryBounds={splatEntryBounds!} entryOrientation={splatEntryOrientation} onReady={finish3DHandoff} onClose={(view, destination = 'map') => {
        if (returningToMap) return;
        if (view) scene?.setView(view.center, view.zoom);
        if (destination === '2d') {
          setMap3DEntry(null); setSplatScene(null);
        } else if (!view && map3DEntry) {
          // Loading was cancelled: the original live map still has its camera.
          setSplatScene(null);
        } else if (scene) {
          const current = view ?? { center: scene.camera.center, zoom: scene.camera.zoom, orientation: splatEntryOrientation };
          last3DView.current = current;
          setMap3DEntry({ bounds: scene.viewBounds(), center: current.center, orbit: { x: 0, y: 0 }, orientation: current.orientation });
          setReturningToMap(true);
        }
      }} />}
      {!splatScene && <aside className="map-controls-panel" aria-label="Map controls">
        <header><strong>TerraScope</strong><span>Map &amp; 3D explorer</span></header>
        {scene && <PlaceSearch near={camera.center} onPick={place => {
          setMap3DEntry(null);
          if (place.bounds) scene.fitBounds(place.bounds);
          else scene.setView({ lon: place.lon, lat: place.lat }, zoomForKind(place.kind));
        }} />}
        <button type="button" className="map-camera-toggle" role="switch" aria-label="3D view" aria-checked={!!map3DEntry}
          disabled={!scene} onClick={() => {
            if (!scene) return;
            if (map3DEntry) {
              if (last3DView.current) scene.setView(last3DView.current.center, last3DView.current.zoom);
              setMap3DEntry(null);
            } else {
              last3DView.current = { center: { ...scene.camera.center }, zoom: scene.camera.zoom };
              setMap3DEntry({ bounds: scene.viewBounds(), center: { ...scene.camera.center }, orbit: { x: 0, y: 0 } });
            }
          }}><span>2D</span><span className="camera-toggle-track"><span /></span><span>3D</span></button>
        <p className="map-orbit-hint">Right-drag or middle-drag to orbit.</p>
        <select className="urban-scene-select" aria-label="Choose 3D scene" value="" onFocus={preloadSplatViewer} onChange={event => {
          const target = SKYFALL_SCENES.find(candidate => candidate.id === event.target.value);
          if (!target || !scene) return;
          scene.fitBounds(target.bounds); openSplatScene(target);
        }}>
          <option value="" disabled>Choose 3D scene…</option>
          {SKYFALL_SCENES.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>

      <button
        type="button"
        className="map-mode-toggle footprints-toggle"
        aria-pressed={showFootprints}
        aria-label="3D Footprints"
        title={showFootprints ? 'Hide 3D coverage'
          : map3DEntry ? 'Show registered 3D scene boundaries' : 'Show 3D coverage · click a green area to open'}
        disabled={!scene}
        onClick={() => {
          setShowFootprints((current) => !current);
          setHoveredSplat(null);
          footprintPress.current = null;
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 10 9-5M12 13 3 8m9 5v8" />
        </svg>
        3D Footprints
      </button>
      </aside>}


      {status.phase === 'error' && (
        <div className="banner error">
          <p>{status.message}</p>
          <p className="hint">
            The map works without it, but comparison frames are processed on the GPU. On Linux, Chrome usually needs
            <code> --enable-unsafe-webgpu</code> or <code> --enable-features=Vulkan</code>.
          </p>
        </div>
      )}

      {/* Floating date badges on map during comparison */}
      {compare.active && !map3DEntry && compare.a && compare.b && (
        <>
          <div className="swipe-map-badge left">
            <span className="badge-tag">◀ Left Scene (Date A)</span>
            <strong>{compare.a.datetime.slice(0, 10)}</strong>
            {compare.a.cloudCover != null && (
              <span className="dim">{Math.round(compare.a.cloudCover)}% cloud</span>
            )}
          </div>
          <div className="swipe-map-badge right">
            <span className="badge-tag">Right Scene (Date B) ▶</span>
            <strong>{compare.b.datetime.slice(0, 10)}</strong>
            {compare.b.cloudCover != null && (
              <span className="dim">{Math.round(compare.b.cloudCover)}% cloud</span>
            )}
          </div>
        </>
      )}

      {/* Draggable swipe divider on map */}
      {showSwipeSeam && settings && scene && (
        <SwipeDivider
          swipe={settings.swipe}
          onSwipeChange={(fraction) => scene.setSwipe(fraction)}
          containerRef={containerRef}
        />
      )}

      {/* HUD overlay */}
      <div className="hud">
        {compare.active && (
          <div className="compare-status-hud">
            {stats.neededTiles > 0 && stats.neededDone < stats.neededTiles ? (
              <span className="loading-pill">⚡ Streaming tiles ({stats.neededDone}/{stats.neededTiles})…</span>
            ) : (
              <span className="ready-pill">✓ Ready</span>
            )}
          </div>
        )}
        <div className="hud-row">
          <span>
            {camera.zoom.toFixed(2)}z · {camera.center.lat.toFixed(4)}, {camera.center.lon.toFixed(4)}
          </span>
          {compare.active && (
            <span className="mode-chip compare">
              ⇄ Swipe Comparison Mode
            </span>
          )}
          {!compare.active && (
            <span className="mode-chip explore">
              ● Explore Mode
            </span>
          )}
          {stats.failed > 0 && (
            <span className="warn" title={stats.lastTileError ?? undefined}>
              {stats.failed} unavailable{stats.lastTileError ? ' · retrying' : ''}
            </span>
          )}
          {compare.active && stats.firstImageMs != null && (
            <span>first frame {(stats.firstImageMs / 1000).toFixed(2)} s</span>
          )}
          <span className="attribution">{compare.active ? (compare.a?.attribution ?? '') : BASEMAP_ATTRIBUTION}</span>
        </div>
      </div>

      {inspection && <PixelReadout value={inspection} top />}
    </div>
  );
}

/**
 * Interactive vertical swipe divider handle overlaid on the map canvas.
 */
function SwipeDivider({
  swipe,
  onSwipeChange,
  containerRef,
}: {
  swipe: number;
  onSwipeChange: (fraction: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const isDragging = useRef(false);

  const updateFromPointer = (clientX: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSwipeChange(fraction);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    updateFromPointer(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!isDragging.current) return;
    e.stopPropagation();
    updateFromPointer(e.clientX);
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!isDragging.current) return;
    e.stopPropagation();
    isDragging.current = false;
  };

  return (
    <div
      className="swipe-divider-wrap"
      style={{ left: `${swipe * 100}%` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="swipe-line" />
      <div className="swipe-handle" title="Drag to swipe between scenes">
        <span className="swipe-arrow">◀</span>
        <span className="swipe-bar">❚❚</span>
        <span className="swipe-arrow">▶</span>
      </div>
    </div>
  );
}

function PixelReadout({ value, top }: { value: PixelInspection; top: boolean }): React.JSX.Element {
  return (
    <div className={top ? 'pixel-readout top' : 'pixel-readout'}>
      <strong>{value.status}</strong> · {value.lat.toFixed(5)}, {value.lon.toFixed(5)}
      {value.date && <><br />Scene date: <strong>{value.date.slice(0, 10)}</strong></>}
      {value.status === 'valid' && (
        <><br />R {value.red?.toFixed(4)} · G {value.green?.toFixed(4)} · B {value.blue?.toFixed(4)} · NIR {value.nir?.toFixed(4)} · <strong>NDVI {value.ndvi?.toFixed(4)}</strong></>
      )}
      {value.status === 'masked' && <><br />Excluded by cloud/quality mask</>}
    </div>
  );
}

export function Sidebar({
  scene,
  dates,
  onDatesChange,
}: {
  scene: MapScene | null;
  dates: Dates;
  onDatesChange: (next: Dates) => void;
}): React.JSX.Element {
  const [client] = useState(() => new RasterClient());
  const [config, setConfig] = useState<DatasetConfig | null>(null);
  const [maxCloud, setMaxCloud] = useState<number>(50);
  const searchRun = useRef(0);
  const [finding, setFinding] = useState<{ busy: boolean; message: string | null; error: boolean }>({
    busy: false,
    message: null,
    error: false,
  });
  const compare = useCompare(scene);
  const camera = useCamera(scene);
  const settings = useSceneSettings(scene);
  const stats = useSceneStats(scene);

  useEffect(() => {
    const controller = new AbortController();
    void client.config(controller.signal).then(setConfig).catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    if (!compare.active) {
      setFinding((f) => (f.error ? f : { busy: f.busy, message: null, error: false }));
    }
  }, [compare.active]);

  const goTo = (place: Place): void => {
    if (!scene) return;
    if (place.bounds) scene.fitBounds(place.bounds);
    else scene.setView({ lon: place.lon, lat: place.lat }, zoomForKind(place.kind));
  };

  /**
   * Compare scenes: find acquisitions covering the view in the date range,
   * pick 2 scenes closest to `dates.from` and `dates.to`, and start the comparison.
   */
  const startCompareMode = async (): Promise<void> => {
    if (!scene) return;
    const view = scene.viewBounds();
    const { center, zoom } = scene.camera;
    setFinding({ busy: true, message: 'Searching scenes for this view…', error: false });
    try {
      const run = ++searchRun.current;
      const { scenes, truncatedMonths, searched } = await searchView(
        client,
        view,
        dates.from,
        dates.to,
        (done, total) => {
          if (total > 1 && run === searchRun.current) {
            setFinding({ busy: true, message: `Searching scenes… ${done}/${total} months`, error: false });
          }
        },
      );
      if (!searched) {
        setFinding({
          busy: false,
          error: true,
          message: `Sentinel-2 data starts on ${MISSION_START}; pick dates from then to today.`,
        });
        return;
      }
      const selection = selectFramesForView(scenes, view, maxCloud);
      const frames = selection.frames;
      const skipped = [
        selection.partial > 0 ? `${selection.partial} only partly imaged this view` : '',
      ].filter(Boolean).join(', ');

      if (frames.length < 2) {
        setFinding({
          busy: false,
          error: true,
          message: `Need at least 2 complete scenes for this view between ${dates.from} and ${dates.to} with <=${maxCloud}% clouds (found ${frames.length}${skipped ? `, skipped: ${skipped}` : ''}). Try increasing the cloud limit, moving the view, or widening the dates.`,
        });
        return;
      }

      const pair = pickComparisonPair(frames, dates.from, dates.to);
      if (!pair) {
        setFinding({
          busy: false,
          error: true,
          message: `Could not pick 2 distinct dates from the search results. Try widening the date range.`,
        });
        return;
      }

      scene.setView(center, zoom);
      scene.startCompare(pair);

      let note = `Comparing ${pair.a.datetime.slice(0, 10)} (Left) vs ${pair.b.datetime.slice(0, 10)} (Right).`;
      if (pair.fromGapDays > 0 || pair.toGapDays > 0) {
        note += ` Nearest dates found (±${Math.max(pair.fromGapDays, pair.toGapDays)} days).`;
      }
      if (truncatedMonths.length > 0) {
        note += ` Search limit reached in ${truncatedMonths.join(', ')}.`;
      }
      setFinding({ busy: false, message: note, error: false });
    } catch (error) {
      setFinding({
        busy: false,
        error: true,
        message: error instanceof RasterError ? `${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error),
      });
    }
  };

  const swapScenes = (): void => {
    if (!scene || !compare.a || !compare.b) return;
    scene.startCompare({
      a: compare.b,
      b: compare.a,
      fromGapDays: compare.toGapDays,
      toGapDays: compare.fromGapDays,
    });
  };

  const tooWide = camera.zoom < MIN_COMPARE_ZOOM;

  return (
    <aside className="sidebar">
      <header>
        <h1>TerraScope</h1>
        <p className="tagline">Sentinel-2 on WebGPU, calibrated and read as measured.</p>
      </header>

      {/* 1. Explore Mode: Location Search */}
      {!compare.active && (
        <section>
          <h2>Location</h2>
          <PlaceSearch near={camera.center} onPick={goTo} />
          <p className="small dim">Or drag and scroll the map to frame the area of interest.</p>
        </section>
      )}

      {/* 2. Timeline / Swipe Mode Section */}
      <section>
        <h2>{compare.active ? 'Swipe Comparison' : 'Timeline (Swipe Mode)'}</h2>
        {compare.active ? (
          <>
            <div className="swipe-banner">
              <div className="title">
                <span>⇄ Swipe Mode Active</span>
                <button
                  type="button"
                  className="secondary mini-btn"
                  onClick={() => scene?.stopCompare()}
                >
                  ✕ Exit swipe
                </button>
              </div>
              <p className="small dim">
                Drag the divider on the map or adjust settings below to compare both scenes.
              </p>
            </div>

            {/* Selected Scenes Info Card */}
            <div className="comparison-card">
              <div className="scene-pill left">
                <span className="side-label">◀ Left Map</span>
                <strong>{compare.a?.datetime.slice(0, 10)}</strong>
                <span className="dim">
                  {compare.a?.cloudCover != null ? `${Math.round(compare.a.cloudCover)}% cloud` : 'cloud unknown'}
                </span>
                {compare.fromGapDays > 0 && (
                  <span className="dim small">±{compare.fromGapDays}d from {dates.from}</span>
                )}
                <span className={`status-pill ${compare.statusA}`}>
                  {compare.statusA === 'ready'
                    ? '✓ Ready'
                    : stats.neededTiles > 0
                    ? `⚡ Streaming ${stats.neededDone}/${stats.neededTiles}`
                    : '⚡ Streaming…'}
                </span>
              </div>

              <div className="scene-pill right">
                <span className="side-label">Right Map ▶</span>
                <strong>{compare.b?.datetime.slice(0, 10)}</strong>
                <span className="dim">
                  {compare.b?.cloudCover != null ? `${Math.round(compare.b.cloudCover)}% cloud` : 'cloud unknown'}
                </span>
                {compare.toGapDays > 0 && (
                  <span className="dim small">±{compare.toGapDays}d from {dates.to}</span>
                )}
                <span className={`status-pill ${compare.statusB}`}>
                  {compare.statusB === 'ready'
                    ? '✓ Ready'
                    : stats.neededTiles > 0
                    ? `⚡ Streaming ${stats.neededDone}/${stats.neededTiles}`
                    : '⚡ Streaming…'}
                </span>
              </div>
            </div>

            {/* Swipe Position Control */}
            {settings && (
              <div className="swipe-controls">
                <label>
                  Swipe divider: {Math.round(settings.swipe * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.swipe}
                    onChange={(e) => scene?.setSwipe(Number(e.target.value))}
                  />
                </label>
                <div className="swipe-presets">
                  <button
                    type="button"
                    className="secondary mini-btn"
                    onClick={() => scene?.setSwipe(0.25)}
                  >
                    25%
                  </button>
                  <button
                    type="button"
                    className="secondary mini-btn"
                    onClick={() => scene?.setSwipe(0.5)}
                  >
                    50% (Center)
                  </button>
                  <button
                    type="button"
                    className="secondary mini-btn"
                    onClick={() => scene?.setSwipe(0.75)}
                  >
                    75%
                  </button>
                  <button
                    type="button"
                    className="secondary mini-btn"
                    title="Swap left and right dates"
                    onClick={swapScenes}
                  >
                    ⇄ Swap
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="small dim">
              Select a date range. The app will automatically select and compare the 2 clearest scenes near those dates.
            </p>
            <div className="grid2">
              <label>
                From date
                <input
                  type="date"
                  value={dates.from}
                  min={MISSION_START}
                  max={dates.to}
                  onChange={(e) => onDatesChange({ ...dates, from: e.target.value })}
                />
              </label>
              <label>
                To date
                <input
                  type="date"
                  value={dates.to}
                  min={dates.from}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => onDatesChange({ ...dates, to: e.target.value })}
                />
              </label>
            </div>
            <label>
              Cloud filter (scene)
              <select value={maxCloud} onChange={(e) => setMaxCloud(Number(e.target.value))}>
                <option value={20}>Under 20% clouds (Very clear)</option>
                <option value={40}>Under 40% clouds</option>
                <option value={50}>Under 50% clouds (Default)</option>
                <option value={70}>Under 70% clouds</option>
                <option value={100}>Any (include cloudy scenes)</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={!scene || finding.busy || tooWide}
              onClick={() => void startCompareMode()}
            >
              {finding.busy ? 'Searching scenes…' : '▶ Compare scenes (Swipe)'}
            </button>
            {tooWide ? (
              <p className="small dim">Zoom in to level {MIN_COMPARE_ZOOM} or closer to compare scenes for this view.</p>
            ) : (
              <p className="small dim">Loads the 2 nearest acquisitions covering this view and opens swipe comparison.</p>
            )}
            {finding.message && (
              <p className={finding.error ? 'error small' : 'small dim'}>{finding.message}</p>
            )}
          </>
        )}
      </section>

      {/* Right-side panel settings (active in swipe mode or explore) */}
      {scene && compare.active && (
        <SettingsAndAnalysis
          scene={scene}
          compare={compare}
          dates={dates}
          client={client}
          config={config}
        />
      )}

      <GpuFooter scene={scene} />
      <PerformancePanel scene={scene} />
    </aside>
  );
}

/** Layer settings, display adjustments, legend and area analysis. */
function SettingsAndAnalysis({
  scene,
  compare,
  dates,
  client,
  config,
}: {
  scene: MapScene;
  compare: CompareState;
  dates: Dates;
  client: RasterClient;
  config: DatasetConfig | null;
}): React.JSX.Element {
  const settings = useSceneSettings(scene);
  const layer = settings?.layer ?? 'vegetation';
  const [analysis, setAnalysis] = useState<{ busy: boolean; error: string | null; value: RegionStatsResponse | null }>({
    busy: false,
    error: null,
    value: null,
  });
  const [resolutionM, setResolutionM] = useState(100);
  const currentScene = compare.a || compare.b;

  const runAnalysis = async (): Promise<void> => {
    if (!currentScene || !config) return;
    const view = scene.viewBounds();
    setAnalysis({ busy: true, error: null, value: null });
    try {
      const value = await client.regionStats({
        collection: currentScene.collection,
        sceneA: compare.a?.id ?? currentScene.id,
        sceneB: compare.b?.id,
        bbox: [view.west, view.south, view.east, view.north],
        resolutionM,
        qualityPolicy: config.qualityPolicy,
      });
      setAnalysis({ busy: false, error: null, value });
    } catch (error) {
      setAnalysis({ busy: false, value: null, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <>
      <section>
        <h2>Map Layer</h2>
        <div className="layers">
          {LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip${l.id === 'vegetation' ? ' vegetation-chip' : ''}${l.id === layer ? ' selected' : ''}`}
              title={l.description}
              onClick={() => scene.updateSettings({ layer: l.id })}
            >
              {l.icon} {l.label}
            </button>
          ))}
        </div>

        {layer === 'vegetation' && (
          <p className="small dim">
            Highlights living vegetation in green (NDVI ≥ 0.25). Drag the swipe divider to compare vegetation between the two dates!
          </p>
        )}

        {layer === 'band' && (
          <label>
            Band
            <select
              value={settings?.band ?? 'nir'}
              onChange={(e) => scene.updateSettings({ band: e.target.value as RampBand })}
            >
              {(Object.keys(BAND_LABELS) as RampBand[]).map((b) => (
                <option key={b} value={b}>{BAND_LABELS[b]}</option>
              ))}
            </select>
          </label>
        )}

        <label>
          Brightness: {settings?.exposure.toFixed(2)}
          <input
            type="range"
            min={0.4}
            max={2.5}
            step={0.05}
            value={settings?.exposure ?? 1}
            onChange={(e) => scene.updateSettings({ exposure: Number(e.target.value) })}
          />
        </label>

        <label>
          Gamma: {settings?.gamma.toFixed(2)}
          <input
            type="range"
            min={0.4}
            max={2.2}
            step={0.05}
            value={settings?.gamma ?? 1}
            onChange={(e) => scene.updateSettings({ gamma: Number(e.target.value) })}
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings?.qualityMask ?? true}
            onChange={(e) => scene.updateSettings({ qualityMask: e.target.checked })}
          />
          Apply cloud and quality mask
        </label>

        {layer === 'ndvi' && (
          <div className="grid2">
            <label>
              NDVI min
              <input
                type="number"
                min={-1}
                max={0.99}
                step={0.05}
                value={settings?.ndviMin ?? -1}
                onChange={(e) => scene.updateSettings({ ndviMin: Number(e.target.value) })}
              />
            </label>
            <label>
              NDVI max
              <input
                type="number"
                min={-0.99}
                max={1}
                step={0.05}
                value={settings?.ndviMax ?? 1}
                onChange={(e) => scene.updateSettings({ ndviMax: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
      </section>

      <section>
        <h2>Legend</h2>
        <Legend layer={layer} />
        <button type="button" className="secondary" onClick={() => void copyShareUrl(scene, dates)}>
          🔗 Copy share link
        </button>
      </section>

      <section>
        <h2>Vegetation &amp; Area Statistics</h2>
        <p className="small dim">
          Compare NDVI statistics across the current view between {compare.a?.datetime.slice(0, 10)} and {compare.b?.datetime.slice(0, 10)}.
        </p>
        <label>
          Analysis resolution: {resolutionM} m
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            value={resolutionM}
            onChange={(e) => setResolutionM(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!config || analysis.busy}
          onClick={() => void runAnalysis()}
        >
          {analysis.busy ? 'Analysing…' : 'Analyse this view'}
        </button>
        {analysis.error && <p className="error small">{analysis.error}</p>}
        {analysis.value && <AnalysisSummary value={analysis.value} />}
      </section>
    </>
  );
}

function AnalysisSummary({ value }: { value: RegionStatsResponse }): React.JSX.Element {
  const metric = (v: number | null): string => (v == null ? '—' : v.toFixed(4));
  return (
    <div className="analysis-summary small">
      <p>{value.commonValidCount.toLocaleString()} common valid samples · {(value.validCoverageFraction * 100).toFixed(1)}% coverage</p>
      <p>Mean NDVI A: <strong>{metric(value.meanNdviA)}</strong> · B: <strong>{metric(value.meanNdviB)}</strong> · Δ: <strong>{metric(value.meanDelta)}</strong></p>
      {value.fractionBelowThreshold != null && (
        <p>{(value.fractionBelowThreshold * 100).toFixed(1)}% show an NDVI decrease above threshold.</p>
      )}
      <div className="button-row">
        <button type="button" className="secondary mini-btn" onClick={() => downloadAnalysis(value, 'json')}>
          Export JSON
        </button>
        <button type="button" className="secondary mini-btn" onClick={() => downloadAnalysis(value, 'csv')}>
          Export CSV
        </button>
      </div>
    </div>
  );
}

function downloadAnalysis(value: RegionStatsResponse, format: 'json' | 'csv'): void {
  const content = format === 'json'
    ? JSON.stringify(value, null, 2)
    : [
        'sample_count,common_valid_count,valid_coverage,mean_ndvi_a,mean_ndvi_b,mean_delta,fraction_above_threshold,fraction_below_threshold',
        [
          value.sampleCount,
          value.commonValidCount,
          value.validCoverageFraction,
          value.meanNdviA ?? '',
          value.meanNdviB ?? '',
          value.meanDelta ?? '',
          value.fractionAboveThreshold ?? '',
          value.fractionBelowThreshold ?? '',
        ].join(','),
      ].join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `terrascope-comparison-analysis.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Legend({ layer }: { layer: RenderLayer }): React.JSX.Element | null {
  if (layer === 'vegetation') {
    return (
      <div className="legend vegetation-legend">
        <div className="veg-legend-items">
          <span className="veg-badge green-badge">● Living Vegetation (NDVI ≥ 0.25)</span>
          <span className="veg-badge gray-badge">● Non-Living / Bare Soil / Built (&lt; 0.25)</span>
        </div>
      </div>
    );
  }
  if (layer === 'ndvi') {
    return <RampLegend kind="ndvi" entries={ndviLegend()} />;
  }
  if (layer === 'difference') {
    return <RampLegend kind="delta" entries={deltaLegend()} />;
  }
  if (layer === 'band') {
    return (
      <p className="small dim">
        One band stretched to full range. Lighter pixels represent higher reflectance.
      </p>
    );
  }
  return null;
}

function RampLegend({
  kind,
  entries,
}: {
  kind: 'ndvi' | 'delta';
  entries: Array<{ label: string; colour: string }>;
}): React.JSX.Element {
  return (
    <div className="legend">
      <div className="ramp" style={{ background: rampCssGradient(kind) }} />
      <div className="ticks">
        {entries.map((e) => (
          <span key={e.label} className="tick">
            <i style={{ background: e.colour }} />
            {e.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function GpuFooter({ scene }: { scene: MapScene | null }): React.JSX.Element | null {
  const info = useGpuInfo(scene);
  if (!info) return null;
  return (
    <footer className="gpu">
      <span className="dim small">
        WebGPU: {info.vendor || 'GPU'} · {info.architecture || info.device || 'adapter active'}
      </span>
    </footer>
  );
}

function PerformancePanel({ scene }: { scene: MapScene | null }): React.JSX.Element {
  const stats = useSceneStats(scene);
  return (
    <details className="performance">
      <summary>Performance &amp; Diagnostics</summary>
      <p className="small dim">Frame {stats.lastFrameMs.toFixed(2)} ms · GPU/CPU estimate {(stats.bytes / 1048576).toFixed(1)} MiB</p>
      <p className="small dim">
        {stats.requests} tile requests · {(stats.downloadedBytes / 1048576).toFixed(2)} MiB transferred · {stats.decodeMs.toFixed(1)} ms decode · {stats.cacheHits} cache hits
      </p>
    </details>
  );
}

// ---- scene hooks ----------------------------------------------------------

function useSceneStatus(scene: MapScene | null): MapStatus {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  return useSyncExternalStore(
    subscribe,
    () => scene?.status ?? IDLE_STATUS,
    () => IDLE_STATUS,
  );
}

function useSceneStats(scene: MapScene | null): MapStats {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  return useSyncExternalStore(
    subscribe,
    () => scene?.stats ?? IDLE_STATS,
    () => IDLE_STATS,
  );
}

function useGpuInfo(scene: MapScene | null): MapScene['gpuInfo'] {
  useSceneStats(scene);
  return scene?.gpuInfo ?? null;
}

function useCamera(scene: MapScene | null): { zoom: number; center: { lon: number; lat: number } } {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  const view = useSyncExternalStore(subscribe, () => scene?.view ?? null, () => null);
  return view?.camera ?? IDLE_CAMERA;
}

const IDLE_CAMERA = { zoom: 0, center: { lon: 0, lat: 0 } };

function useCompare(scene: MapScene | null): CompareState {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  return useSyncExternalStore(
    subscribe,
    () => scene?.compare ?? IDLE_COMPARE,
    () => IDLE_COMPARE,
  );
}

function useSceneSettings(scene: MapScene | null): RenderSettings | null {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  return useSyncExternalStore(
    subscribe,
    () => scene?.settings ?? null,
    () => null,
  );
}

/** The last 90 days, ending today (UTC), as YYYY-MM-DD. */
function defaultDates(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

function readSharedState(): SharedState {
  const defaults = defaultDates();
  const fallback: SharedState = {
    dates: { ...defaults },
    view: { lon: -121.3, lat: 38.1, zoom: 11 },
    settings: { layer: 'vegetation' },
  };
  if (typeof location === 'undefined') return fallback;
  const p = new URLSearchParams(location.search);
  const number = (name: string, value: number, min: number, max: number): number => {
    const raw = p.get(name);
    if (raw == null || raw.trim() === '') return value;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
  };
  const isDate = (value: string | null): value is string => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');
  const layers: RenderLayer[] = ['vegetation', 'ndvi', 'natural', 'false', 'band', 'difference'];
  const bands: RampBand[] = ['red', 'green', 'blue', 'nir'];
  const layer = p.get('layer') as RenderLayer | null;
  const band = p.get('band') as RampBand | null;
  return {
    dates: {
      from: isDate(p.get('from')) ? p.get('from')! : defaults.from,
      to: isDate(p.get('to')) ? p.get('to')! : defaults.to,
    },
    view: {
      lon: number('lon', -121.3, -180, 180),
      lat: number('lat', 38.1, -85.0511, 85.0511),
      zoom: number('z', 11, MIN_ZOOM, MAX_ZOOM),
    },
    settings: {
      layer: layer && layers.includes(layer) ? layer : 'vegetation',
      ...(band && bands.includes(band) ? { band } : {}),
      gamma: number('gamma', 1, 0.4, 2.2),
      exposure: number('exposure', 1, 0.4, 2.5),
      swipe: number('divider', 0.5, 0, 1),
      qualityMask: p.get('quality') !== 'off',
      ndviMin: number('ndviMin', -1, -1, 0.99),
      ndviMax: number('ndviMax', 1, -0.99, 1),
    },
  };
}

async function copyShareUrl(scene: MapScene, dates: Dates): Promise<void> {
  const url = new URL(location.href);
  const { center, zoom } = scene.camera;
  const settings = scene.settings;
  const entries: Record<string, string> = {
    lon: center.lon.toFixed(6),
    lat: center.lat.toFixed(6),
    z: zoom.toFixed(3),
    from: dates.from,
    to: dates.to,
    layer: settings.layer,
    band: settings.band,
    gamma: String(settings.gamma),
    exposure: String(settings.exposure),
    divider: settings.swipe.toFixed(2),
    quality: settings.qualityMask ? 'on' : 'off',
    ndviMin: String(settings.ndviMin),
    ndviMax: String(settings.ndviMax),
  };
  url.search = '';
  for (const [key, value] of Object.entries(entries)) {
    if (value) url.searchParams.set(key, value);
  }
  await navigator.clipboard.writeText(url.toString());
  history.replaceState(null, '', url);
}

const IDLE_STATS: MapStats = {
  resident: 0,
  pending: 0,
  failed: 0,
  lastTileError: null,
  bytes: 0,
  zoom: 0,
  centre: { lon: 0, lat: 0 },
  lastFrameMs: 0,
  requests: 0,
  downloadedBytes: 0,
  decodeMs: 0,
  cacheHits: 0,
  firstImageMs: null,
  neededTiles: 0,
  neededDone: 0,
  inFlight: IDLE_PROGRESS,
};

const IDLE_STATUS: MapStatus = { phase: 'starting', message: 'Starting WebGPU…' };
