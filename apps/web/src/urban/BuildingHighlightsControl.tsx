import { useEffect, useRef, useState } from 'react';
import type { GlowCategory } from '../splat/LangSplatBuildingGlow';

export function BuildingHighlightsControl({ available, setEnabled, setCategory }: {
  available: boolean; setEnabled: (enabled: boolean) => Promise<void>; setCategory: (category: GlowCategory) => Promise<void>;
}) {
  const [enabled, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [category, updateCategory] = useState<GlowCategory>('buildings');
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
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Unable to load LangSplat features.');
    } finally { if (mounted.current) setBusy(false); }
  };
  const select = async (next: GlowCategory): Promise<void> => {
    setBusy(true); setError('');
    try {
      await setCategory(next);
      if (mounted.current) updateCategory(next);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Unable to change glow target.');
    } finally { if (mounted.current) setBusy(false); }
  };
  return <div className="building-highlights-control">
    <label className="glow-target">Glow target
      <select aria-label="Glow target" value={category} disabled={!available || busy} onChange={event => { void select(event.target.value as GlowCategory); }}>
        <option value="buildings">Buildings</option><option value="vegetation">Vegetation</option>
      </select>
    </label>
    <button type="button" className="secondary" aria-pressed={enabled} disabled={busy || !available}
      title={available ? 'Pulse LangSplat matches on the original splats' : 'LangSplat features are not available for this scene yet'}
      onClick={() => { void toggle(); }}>
      {busy ? 'Loading features…' : enabled ? 'Stop glow' : 'Start glow'}
    </button>
    {!available && <small>Scene training pending</small>}
    {enabled && <p role="status">LangSplat matches · experimental. Maximum coverage; glow capped at 50%. Matches may be incorrect or missing.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
