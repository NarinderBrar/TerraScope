import { useEffect, useMemo, useState } from 'react';
import type { SplatSceneMeta } from '../data/splatScenes';
import { loadUrbanData } from './osm';
import { computeShade, drivable, simulateTraffic } from './model';
import { DEFAULT_URBAN_OPTIONS, type UrbanData, type UrbanOptions, type UrbanOverlayState } from './types';

const scenarioText: Record<UrbanOptions['scenario'], string> = {
  baseline: 'Existing mapped network with assumed peak-hour trips distributed between graph nodes.',
  diversion: 'Close the selected road to general traffic and route the same trips through available alternatives.',
  signals: 'Assume a 15% capacity improvement on the selected road. This tests a capacity assumption, not signal phases.',
  'bus-lane': 'Reserve one lane on the selected road and assume 20% of network car trips shift to buses. Bus operations are not modelled.',
  trees: 'Propose up to 80 mature trees along sampled pedestrian corridors: 8 m high, 3 m crown radius, at least 15 m apart. Siting needs review.',
};
const percent = (n: number | null): string => n === null ? 'Unavailable' : `${n.toFixed(1)}%`;

export function UrbanPanel({ scene, onChange }: { scene: SplatSceneMeta; onChange: (state: UrbanOverlayState | null) => void }): React.JSX.Element {
  const [data, setData] = useState<UrbanData | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [options, setOptions] = useState<UrbanOptions>({ ...DEFAULT_URBAN_OPTIONS });
  const [selectedFeature, setSelectedFeature] = useState('');
  const change = <K extends keyof UrbanOptions>(key: K, value: UrbanOptions[K]): void => setOptions(o => ({ ...o, [key]: value }));
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    void loadUrbanData(scene, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setData(next);
      setOptions(o => ({ ...o, selectedRoad: next.features.find(drivable)?.id ?? '' }));
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, [scene, attempt]);
  const baselineOptions = useMemo(() => ({ ...DEFAULT_URBAN_OPTIONS, demand: options.demand, date: options.date, hour: options.hour }), [options.demand, options.date, options.hour]);
  const baselineTraffic = useMemo(() => data ? simulateTraffic(data, scene, baselineOptions) : null, [data, scene, baselineOptions]);
  const traffic = useMemo(() => data ? simulateTraffic(data, scene, { ...baselineOptions, selectedRoad: options.selectedRoad, scenario: options.scenario }) : null,
    [data, scene, baselineOptions, options.selectedRoad, options.scenario]);
  const baselineShade = useMemo(() => data ? computeShade(data, scene, baselineOptions) : null, [data, scene, baselineOptions]);
  const shade = useMemo(() => data ? computeShade(data, scene, { ...baselineOptions, scenario: options.scenario }) : null, [data, scene, baselineOptions, options.scenario]);
  useEffect(() => {
    onChange(data && traffic && shade ? { data, options, traffic, shade, selectedFeature } : null);
  }, [data, options, traffic, shade, selectedFeature, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  const roads = data?.features.filter(drivable) ?? [];
  const selected = data?.features.find(f => f.id === selectedFeature);
  const selectedLinks = traffic?.roads.filter(r => r.feature.id === selectedFeature) ?? [];
  const exportReport = (): void => {
    const report = { scene: scene.id, bounds: scene.bounds, registration: scene.georeference, source: '© OpenStreetMap contributors, ODbL', fetchedAt: data?.fetchedAt,
      options, assumptions: scenarioText, trafficBasis: 'Simulated; no measured traffic counts. 32 or fewer distributed OD pairs, 4-stage BPR assignment. Total bidirectional road capacity.',
      shadeBasis: 'Computed from mapped footprints and tagged/assumed heights, 1.5 m pedestrian height, local solar time. Mapped tree crowns assume 3 m radius. Not measured heat.',
      baseline: { peakLoad: baselineTraffic?.peakLoad, delayVehicleHours: baselineTraffic?.delay, unservedTrips: baselineTraffic?.unserved, shadePercent: baselineShade?.percent, canopyPercent: baselineShade?.canopyPercent },
      proposed: { peakLoad: traffic?.peakLoad, delayVehicleHours: traffic?.delay, unservedTrips: traffic?.unserved, shadePercent: shade?.percent, canopyPercent: shade?.canopyPercent, treeCount: shade?.plannedTrees.length },
      features: data?.features };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${scene.id}-urban-scenario.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <aside className="urban-lab" aria-label="Urban simulation lab">
    <h3>Urban Lab <small>Scenario estimates</small></h3>
    {!data && !error && <p role="status">Loading mapped roads, buildings and trees…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry map data</button></p>}
    {data && traffic && shade && baselineTraffic && baselineShade && <>
      <p className="urban-source"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · {data.features.length} mapped features · {new Date(data.fetchedAt).toLocaleDateString()}</p>
      <fieldset><legend>Visible layers</legend><div className="urban-layers">
        {([['traffic', 'Traffic particles'], ['buildings', 'Building outlines'], ['vegetation', 'Mapped trees'], ['transit', 'Stops, crossings, signals'], ['shade', 'Pedestrian shade']] as const).map(([key, label]) =>
          <label key={key}><input type="checkbox" checked={options[key]} onChange={e => change(key, e.target.checked)} />{label}</label>)}
      </div><button type="button" onClick={() => change('playing', !options.playing)}>{options.playing ? 'Pause traffic' : 'Play traffic'}</button>
      <p>Roads: cyan &lt;70% capacity · amber 70–100% · red &gt;100% · pink closed. Shade: cyan shaded · yellow sunny. Overlays remain visible through the splat.</p></fieldset>
      <label>Inspect mapped feature<select value={selectedFeature} onChange={e => setSelectedFeature(e.target.value)}><option value="">Choose a feature</option>{data.features.map(f => <option key={f.id} value={f.id}>{f.kind} · {f.name}</option>)}</select></label>
      {selected && <div className="urban-inspector"><strong>{selected.name}</strong><p>{selected.kind} · <a href={`https://www.openstreetmap.org/${selected.id}`} target="_blank" rel="noreferrer">OSM record</a></p>
        {['building', 'tree'].includes(selected.kind) && <p>Height {selected.height.toFixed(1)} m · {selected.heightAssumed ? 'assumed / derived from levels' : 'OSM tagged'}</p>}
        {selected.kind === 'tree' && <p>Crown radius: assumed 3 m</p>}
        {selectedLinks.length > 0 && <p>Simulated peak load {Math.max(...selectedLinks.map(r => r.load)).toFixed(2)}× · capacity {Math.round(selectedLinks[0].capacity)} veh/h · minimum speed {Math.min(...selectedLinks.map(r => r.speed)).toFixed(1)} km/h</p>}
        <p>{Object.entries(selected.tags).filter(([k]) => ['highway', 'lanes', 'maxspeed', 'oneway', 'building:levels', 'width', 'crossing', 'species'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p></div>}
      <fieldset><legend>Scenario</legend>
        <label>Intervention<select value={options.scenario} onChange={e => change('scenario', e.target.value as UrbanOptions['scenario'])}>
          <option value="baseline">Baseline</option><option value="diversion" disabled={!roads.length}>Road closure / diversion</option><option value="signals" disabled={!roads.length}>Signal capacity improvement</option><option value="bus-lane" disabled={!roads.length}>Bus lane + mode shift</option><option value="trees">Plant mature trees</option>
        </select></label>
        {['diversion', 'signals', 'bus-lane'].includes(options.scenario) && <label>Target road<select value={options.selectedRoad} onChange={e => { change('selectedRoad', e.target.value); setSelectedFeature(e.target.value); }}>{roads.map(f => <option key={f.id} value={f.id}>{f.name} · {f.id}</option>)}</select></label>}
        <p>{scenarioText[options.scenario]}</p>
        <label>Assumed demand: {options.demand} car trips/h<input aria-label="Assumed hourly traffic demand" type="range" min="100" max="5000" step="100" value={options.demand} onChange={e => change('demand', Number(e.target.value))} /></label>
      </fieldset>
      <fieldset><legend>Sun and pedestrian shade</legend>
        <label>Date<input type="date" value={options.date} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) change('date', e.target.value); }} /></label>
        <label>Local solar time: {options.hour}:00<input aria-label="Local solar hour" type="range" min="6" max="18" step="1" value={options.hour} onChange={e => change('hour', Number(e.target.value))} /></label>
        <p>Sun elevation {shade.sunAltitude.toFixed(1)}° · {shade.cells.length} pedestrian samples. Solar time differs from clock time.</p>
      </fieldset>
      <table><caption>Baseline / proposed · same demand and sun</caption><thead><tr><th>Metric</th><th>Baseline</th><th>Proposed</th></tr></thead><tbody>
        <tr><th>Peak road load</th><td>{baselineTraffic.peakLoad.toFixed(2)}×</td><td>{traffic.peakLoad.toFixed(2)}×</td></tr>
        <tr><th>Delay (vehicle h/h)</th><td>{baselineTraffic.delay.toFixed(2)}</td><td>{traffic.delay.toFixed(2)}</td></tr>
        <tr><th>Unroutable trips/h</th><td>{Math.round(baselineTraffic.unserved)}</td><td>{Math.round(traffic.unserved)}</td></tr>
        <tr><th>Pedestrian shade</th><td>{percent(baselineShade.percent)}</td><td>{percent(shade.percent)}</td></tr>
        <tr><th>Mapped crown cover</th><td>{percent(baselineShade.canopyPercent)}</td><td>{percent(shade.canopyPercent)}</td></tr>
        <tr><th>Proposed trees</th><td>0</td><td>{shade.plannedTrees.length}</td></tr>
      </tbody></table>
      <details><summary>Sources and assumptions</summary><p>Traffic is simulated from assumed trips, lanes and capacities using incremental routing and a BPR delay curve. No traffic counts or live congestion are used. Particles illustrate link speeds; they are not individual vehicle trajectories. Signals change assumed capacity; signal phases, queues and bus schedules are not simulated.</p>
        <p>Shade uses OSM building footprints, tagged heights, or 3 m per level / 9 m defaults. Tree height defaults to 8 m and crown radius to 3 m. {data.features.filter(f => f.kind === 'building' && f.heightAssumed).length} building heights are derived or assumed. Only mapped trees contribute; missing trees reduce estimated coverage. Pedestrian samples use mapped paths or assumed roadside offsets. Flat ground, opaque spherical crowns, mature proposed trees; no temperature prediction.</p>
        <p>Skyfall appearance is not measurement geometry. The overlays use this scene’s existing measured geographic registration. Data dates may differ from the captured scene.</p></details>
      <button type="button" onClick={exportReport}>Export scenario JSON</button>
    </>}
  </aside>;
}
