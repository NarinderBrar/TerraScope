/**
 * The application shell.
 *
 * Two states. Explore: a satellite basemap with place search and free pan and
 * zoom -- no scenes, no science requests. Timelapse: pressing Play finds every
 * acquisition covering the view in the chosen dates, locks the view, and
 * plays calibrated, cloud-masked frames processed by the raster service.
 *
 * Holds no imagery state. `MapScene` owns the camera, the GPU resources and the
 * frame loop; this reads snapshots from it and writes intent back through method
 * calls. Anything that changed on every frame would be a bug here, because
 * React would re-render on every frame to display it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  IDLE_PROGRESS,
  IDLE_TIMELAPSE,
  MapScene,
  type MapStats,
  type MapStatus,
  type PixelInspection,
  type TimelapseState,
} from './app/MapScene';
import { pickBySlots, selectFramesForView } from './app/timelapsePlan';
import { MISSION_START, searchView } from './app/sceneSearch';
import { RasterClient, RasterError } from './data/RasterClient';
import { Basemap, BASEMAP_ATTRIBUTION } from './map/Basemap';
import { MAX_ZOOM, MIN_ZOOM } from './map/MapCamera';
import { PlaceSearch, zoomForKind, type Place } from './ui/PlaceSearch';
import {
  BAND_LABELS,
  deltaLegend,
  ndviLegend,
  rampCssGradient,
  type RampBand,
} from './ui/ramps';
import type { RenderLayer, RenderSettings } from './gpu/RasterRenderer';
import type { DatasetConfig, RegionStatsResponse } from '@terrascope/contracts';

/** A timelapse needs a view one granule can fill; wider views are mostly empty frames. */
const MIN_TIMELAPSE_ZOOM = 10;
/** Frames held at once. Each is ~12 MB of GPU memory at the frame budget. */
const MAX_TIMELAPSE_FRAMES = 60;

const LAYERS: Array<{ id: RenderLayer; label: string }> = [
  { id: 'natural', label: 'Natural colour' },
  { id: 'false', label: 'False colour (NIR)' },
  { id: 'ndvi', label: 'NDVI' },
  { id: 'band', label: 'Single band' },
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
  const [dates, setDates] = useState<Dates>(initial.current.dates);

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
      <Sidebar scene={scene} dates={dates} onDatesChange={setDates} />
    </div>
  );
}

function CanvasAndScene({
  canvasRef,
  scene,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scene: MapScene | null;
}): React.JSX.Element {
  const status = useSceneStatus(scene);
  const stats = useSceneStats(scene);
  const timelapse = useTimelapse(scene);
  const camera = useCamera(scene);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [inspection, setInspection] = useState<PixelInspection | null>(null);
  const lastInspect = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scene) return;
    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef, scene]);

  // Readouts belong to frames; the basemap is a picture with nothing to read.
  useEffect(() => {
    if (!timelapse.active) setInspection(null);
  }, [timelapse.active]);

  // Pointer Events rather than mouse and touch listeners separately: the two
  // used to disagree about the capture target, and a pan that stops halfway on
  // a trackpad is very visible.
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = drag.current;
    if (!scene) return;
    if (start) {
      // The pointer's movement, so the map follows the hand: drag right and
      // the ground moves right (panBy shifts the centre the other way).
      scene.panByPixels(event.clientX - start.x, event.clientY - start.y);
      drag.current = { x: event.clientX, y: event.clientY };
      return;
    }
    if (!scene.timelapse.active) return;
    const now = performance.now();
    if (now - lastInspect.current < 80) return;
    lastInspect.current = now;
    const rect = event.currentTarget.getBoundingClientRect();
    setInspection(scene.inspectPixel(event.clientX - rect.left, event.clientY - rect.top));
  };
  const endDrag = (): void => {
    drag.current = null;
  };
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!scene) return;
    const rect = event.currentTarget.getBoundingClientRect();
    scene.zoomAroundPixels(event.deltaY, event.clientX - rect.left, event.clientY - rect.top);
  };

  return (
    <div className="canvas-wrap">
      {scene && <Basemap scene={scene} />}
      <canvas
        ref={canvasRef}
        // Transparent to the eye in explore mode, but still the element that
        // receives pan and zoom, so both states share one set of handlers.
        className={timelapse.active ? 'map science locked' : 'map'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      />
      {status.phase === 'error' && (
        <div className="banner error">
          <p>{status.message}</p>
          <p className="hint">
            The map works without it, but timelapse frames are processed on the GPU. On Linux, Chrome usually needs
            <code> --enable-unsafe-webgpu</code> or <code> --enable-features=Vulkan</code>.
          </p>
        </div>
      )}
      {scene && timelapse.active && <TimelapsePlayer scene={scene} state={timelapse} />}
      <div className="hud">
        {timelapse.active && <LoadingBars stats={stats} timelapse />}
        <div className="hud-row">
          <span>
            {camera.zoom.toFixed(2)}z · {camera.center.lat.toFixed(4)}, {camera.center.lon.toFixed(4)}
          </span>
          {stats.failed > 0 && (
            <span className="warn" title={stats.lastTileError ?? undefined}>
              {stats.failed} unavailable{stats.lastTileError ? ' · retrying' : ''}
            </span>
          )}
          {timelapse.active && stats.firstImageMs != null && (
            <span>first frame {(stats.firstImageMs / 1000).toFixed(2)} s</span>
          )}
          {timelapse.active && <span className="locked-chip">View locked</span>}
          <span className="attribution">{timelapse.active ? timelapse.frames[timelapse.index]?.attribution : BASEMAP_ATTRIBUTION}</span>
        </div>
      </div>
      {inspection && <PixelReadout value={inspection} top />}
    </div>
  );
}

