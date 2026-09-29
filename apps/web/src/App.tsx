/**
 * The application shell.
 *
 * Holds no imagery state. `MapScene` owns the camera, the GPU resources and the
 * frame loop; this reads snapshots from it and writes intent back through method
 * calls. Anything that changed on every frame would be a bug here, because
 * React would re-render on every frame to display it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MapScene, type MapStats, type MapStatus, type PixelInspection } from './app/MapScene';
import { RasterClient, RasterError } from './data/RasterClient';
import {
  BAND_LABELS,
  deltaLegend,
  ndviLegend,
  rampCssGradient,
  type RampBand,
} from './ui/ramps';
import type { RenderLayer, RenderSettings } from './gpu/RasterRenderer';
import type { DatasetConfig, RegionStatsResponse, Scene, SearchRequest } from '@terrascope/contracts';

/** The default area of interest: the Sacramento valley reference scene. */
const DEFAULT_AREA = { west: -121.5, south: 38.0, east: -121.2, north: 38.2 };
const DEFAULT_FROM = '2024-06-01';
const DEFAULT_TO = '2024-07-31';

const LAYERS: Array<{ id: RenderLayer; label: string; needsTwoDates?: boolean }> = [
  { id: 'natural', label: 'Natural colour' },
  { id: 'false', label: 'False colour (NIR)' },
  { id: 'ndvi', label: 'NDVI' },
  { id: 'band', label: 'Single band' },
  { id: 'difference', label: 'NDVI difference', needsTwoDates: true },
];

interface Search {
  area: typeof DEFAULT_AREA;
  from: string;
  to: string;
  maxCloud: number;
}

interface SharedState {
  search: Search;
  view: { lon: number; lat: number; zoom: number };
  sceneA: string | null;
  sceneB: string | null;
  settings: Partial<RenderSettings>;
}

