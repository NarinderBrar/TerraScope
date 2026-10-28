import { useEffect, useRef, useState } from 'react';
import { SEGMENT_CLASSES, type SegmentationMetadata } from './segmentationMetadata';

export function SegmentedViewControl({ metadata, setEnabled }: {
  metadata: SegmentationMetadata | null;
  setEnabled(enabled: boolean): Promise<void>;
}): React.JSX.Element {
  const [enabled, setChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const toggle = async (): Promise<void> => {
    const next = !enabled, request = ++version.current;
    setLoading(true); setError(null);
    try {
      await setEnabled(next);
      if (request === version.current) setChecked(next);
    } catch (reason) {
      if (request === version.current) setError(reason instanceof Error ? reason.message : 'Unable to switch segmented view.');
    } finally {
      if (request === version.current) setLoading(false);
    }
  };
  const missing = SEGMENT_CLASSES.filter((_, i) => !metadata?.classes[i].voxels);
  return <div className="segmented-view-control">
    <label className="splat-map-toggle"><input type="checkbox" role="switch" aria-label="Segmented view"
      checked={enabled} disabled={!metadata || loading} onChange={() => void toggle()} />Segmented view</label>
    {loading && <small role="status">Loading segmented view…</small>}
    {!metadata && <small>Classifications unavailable for this scene.</small>}
    {enabled && <>
      <ul className="segment-legend" aria-label="Segment colours">
        {SEGMENT_CLASSES.map((item, i) => metadata?.classes[i].voxels ? <li key={item.category}>
          <span style={{ backgroundColor: item.color }} aria-hidden="true" />{item.label}
        </li> : null)}
      </ul>
      {missing.length > 0 && <small>Not detected: {missing.map(item => item.label).join(', ')}.</small>}
      <small>Experimental classifications · small objects may be missed.</small>
    </>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