function LoadingBars({ stats, timelapse }: { stats: MapStats; timelapse: boolean }): React.JSX.Element {
  const { neededTiles, neededDone, inFlight } = stats;
  const viewFraction = neededTiles > 0 ? neededDone / neededTiles : 0;
  const active = inFlight.waiting + inFlight.downloading;
  const byteFraction = inFlight.totalBytes > 0 ? inFlight.loadedBytes / inFlight.totalBytes : 0;
  const mib = (bytes: number): string => (bytes / 1048576).toFixed(2);
  let activeLabel = 'No requests in flight';
  if (inFlight.downloading > 0) {
    activeLabel = `Downloading ${inFlight.downloading} · ${mib(inFlight.loadedBytes)} / ${mib(inFlight.totalBytes)} MiB`;
  } else if (inFlight.waiting > 0) {
    const unit = timelapse ? 'frame' : 'tile';
    activeLabel = `Server building ${inFlight.waiting} ${unit}${inFlight.waiting === 1 ? '' : 's'} · ${((inFlight.oldestMs ?? 0) / 1000).toFixed(1)} s`;
  }
  if (inFlight.queued > 0) activeLabel += ` · ${inFlight.queued} queued`;
  return (
    <div className="loading-bars">
      <div className="loading-bar">
        <span className="label">{timelapse ? 'Timelapse frames' : 'Tiles for this view'}</span>
        <div className="track"><div className="fill" style={{ width: `${viewFraction * 100}%` }} /></div>
        <span className="value">{neededDone} / {neededTiles}</span>
      </div>
      <div className="loading-bar">
        <span className="label">Active requests</span>
        <div className={`track${inFlight.waiting > 0 && inFlight.downloading === 0 ? ' waiting' : ''}`}>
          <div className="fill" style={{ width: `${active > 0 ? byteFraction * 100 : 0}%` }} />
        </div>
        <span className="value">{activeLabel}</span>
      </div>
    </div>
  );
}

/**
 * Video-style controls for a locked-view timelapse. The strip under the scrub
 * bar is one segment per date: it fills as each frame arrives, and clicking a
 * segment removes that date from playback (click again to restore).
 */