export function App(): React.JSX.Element {
  const initial = useRef(readSharedState());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<MapScene | null>(null);
  const [search, setSearch] = useState<Search>(initial.current.search);
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);

  const runSearch = useCallback(async (request: Search, client: RasterClient, cursor?: string) => {
    setResults((r) => ({ ...r, busy: true, error: null }));
    const body: SearchRequest = {
      bbox: [request.area.west, request.area.south, request.area.east, request.area.north],
      start: `${request.from}T00:00:00Z`,
      end: `${request.to}T23:59:59Z`,
      maxCloudCover: request.maxCloud,
      limit: 40,
      ...(cursor ? { cursor } : {}),
    };
    try {
      const response = await client.search(body);
      setResults((previous) => ({
        scenes: cursor ? [...previous.scenes, ...response.scenes] : response.scenes,
        error: null,
        busy: false,
        nextCursor: response.nextCursor,
        matched: response.matched,
      }));
      return response.scenes;
    } catch (error) {
      setResults((previous) => ({
        scenes: cursor ? previous.scenes : [],
        busy: false,
        nextCursor: previous.nextCursor,
        matched: previous.matched,
        error:
          error instanceof RasterError
            ? `${error.status}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
      }));
      return [];
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = new MapScene(canvas);
    const restored = initial.current;
    instance.setView({ lon: restored.view.lon, lat: restored.view.lat }, restored.view.zoom);
    instance.updateSettings(restored.settings);
    setScene(instance);
    void instance.init();
    if (restored.sceneA) {
      void runSearch(restored.search, instance.client).then((scenes) => {
        const a = scenes.find((candidate) => candidate.id === restored.sceneA);
        const b = scenes.find((candidate) => candidate.id === restored.sceneB);
        if (a) void instance.setScene(a);
        if (b) void instance.setSceneB(b);
      });
    }
    return () => {
      setScene(null);
      instance.dispose();
    };
  }, [runSearch]);

  return (
    <div className="app">
      <CanvasAndScene canvasRef={canvasRef} scene={scene} />
      <Sidebar
        scene={scene}
        search={search}
        onSearchChange={setSearch}
        results={results}
        onSearch={(client) => void runSearch(search, client)}
        onNext={(client, cursor) => void runSearch(search, client, cursor)}
      />
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
      scene.panByPixels(start.x - event.clientX, start.y - event.clientY);
      drag.current = { x: event.clientX, y: event.clientY };
      return;
    }
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
      <canvas
        ref={canvasRef}
        className="map"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      />
      {scene?.scene && <FootprintOverlay scene={scene} />}
      {status.phase !== 'ready' && (
        <div className={`overlay ${status.phase === 'error' ? 'error' : ''}`}>
          <p>{status.message}</p>
          {status.phase === 'error' && (
            <p className="hint">
              TerraScope needs WebGPU. On Linux, Chrome usually needs
              <code> --enable-unsafe-webgpu</code> or
              <code> --enable-features=Vulkan</code>.
            </p>
          )}
        </div>
      )}
      <div className="hud">
        <span>
          {stats.zoom.toFixed(2)}z · {stats.centre.lat.toFixed(4)}, {stats.centre.lon.toFixed(4)}
        </span>
        <span>
          {stats.resident} tiles
          {stats.pending > 0 ? ` · ${stats.pending} loading` : ''}
        </span>
        {stats.failed > 0 && <span className="warn">{stats.failed} unavailable</span>}
        <span className="dim">{stats.lastFrameMs.toFixed(1)} ms</span>
      </div>
      {inspection && <PixelReadout value={inspection} />}
    </div>
  );
}

function FootprintOverlay({ scene }: { scene: MapScene }): React.JSX.Element | null {
  const bbox = scene.scene?.bbox;
  if (!bbox || bbox.length < 4) return null;
  const [west, south, east, north] = bbox;
  const points = [[west, north], [east, north], [east, south], [west, south]]
    .map(([lon, lat]) => scene.projectPoint(lon, lat))
    .map((point) => `${point.x},${point.y}`)
    .join(' ');
  return <svg className="footprints"><polygon points={points} /></svg>;
}

function PixelReadout({ value }: { value: PixelInspection }): React.JSX.Element {
  return (
    <div className="pixel-readout">
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
  search,
  onSearchChange,
  results,
  onSearch,
  onNext,
}: {
  scene: MapScene | null;
  search: Search;
  onSearchChange: (next: Search) => void;
  results: SearchResults;
  onSearch: (client: RasterClient) => void;
  onNext: (client: RasterClient, cursor: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState<string>('');
  const [client] = useState(() => new RasterClient());
  const [config, setConfig] = useState<DatasetConfig | null>(null);
  const [analysis, setAnalysis] = useState<{ busy: boolean; error: string | null; value: RegionStatsResponse | null }>({ busy: false, error: null, value: null });
  const [resolutionM, setResolutionM] = useState(60);
  const [threshold, setThreshold] = useState(0.2);
  const settings = useSceneSettings(scene);
  const layer = settings?.layer ?? 'natural';

  useEffect(() => {
    const controller = new AbortController();
    void client.config(controller.signal).then(setConfig).catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  const runAnalysis = async (): Promise<void> => {
    if (!scene?.scene || !config) return;
    setAnalysis({ busy: true, error: null, value: null });
    try {
      const value = await client.regionStats({
        collection: scene.scene.collection,
        sceneA: scene.scene.id,
        ...(scene.sceneB ? { sceneB: scene.sceneB.id } : {}),
        bbox: [search.area.west, search.area.south, search.area.east, search.area.north],
        resolutionM,
        qualityPolicy: config.qualityPolicy,
        threshold,
      });
      setAnalysis({ busy: false, error: null, value });
    } catch (error) {
      setAnalysis({ busy: false, value: null, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const pick = (id: string): void => {
    const target = results.scenes.find((s) => s.id === id);
    if (!target || !scene) return;
    setSelected(id);
    setCompareWith('');
    void scene.setScene(target);
  };

  const pickCompare = (id: string): void => {
    const target = results.scenes.find((s) => s.id === id);
    if (!scene) return;
    setCompareWith(id);
    void scene.setSceneB(target ?? null);
  };

  return (
    <aside className="sidebar">
      <header>
        <h1>TerraScope</h1>
        <p className="tagline">Sentinel-2 on the GPU, read exactly as measured.</p>
      </header>

      <section>
        <h2>Area and time</h2>
        <div className="grid2">
          <label>
            From
            <input
              type="date"
              value={search.from}
              onChange={(e) => onSearchChange({ ...search, from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={search.to}
              onChange={(e) => onSearchChange({ ...search, to: e.target.value })}
            />
          </label>
        </div>
        <label>
          Max cloud cover: {search.maxCloud}%
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={search.maxCloud}
            onChange={(e) => onSearchChange({ ...search, maxCloud: Number(e.target.value) })}
          />
        </label>
        <p className="dim small">
          Bounding box {search.area.west}, {search.area.south} → {search.area.east},{' '}
          {search.area.north}
        </p>
        <button
          type="button"
          className="secondary"
          disabled={!scene}
          onClick={() => scene && onSearchChange({ ...search, area: scene.viewBounds() })}
        >
          Use current map extent
        </button>
        <button type="button" onClick={() => onSearch(client)} disabled={results.busy}>
          {results.busy ? 'Searching…' : 'Search scenes'}
        </button>
        {results.error && <p className="error small">{results.error}</p>}
      </section>

      {results.scenes.length > 0 && (
        <section>
          <h2>Scenes ({results.scenes.length})</h2>
          <ul className="scenes">
            {results.scenes.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={s.id === selected ? 'scene selected' : 'scene'}
                  onClick={() => pick(s.id)}
                >
                  <span className="date">{s.datetime.slice(0, 10)}</span>
                  <span className="cloud">
                    {s.cloudCover == null ? 'cloud ?' : `${s.cloudCover.toFixed(0)}% cloud`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {results.nextCursor && (
            <button
              type="button"
              disabled={results.busy}
              onClick={() => onNext(client, results.nextCursor!)}
            >
              {results.busy ? 'Loading…' : 'Load more scenes'}
            </button>
          )}
        </section>
      )}

      {scene?.scene && (
        <>
          <section>
            <h2>Layer</h2>
            <div className="layers">
              {LAYERS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={l.id === layer ? 'chip selected' : 'chip'}
                  disabled={l.needsTwoDates && !scene.sceneB}
                  title={l.needsTwoDates && !scene.sceneB ? 'Pick a second date first' : undefined}
                  onClick={() => scene.updateSettings({ layer: l.id })}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {layer === 'band' && (
              <label>
                Band
                <select
                  value={settings?.band ?? 'nir'}
                  onChange={(e) =>
                    scene.updateSettings({ band: e.target.value as RampBand })
                  }
                >
                  {(Object.keys(BAND_LABELS) as RampBand[]).map((b) => (
                    <option key={b} value={b}>
                      {BAND_LABELS[b]}
                    </option>
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
                <label>NDVI min<input type="number" min={-1} max={0.99} step={0.05} value={settings?.ndviMin ?? -1} onChange={(e) => scene.updateSettings({ ndviMin: Number(e.target.value) })} /></label>
                <label>NDVI max<input type="number" min={-0.99} max={1} step={0.05} value={settings?.ndviMax ?? 1} onChange={(e) => scene.updateSettings({ ndviMax: Number(e.target.value) })} /></label>
              </div>
            )}
            {layer === 'difference' && (
              <label>Difference display range: ±{settings?.deltaRange.toFixed(2)}<input type="range" min={0.05} max={1} step={0.05} value={settings?.deltaRange ?? 1} onChange={(e) => scene.updateSettings({ deltaRange: Number(e.target.value) })} /></label>
            )}
          </section>

          <section>
            <h2>Compare dates</h2>
            <label>
              Second date
              <select value={compareWith} onChange={(e) => pickCompare(e.target.value)}>
                <option value="">None</option>
                {results.scenes
                  .filter((s) => s.id !== selected)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.datetime.slice(0, 10)} · {s.id.split('_')[0]}
                    </option>
                  ))}
              </select>
            </label>
            {scene.sceneB ? (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings?.swipeEnabled ?? false}
                    onChange={(e) => scene.updateSettings({ swipeEnabled: e.target.checked })}
                  />
                  Swipe between dates
                </label>
                {settings?.swipeEnabled && (
                  <label>
                    Divider: {Math.round(settings.swipe * 100)}%
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={settings.swipe}
                      onChange={(e) => scene.updateSettings({ swipe: Number(e.target.value) })}
                    />
                  </label>
                )}
                <p className="small dim">
                  {scene.scene.datetime.slice(0, 10)} vs {scene.sceneB.datetime.slice(0, 10)}
                </p>
              </>
            ) : (
              <p className="small dim">Pick a second date to swipe or difference.</p>
            )}
          </section>

          <section>
            <h2>Legend</h2>
            <Legend layer={layer} />
            <p className="small dim">{scene.scene.attribution}</p>
            <button
              type="button"
              onClick={() => void copyShareUrl(scene, search)}
            >
              Copy share link
            </button>
          </section>

          <section>
            <h2>Area statistics</h2>
            <label>
              Analysis resolution: {resolutionM} m
              <input type="range" min={10} max={500} step={10} value={resolutionM} onChange={(e) => setResolutionM(Number(e.target.value))} />
            </label>
            <label>
              NDVI change threshold: {threshold.toFixed(2)}
              <input type="range" min={0.05} max={0.8} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </label>
            <button type="button" disabled={!config || analysis.busy} onClick={() => void runAnalysis()}>
              {analysis.busy ? 'Analysing…' : 'Analyse selected bbox'}
            </button>
            {analysis.error && <p className="error small">{analysis.error}</p>}
            {analysis.value && <AnalysisSummary value={analysis.value} />}
          </section>
        </>
      )}

      <GpuFooter scene={scene} />
      <PerformancePanel scene={scene} />
    </aside>
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

function useSceneSettings(scene: MapScene | null): RenderSettings | null {
  useSceneStats(scene);
  return scene?.settings ?? null;
}

function readSharedState(): SharedState {
  const fallback: SharedState = {
    search: { area: DEFAULT_AREA, from: DEFAULT_FROM, to: DEFAULT_TO, maxCloud: 100 },
    view: { lon: -121.3, lat: 38.1, zoom: 11 },
    sceneA: null,
    sceneB: null,
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
  const layers: RenderLayer[] = ['natural', 'false', 'ndvi', 'difference', 'band'];
  const bands: RampBand[] = ['red', 'green', 'blue', 'nir'];
  const layer = p.get('layer') as RenderLayer | null;
  const band = p.get('band') as RampBand | null;
  return {
    search: {
      area: {
        west: number('west', DEFAULT_AREA.west, -180, 180),
        south: number('south', DEFAULT_AREA.south, -85.0511, 85.0511),
        east: number('east', DEFAULT_AREA.east, -180, 180),
        north: number('north', DEFAULT_AREA.north, -85.0511, 85.0511),
      },
      from: /^\d{4}-\d{2}-\d{2}$/.test(p.get('from') ?? '') ? p.get('from')! : DEFAULT_FROM,
      to: /^\d{4}-\d{2}-\d{2}$/.test(p.get('to') ?? '') ? p.get('to')! : DEFAULT_TO,
      maxCloud: number('cloud', 100, 0, 100),
    },
    view: {
      lon: number('lon', -121.3, -180, 180),
      lat: number('lat', 38.1, -85.0511, 85.0511),
      zoom: number('z', 11, 2, 19),
    },
    sceneA: p.get('a'),
    sceneB: p.get('b'),
    settings: {
      ...(layer && layers.includes(layer) ? { layer } : {}),
      ...(band && bands.includes(band) ? { band } : {}),
      gamma: number('gamma', 1, 0.4, 2.2),
      exposure: number('exposure', 1, 0.4, 2.5),
      swipe: number('divider', 0.5, 0, 1),
      swipeEnabled: p.get('swipe') === '1',
      qualityMask: p.get('quality') !== 'off',
      ndviMin: number('ndviMin', -1, -1, 0.99),
      ndviMax: number('ndviMax', 1, -0.99, 1),
      deltaRange: number('deltaRange', 1, 0.05, 1),
    },
  };
}

async function copyShareUrl(scene: MapScene, search: Search): Promise<void> {
  const url = new URL(location.href);
  const { center, zoom } = scene.camera;
  const settings = scene.settings;
  const entries: Record<string, string> = {
    lon: center.lon.toFixed(6), lat: center.lat.toFixed(6), z: zoom.toFixed(3),
    west: String(search.area.west), south: String(search.area.south),
    east: String(search.area.east), north: String(search.area.north),
    from: search.from, to: search.to, cloud: String(search.maxCloud),
    layer: settings.layer, band: settings.band, gamma: String(settings.gamma),
    exposure: String(settings.exposure), divider: String(settings.swipe),
    swipe: settings.swipeEnabled ? '1' : '0', a: scene.scene?.id ?? '', b: scene.sceneB?.id ?? '',
    quality: settings.qualityMask ? 'on' : 'off',
    ndviMin: String(settings.ndviMin), ndviMax: String(settings.ndviMax), deltaRange: String(settings.deltaRange),
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
  bytes: 0,
  zoom: 0,
  centre: { lon: 0, lat: 0 },
  lastFrameMs: 0,
  requests: 0,
  downloadedBytes: 0,
  decodeMs: 0,
  cacheHits: 0,
};

const IDLE_STATUS: MapStatus = { phase: 'starting', message: 'Starting…' };

interface SearchResults {
  scenes: Scene[];
  error: string | null;
  busy: boolean;
  nextCursor: string | null;
  matched: number | null;
}

const EMPTY_RESULTS: SearchResults = {
  scenes: [], error: null, busy: false, nextCursor: null, matched: null,
};
