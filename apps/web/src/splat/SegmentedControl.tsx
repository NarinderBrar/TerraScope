import { useEffect, useRef, useState } from 'react';

export function SegmentedControl({ available, setEnabled }: { available: boolean; setEnabled: (enabled: boolean) => Promise<void> }) {
  const [enabled, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void setEnabled(false); };
  }, [setEnabled]);
  const toggle = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      await setEnabled(!enabled);
      if (mounted.current) setActive(!enabled);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Unable to load segmented view.');
    } finally { if (mounted.current) setBusy(false); }
  };
  return <div className="segmented-control">
    <button type="button" className="secondary" aria-pressed={enabled} disabled={!available || busy}
      title={available ? 'Toggle normal and experimental class-colored splats' : 'Segmentation is currently trained for Union Square only'}
      onClick={() => { void toggle(); }}>
      {busy ? 'Loading segmentation…' : enabled ? 'Normal splat view' : 'Segmented view'}
    </button>
    {!available && <small>Union Square only</small>}
    {enabled && <div className="segmented-legend" role="status">
      <span><i style={{ background: '#ff992e' }} />Building-like</span>
      <span><i style={{ background: '#1fb3ff' }} />Road-like</span>
      <span><i style={{ background: '#38e659' }} />Tree-like</span>
      <span><i style={{ background: '#66707d' }} />Uncertain</span>
      <p>Experimental · reduced detail. Building and road predictions are unreliable.</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