function TimelapsePlayer({ scene, state }: { scene: MapScene; state: TimelapseState }): React.JSX.Element {
  const count = state.frames.length;
  const current = state.frames[state.index];
  const removed = state.excluded.filter(Boolean).length;
  const currentRemoved = state.excluded[state.index] ?? false;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (scene.timelapse.playing) scene.pause();
        else scene.play();
      } else if (event.code === 'ArrowRight') scene.seek(scene.timelapse.index + 1);
      else if (event.code === 'ArrowLeft') scene.seek(scene.timelapse.index - 1);
      else if (event.code === 'Delete' || event.code === 'Backspace') {
        event.preventDefault();
        scene.toggleFrame(scene.timelapse.index);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scene]);

  return (
    <div className="player">
      <button
        type="button"
        className="play"
        aria-label={state.playing ? 'Pause' : 'Play'}
        onClick={() => (state.playing ? scene.pause() : scene.play())}
      >
        {state.playing ? '❚❚' : '▶'}
      </button>
      <div className="scrub">
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          step={1}
          value={state.index}
          aria-label="Timelapse position"
          onChange={(e) => scene.seek(Number(e.target.value))}
        />
        <div className="buffer" role="group" aria-label="Dates: click to remove or restore">
          {state.status.map((s, i) => {
            const frame = state.frames[i];
            const off = state.excluded[i];
            const label = `${frame.datetime.slice(0, 10)} · ${cloudText(state, i)}${state.autoRemoved[i] ? ' · auto-removed (cloudy)' : ''}`;
            return (
              <button
                key={frame.id}
                type="button"
                className={`segment ${s}${off ? ' excluded' : ''}${i === state.index ? ' current' : ''}`}
                title={`${label} — click to ${off ? 'restore' : 'remove'}`}
                aria-label={`${label}, ${off ? 'removed, click to restore' : 'click to remove'}`}
                aria-pressed={off}
                onClick={() => scene.toggleFrame(i)}
              />
            );
          })}
        </div>
      </div>
      <span className="frame-date">
        <strong className={currentRemoved ? 'struck' : undefined}>{current?.datetime.slice(0, 10)}</strong> · {state.index + 1}/{count}
        {current && ` · ${cloudText(state, state.index)}`}
        {state.autoRemoved[state.index] && <span className="dim"> · auto-removed</span>}
        {removed > 0 && <span className="dim"> · {removed} removed</span>}
        {state.buffering && <span className="dim"> · buffering…</span>}
        {state.status[state.index] === 'failed' && <span className="warn"> · unavailable</span>}
      </span>
      <button
        type="button"
        className="secondary remove-date"
        title="Delete key"
        onClick={() => scene.toggleFrame(state.index)}
      >
        {currentRemoved ? 'Restore date' : 'Remove date'}
      </button>
      <select
        value={state.fps}
        aria-label="Playback speed"
        onChange={(e) => scene.setPlayback({ fps: Number(e.target.value) })}
      >
        {[1, 2, 4, 8, 12].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}
      </select>
      <label className="loop">
        <input type="checkbox" checked={state.loop} onChange={(e) => scene.setPlayback({ loop: e.target.checked })} />
        Loop
      </label>
    </div>
  );
}

/**
 * Cloud for one frame: measured over the view once the frame is loaded,
 * otherwise the catalog's granule-wide figure, labelled as such.
 */
function cloudText(state: TimelapseState, index: number): string {
  const view = state.viewCloud[index];
  if (view != null) return `${Math.round(view * 100)}% cloud in view`;
  const granule = state.frames[index]?.cloudCover;
  return granule != null ? `${granule.toFixed(0)}% cloud (scene)` : 'cloud unknown';
}

function PixelReadout({ value, top }: { value: PixelInspection; top: boolean }): React.JSX.Element {
  return (
    <div className={top ? 'pixel-readout top' : 'pixel-readout'}>
      <strong>{value.status}</strong> · {value.lat.toFixed(5)}, {value.lon.toFixed(5)}
      {value.date && <><br />{value.date.slice(0, 10)}</>}
      {value.status === 'valid' && (
        <><br />R {value.red?.toFixed(4)} · G {value.green?.toFixed(4)} · B {value.blue?.toFixed(4)} · NIR {value.nir?.toFixed(4)} · NDVI {value.ndvi?.toFixed(4)}</>
      )}
      {value.status === 'masked' && <><br />Excluded by validity/quality policy</>}
    </div>
  );
}


