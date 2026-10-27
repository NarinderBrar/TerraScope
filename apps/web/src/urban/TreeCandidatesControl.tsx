import { useEffect, useRef, useState } from 'react';

export function TreeCandidatesControl({ setVisible }: { setVisible: (visible: boolean) => Promise<number> }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void setVisible(false); };
  }, [setVisible]);
  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setBusy(true);
    setMessage('');
    try {
      const count = await setVisible(next);
      if (!mounted.current) return;
      setEnabled(next);
      setMessage(next && !count ? 'No tree candidates available.' : '');
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Unable to show tree candidates.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="tree-candidates-control">
    <button type="button" className="secondary" aria-pressed={enabled} disabled={busy} onClick={() => { void toggle(); }}>
      {busy ? 'Loading trees…' : enabled ? 'Hide tree candidates' : 'Find trees · experimental'}
    </button>
    {(enabled || message) && <p role="status">{message || 'Green markers show vegetation-like features. Matches may be incorrect or missing; markers are not a tree count.'}</p>}
  </div>;
}