function Sidebar({
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
  const searchRun = useRef(0);
  const [finding, setFinding] = useState<{ busy: boolean; message: string | null; error: boolean }>({ busy: false, message: null, error: false });
  const timelapse = useTimelapse(scene);
  const camera = useCamera(scene);

  useEffect(() => {
    const controller = new AbortController();
    void client.config(controller.signal).then(setConfig).catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  // "19 dates found" describes the timelapse just left; it is noise in explore.
  useEffect(() => {
    if (!timelapse.active) setFinding((f) => (f.error ? f : { busy: f.busy, message: null, error: false }));
  }, [timelapse.active]);

  const goTo = (place: Place): void => {
    if (!scene) return;
    if (place.bounds) scene.fitBounds(place.bounds);
    else scene.setView({ lon: place.lon, lat: place.lat }, zoomForKind(place.kind));
  };

  /**
   * Play: collect every acquisition overlapping the view in the date range,
   * then hand them to the scene, which locks the view and loads frames. The
   * whole view is searched, not just its centre, because a view near a
   * granule edge needs the neighbouring granules of the same pass to be
   * complete; selectFrames groups them into one frame per date.
   */
  const play = async (): Promise<void> => {
    if (!scene) return;
    const view = scene.viewBounds();
    // Dates are chosen for this exact view, so this is the view frames must be
    // read for, even if the map is moved while the search runs.
    const { center, zoom } = scene.camera;
    setFinding({ busy: true, message: 'Finding dates…', error: false });
    try {
      const run = ++searchRun.current;
      const { scenes, truncatedMonths, searched } = await searchView(client, view, dates.from, dates.to, (done, total) => {
        // Only the latest search may report progress; a superseded or failed
        // one must not flip the button back to busy.
        if (total > 1 && run === searchRun.current) setFinding({ busy: true, message: `Finding dates… ${done}/${total} months`, error: false });
      });
      if (!searched) {
        setFinding({ busy: false, error: true, message: `Sentinel-2 data starts on ${MISSION_START}; pick dates from then to today.` });
        return;
      }
      // No cloud-cover filter: clouds are masked per pixel in every frame, and
      // a scene's cloud figure describes its whole ~110 km granule, not the
      // view -- a "71%" date can be clear where the user is looking.
      const selection = selectFramesForView(scenes, view, 100);
      let frames = selection.frames;
      const skipped = [
        selection.partial > 0 ? `${selection.partial} only partly imaged this view` : '',
      ].filter(Boolean).join(', ');
      if (frames.length === 0) {
        setFinding({
          busy: false,
          error: true,
          message: `No complete dates for this view between ${dates.from} and ${dates.to}${skipped ? ` (${skipped})` : ''}. Try moving the view slightly or widening the dates.`,
        });
        return;
      }
      let note = `${frames.length} date${frames.length === 1 ? '' : 's'} found.${skipped ? ` Skipped: ${skipped}.` : ''}`;
      if (frames.length > MAX_TIMELAPSE_FRAMES) {
        // Even time slots, clearest date in each: no uneven jumps, fewer clouds.
        const found = frames.length;
        // Slots span the dates that exist, not the dates asked for: a range
        // starting before the archive would otherwise leave half of them empty.
        frames = pickBySlots(frames, frames[0].datetime.slice(0, 10), frames[frames.length - 1].datetime.slice(0, 10), MAX_TIMELAPSE_FRAMES);
        note += ` Showing ${frames.length} of ${found}: the clearest date in each of ${MAX_TIMELAPSE_FRAMES} even time slots.`;
      }
      if (searched.from !== dates.from) {
        note += ` Sentinel-2 data starts on ${MISSION_START}, so the search began there.`;
      }
      if (truncatedMonths.length > 0) {
        note += ` Search limit reached in ${truncatedMonths.join(', ')}; some dates there may be missing.`;
      }
      scene.setView(center, zoom);
      scene.startTimelapse(frames);
      setFinding({ busy: false, message: note, error: false });
    } catch (error) {
      setFinding({
        busy: false,
        error: true,
        message: error instanceof RasterError ? `${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error),
      });
    }
  };

  const tooWide = camera.zoom < MIN_TIMELAPSE_ZOOM;
  const autoRemovedCount = timelapse.autoRemoved.filter(Boolean).length;
  return (
    <aside className="sidebar">
      <header>
        <h1>TerraScope</h1>
        <p className="tagline">Sentinel-2 on the GPU, read exactly as measured.</p>
      </header>

      {!timelapse.active && (
        <section>
          <h2>Location</h2>
          <PlaceSearch near={camera.center} onPick={goTo} />
          <p className="small dim">Or drag and scroll the map to frame the area.</p>
        </section>
      )}

      <section>
        <h2>Timelapse</h2>
        {timelapse.active ? (
          <>
            <p className="small">
              {timelapse.frames.length - timelapse.excluded.filter(Boolean).length} of {timelapse.frames.length} dates · {dates.from} → {dates.to}
            </p>
            {finding.message && <p className="small dim">{finding.message}</p>}
            <label>
              Auto-remove cloudy frames
              <select
                value={timelapse.autoCloud == null ? 'off' : String(timelapse.autoCloud)}
                onChange={(e) => scene?.setAutoCloud(e.target.value === 'off' ? null : Number(e.target.value))}
              >
                <option value="off">Off</option>
                <option value="0.5">More than 50% of the view cloudy</option>
                <option value="0.3">More than 30% of the view cloudy</option>
                <option value="0.1">More than 10% of the view cloudy</option>
              </select>
            </label>
            {autoRemovedCount > 0 && (
              <p className="small dim">{autoRemovedCount} cloudy frame{autoRemovedCount === 1 ? '' : 's'} removed, measured from each frame's own cloud mask. Click a hatched segment to bring one back.</p>
            )}
            <p className="small dim">View locked. Space plays and pauses; arrow keys step. Click a date segment under the timeline, or press Delete, to remove it.</p>
            <button type="button" className="secondary" onClick={() => scene?.stopTimelapse()}>
              Exit timelapse
            </button>
          </>
        ) : (
          <>
            <div className="grid2">
              <label>
                From
                <input type="date" value={dates.from} min={MISSION_START} max={dates.to} onChange={(e) => onDatesChange({ ...dates, from: e.target.value })} />
              </label>
              <label>
                To
                <input type="date" value={dates.to} min={dates.from} max={new Date().toISOString().slice(0, 10)} onChange={(e) => onDatesChange({ ...dates, to: e.target.value })} />
              </label>
            </div>
            <button type="button" className="primary" disabled={!scene || finding.busy || tooWide} onClick={() => void play()}>
              {finding.busy ? 'Finding dates…' : '▶ Play timelapse'}
            </button>
            {tooWide ? (
              <p className="small dim">Zoom in to level {MIN_TIMELAPSE_ZOOM} or closer to play a timelapse of this view.</p>
            ) : (
              <p className="small dim">Plays every date covering this view. The view locks while playing.</p>
            )}
            {finding.message && <p className={finding.error ? 'error small' : 'small dim'}>{finding.message}</p>}
          </>
        )}
      </section>

      {scene && timelapse.active && <FramePanels scene={scene} timelapse={timelapse} dates={dates} client={client} config={config} />}

      <GpuFooter scene={scene} />
      <PerformancePanel scene={scene} />
    </aside>
  );
}

/** Layer, legend and statistics for the frame on screen. Timelapse state only. */
function FramePanels({
  scene,
  timelapse,
  dates,
  client,
  config,
}: {
  scene: MapScene;
  timelapse: TimelapseState;
  dates: Dates;
  client: RasterClient;
  config: DatasetConfig | null;
}): React.JSX.Element {
  const settings = useSceneSettings(scene);
  const layer = settings?.layer ?? 'natural';
  const [analysis, setAnalysis] = useState<{ busy: boolean; error: string | null; value: RegionStatsResponse | null }>({ busy: false, error: null, value: null });
  const [resolutionM, setResolutionM] = useState(100);
  const current = timelapse.frames[timelapse.index];

  const runAnalysis = async (): Promise<void> => {
    if (!current || !config) return;
    const view = scene.viewBounds();
    setAnalysis({ busy: true, error: null, value: null });
    try {
      const value = await client.regionStats({
        collection: current.collection,
        sceneA: current.id,
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
        <h2>Layer</h2>
        <div className="layers">
          {LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={l.id === layer ? 'chip selected' : 'chip'}
              onClick={() => scene.updateSettings({ layer: l.id })}
            >
              {l.label}
            </button>
          ))}
        </div>
        {layer === 'band' && (
          <label>
            Band
            <select value={settings?.band ?? 'nir'} onChange={(e) => scene.updateSettings({ band: e.target.value as RampBand })}>
              {(Object.keys(BAND_LABELS) as RampBand[]).map((b) => (
                <option key={b} value={b}>{BAND_LABELS[b]}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Brightness: {settings?.exposure.toFixed(2)}
          <input type="range" min={0.4} max={2.5} step={0.05} value={settings?.exposure ?? 1} onChange={(e) => scene.updateSettings({ exposure: Number(e.target.value) })} />
        </label>
        <label>
          Gamma: {settings?.gamma.toFixed(2)}
          <input type="range" min={0.4} max={2.2} step={0.05} value={settings?.gamma ?? 1} onChange={(e) => scene.updateSettings({ gamma: Number(e.target.value) })} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={settings?.qualityMask ?? true} onChange={(e) => scene.updateSettings({ qualityMask: e.target.checked })} />
          Apply cloud and quality mask
        </label>
        {layer === 'ndvi' && (
          <div className="grid2">
            <label>NDVI min<input type="number" min={-1} max={0.99} step={0.05} value={settings?.ndviMin ?? -1} onChange={(e) => scene.updateSettings({ ndviMin: Number(e.target.value) })} /></label>
            <label>NDVI max<input type="number" min={-0.99} max={1} step={0.05} value={settings?.ndviMax ?? 1} onChange={(e) => scene.updateSettings({ ndviMax: Number(e.target.value) })} /></label>
          </div>
        )}
      </section>

      <section>
        <h2>Legend</h2>
        <Legend layer={layer} />
        <button type="button" onClick={() => void copyShareUrl(scene, dates)}>
          Copy share link
        </button>
      </section>

      <section>
        <h2>Area statistics</h2>
        <p className="small dim">NDVI over the locked view for {current?.datetime.slice(0, 10)}.</p>
        <label>
          Analysis resolution: {resolutionM} m
          <input type="range" min={10} max={500} step={10} value={resolutionM} onChange={(e) => setResolutionM(Number(e.target.value))} />
        </label>
        <button type="button" disabled={!config || analysis.busy} onClick={() => void runAnalysis()}>
          {analysis.busy ? 'Analysing…' : 'Analyse this frame'}
        </button>
        {analysis.error && <p className="error small">{analysis.error}</p>}
        {analysis.value && <AnalysisSummary value={analysis.value} />}
      </section>
    </>
  );
}

function AnalysisSummary({ value }: { value: RegionStatsResponse }): React.JSX.Element {
  const metric = (v: number | null): string => v == null ? '—' : v.toFixed(4);
  return (
    <div className="analysis-summary small">
      <p>{value.commonValidCount.toLocaleString()} common valid samples · {(value.validCoverageFraction * 100).toFixed(1)}% coverage</p>
      <p>Mean NDVI A {metric(value.meanNdviA)} · B {metric(value.meanNdviB)} · Δ {metric(value.meanDelta)}</p>
      {value.fractionBelowThreshold != null && <p>{(value.fractionBelowThreshold * 100).toFixed(1)}% show an NDVI decrease above the threshold.</p>}
      <p className="dim">Approximate at the explicitly selected analysis resolution.</p>
      <button type="button" className="secondary" onClick={() => downloadAnalysis(value, 'json')}>Export JSON</button>
      <button type="button" className="secondary" onClick={() => downloadAnalysis(value, 'csv')}>Export CSV</button>
    </div>
  );
}

function downloadAnalysis(value: RegionStatsResponse, format: 'json' | 'csv'): void {
  const content = format === 'json'
    ? JSON.stringify(value, null, 2)
    : [
        'sample_count,common_valid_count,valid_coverage,mean_ndvi_a,mean_ndvi_b,mean_delta,fraction_above_threshold,fraction_below_threshold',
        [value.sampleCount, value.commonValidCount, value.validCoverageFraction, value.meanNdviA ?? '', value.meanNdviB ?? '', value.meanDelta ?? '', value.fractionAboveThreshold ?? '', value.fractionBelowThreshold ?? ''].join(','),
      ].join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `terrascope-analysis.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Legend({ layer }: { layer: RenderLayer }): React.JSX.Element | null {
  if (layer === 'ndvi') {
    return <RampLegend kind="ndvi" entries={ndviLegend()} />;
  }
  if (layer === 'difference') {
    return <RampLegend kind="delta" entries={deltaLegend()} />;
  }
  if (layer === 'band') {
    return (
      <p className="small dim">
        One band, stretched to the full range. Lighter means more reflectance.
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
        {info.vendor || 'unknown'} · {info.architecture || info.device || 'GPU'}
      </span>
    </footer>
  );
}

function PerformancePanel({ scene }: { scene: MapScene | null }): React.JSX.Element {
  const stats = useSceneStats(scene);
  return (
    <details className="performance">
      <summary>Performance</summary>
      <p className="small dim">Frame {stats.lastFrameMs.toFixed(2)} ms · GPU/CPU estimate {(stats.bytes / 1048576).toFixed(1)} MiB</p>
      <p className="small dim">{stats.requests} tile responses · {(stats.downloadedBytes / 1048576).toFixed(2)} MiB transferred · {stats.decodeMs.toFixed(1)} ms decode · {stats.cacheHits} edge/R2 hits</p>
      <p className="small dim">Measurements cover this session. Allocation is an application estimate, not total device memory.</p>
    </details>
  );
}

// ---- scene snapshots ------------------------------------------------------

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

/**
 * The adapter description is only known after `init()` resolves, so the
 * subscription has to be the reason this component re-renders. Reading
 * `scene.gpuInfo` directly would always show the pre-startup value.
 */
function useGpuInfo(scene: MapScene | null): MapScene['gpuInfo'] {
  useSceneStats(scene);
  return scene?.gpuInfo ?? null;
}

/**
 * The camera, straight from the scene's view snapshot. Not from render stats:
 * those only update when a GPU frame is drawn, which is late in a background
 * tab and never if WebGPU fails -- and zoom gates the Play button.
 */
function useCamera(scene: MapScene | null): { zoom: number; center: { lon: number; lat: number } } {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  const view = useSyncExternalStore(subscribe, () => scene?.view ?? null, () => null);
  return view?.camera ?? IDLE_CAMERA;
}

const IDLE_CAMERA = { zoom: 0, center: { lon: 0, lat: 0 } };

function useTimelapse(scene: MapScene | null): TimelapseState {
  const subscribe = useCallback(
    (onChange: () => void) => (scene ? scene.subscribe(onChange) : () => {}),
    [scene],
  );
  return useSyncExternalStore(
    subscribe,
    () => scene?.timelapse ?? IDLE_TIMELAPSE,
    () => IDLE_TIMELAPSE,
  );
}

function useSceneSettings(scene: MapScene | null): RenderSettings | null {
  useSceneStats(scene);
  return scene?.settings ?? null;
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
    settings: {},
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
  const layers: RenderLayer[] = ['natural', 'false', 'ndvi', 'band'];
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
      ...(layer && layers.includes(layer) ? { layer } : {}),
      ...(band && bands.includes(band) ? { band } : {}),
      gamma: number('gamma', 1, 0.4, 2.2),
      exposure: number('exposure', 1, 0.4, 2.5),
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
    lon: center.lon.toFixed(6), lat: center.lat.toFixed(6), z: zoom.toFixed(3),
    from: dates.from, to: dates.to,
    layer: settings.layer, band: settings.band, gamma: String(settings.gamma),
    exposure: String(settings.exposure),
    quality: settings.qualityMask ? 'on' : 'off',
    ndviMin: String(settings.ndviMin), ndviMax: String(settings.ndviMax),
  };
  url.search = '';
  for (const [key, value] of Object.entries(entries)) if (value) url.searchParams.set(key, value);
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

const IDLE_STATUS: MapStatus = { phase: 'starting', message: 'Starting…' };
