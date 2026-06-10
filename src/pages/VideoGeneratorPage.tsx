import { useState, useEffect, useRef, useCallback } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './VideoGeneratorPage.css';

// ─── Lucide-style icons (1.5 stroke, currentColor) ───
const Film = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>
  </svg>
);
const Download = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

interface Brain { id: string; brandName: string; brandUrl: string; }
type Status = 'queued' | 'storyboarding' | 'voicing' | 'rendering' | 'done' | 'error';
interface VideoJob {
  id: string;
  status: Status;
  progress: number | null;
  outputUrl: string | null;
  error: string | null;
  direction?: { voice?: string; musicBed?: string; theme?: string; mood?: string } | null;
}
interface RecentVideo { id: string; status: Status; output_url: string | null; error: string | null; created_at: string; }
interface DirectionOption { id: string; desc: string; }
interface VideoArc { id: string; title: string; angle: string; brief: string; length: number; orientation: 'landscape' | 'portrait'; }

// Human-readable label + rough completion weight for the progress bar. The
// Lambda render reports its own 0..1 progress; the earlier stages are coarse.
const STAGE: Record<Status, { label: string; base: number }> = {
  queued:        { label: 'Queued…',                 base: 0.02 },
  storyboarding: { label: 'Writing the storyboard…', base: 0.10 },
  voicing:       { label: 'Generating voiceover…',   base: 0.30 },
  rendering:     { label: 'Rendering on Lambda…',    base: 0.50 },
  done:          { label: 'Done',                     base: 1.00 },
  error:         { label: 'Failed',                   base: 0.00 },
};

function VideoGeneratorContent() {
  const { historyEntries, activeBrand, authToken } = useApp();
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [brief, setBrief] = useState('');
  const [arcs, setArcs] = useState<VideoArc[]>([]);
  const [arcsLoading, setArcsLoading] = useState(false);
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [voice, setVoice] = useState('auto');
  const [musicBed, setMusicBed] = useState('auto');
  const [theme, setTheme] = useState('auto');
  const [targetSeconds, setTargetSeconds] = useState(30);
  const [voiceOptions, setVoiceOptions] = useState<DirectionOption[]>([]);
  const [bedOptions, setBedOptions] = useState<DirectionOption[]>([]);
  const [themeOptions, setThemeOptions] = useState<DirectionOption[]>([]);
  const [lengthOptions, setLengthOptions] = useState<number[]>([15, 30, 60]);
  const [shots, setShots] = useState<{ key: string; url: string }[]>([]);
  const [uploadingShots, setUploadingShots] = useState(false);
  const [job, setJob] = useState<VideoJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentVideo[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  let brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));
  if (activeBrand?.id && !brains.some(b => b.id === activeBrand.id)) {
    brains.push({ id: activeBrand.id, brandName: activeBrand.brandName || activeBrand.brandUrl, brandUrl: activeBrand.brandUrl });
  }

  useEffect(() => {
    if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id);
  }, [activeBrand, selectedBrainId]);

  // Creative-direction vocabulary for the pickers (curated server-side).
  useEffect(() => {
    if (!authToken) return;
    fetch('/api/video/options', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => {
        setVoiceOptions(d.voices || []); setBedOptions(d.musicBeds || []);
        setThemeOptions(d.themes || []);
        if (Array.isArray(d.lengths) && d.lengths.length) setLengthOptions(d.lengths);
      })
      .catch(() => {});
  }, [authToken]);

  const loadRecent = useCallback(() => {
    if (!selectedBrainId || !authToken) { setRecent([]); return; }
    fetch(`/api/video?brandProfileId=${selectedBrainId}`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json()).then(d => setRecent(d.videos || [])).catch(() => {});
  }, [selectedBrainId, authToken]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  // Poll an in-flight job until it finishes.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/video/${job.id}`, { headers: { Authorization: `Bearer ${authToken}` } });
        const d: VideoJob = await r.json();
        setJob(d);
        if (d.status === 'done' || d.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current);
          setBusy(false);
          loadRecent();
        }
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [job?.id, job?.status, authToken, loadRecent]);

  async function suggestArcs() {
    if (!selectedBrainId || !authToken) return;
    setArcsLoading(true); setError(null);
    try {
      const r = await fetch('/api/video/arcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ brandProfileId: selectedBrainId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not generate ideas');
      setArcs(d.arcs || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setArcsLoading(false);
    }
  }

  function useArc(a: VideoArc) {
    setBrief(a.brief);
    setTargetSeconds(a.length);
    setOrientation(a.orientation);
  }

  async function generate() {
    if (!selectedBrainId || !brief.trim() || !authToken) return;
    setBusy(true); setError(null); setJob(null);
    try {
      const r = await fetch('/api/video/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ brandProfileId: selectedBrainId, brief: brief.trim(), orientation, voice, musicBed, theme, targetSeconds, screenshotKeys: shots.map(s => s.key) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
      setJob({ id: d.id, status: d.status, progress: null, outputUrl: null, error: null });
    } catch (e: any) {
      setError(e.message); setBusy(false);
    }
  }

  async function uploadShots(files: FileList | null) {
    if (!files || !files.length || !selectedBrainId || !authToken) return;
    setUploadingShots(true); setError(null);
    try {
      const room = Math.max(0, 6 - shots.length);
      for (const file of Array.from(files).slice(0, room)) {
        if (!file.type.startsWith('image/')) continue;
        const dataUrl: string = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result)); fr.onerror = rej;
          fr.readAsDataURL(file);
        });
        const r = await fetch('/api/video/upload-shot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ brandProfileId: selectedBrainId, imageBase64: dataUrl, contentType: file.type === 'image/jpg' ? 'image/jpeg' : file.type }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'upload failed');
        setShots(prev => [...prev, { key: d.key, url: d.url }]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploadingShots(false);
    }
  }

  const pct = job ? Math.round(
    (STAGE[job.status].base + (job.status === 'rendering' && job.progress ? job.progress * 0.5 : 0)) * 100
  ) : 0;

  return (
    <div className="vg-wrap">
      <div className="vg-header">
        <div className="vg-title-row">
          <Film size={22} />
          <h1 className="vg-title">Video Generator</h1>
        </div>
        <p className="vg-sub">Turn a brief into a branded product reel — storyboard, voiceover, and render, all automatic.</p>
      </div>

      <div className="vg-form">
        <label className="vg-label">Brand</label>
        <select className="vg-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
          <option value="">Select a Brain…</option>
          {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
        </select>

        <div className="vg-arcs-head">
          <label className="vg-label" style={{ marginBottom: 0 }}>Need ideas? <span className="vg-optional">8 video concepts from the brand brain</span></label>
          <button type="button" className="vg-arcs-btn" onClick={suggestArcs} disabled={arcsLoading || !selectedBrainId}>
            {arcsLoading ? 'Thinking…' : arcs.length ? 'Regenerate ideas' : 'Suggest video ideas'}
          </button>
        </div>
        {arcs.length > 0 && (
          <div className="vg-arcs">
            {arcs.map(a => (
              <button type="button" key={a.id} className="vg-arc" onClick={() => useArc(a)} title="Use this idea">
                <div className="vg-arc-top">
                  <span className="vg-arc-title">{a.title}</span>
                  <span className="vg-arc-meta">{a.length}s · {a.orientation === 'portrait' ? '9:16' : '16:9'}</span>
                </div>
                {a.angle && <div className="vg-arc-angle">{a.angle}</div>}
                <div className="vg-arc-brief">{a.brief}</div>
              </button>
            ))}
          </div>
        )}

        <label className="vg-label">Brief</label>
        <textarea
          className="vg-textarea"
          placeholder="What's the video about? e.g. 'A 60-second reel introducing our GEO measurement product to B2B marketers — the problem, how the brand brain works, and a closing CTA.'"
          value={brief}
          onChange={e => setBrief(e.target.value)}
          rows={5}
        />

        <label className="vg-label">Format</label>
        <div className="vg-toggle">
          <button
            type="button"
            className={`vg-toggle-opt ${orientation === 'landscape' ? 'active' : ''}`}
            onClick={() => setOrientation('landscape')}
          >
            <span className="vg-toggle-icon vg-toggle-landscape" />
            Landscape · 16:9
          </button>
          <button
            type="button"
            className={`vg-toggle-opt ${orientation === 'portrait' ? 'active' : ''}`}
            onClick={() => setOrientation('portrait')}
          >
            <span className="vg-toggle-icon vg-toggle-portrait" />
            Reel · 9:16
          </button>
        </div>

        <label className="vg-label">Length</label>
        <div className="vg-toggle">
          {lengthOptions.map(l => (
            <button
              key={l}
              type="button"
              className={`vg-toggle-opt ${targetSeconds === l ? 'active' : ''}`}
              onClick={() => setTargetSeconds(l)}
            >
              {l}s
            </button>
          ))}
        </div>

        <label className="vg-label">Creative direction</label>
        <div className="vg-direction">
          <div className="vg-direction-field">
            <span className="vg-direction-name">Style</span>
            <select className="vg-select vg-select-sm" value={theme} onChange={e => setTheme(e.target.value)}>
              <option value="auto">Auto — brand brain decides</option>
              {themeOptions.map(t => <option key={t.id} value={t.id}>{t.id} — {t.desc}</option>)}
            </select>
          </div>
          <div className="vg-direction-field">
            <span className="vg-direction-name">Voice</span>
            <select className="vg-select vg-select-sm" value={voice} onChange={e => setVoice(e.target.value)}>
              <option value="auto">Auto — brand brain decides</option>
              {voiceOptions.map(v => <option key={v.id} value={v.id}>{v.id} — {v.desc}</option>)}
            </select>
          </div>
          <div className="vg-direction-field">
            <span className="vg-direction-name">Music</span>
            <select className="vg-select vg-select-sm" value={musicBed} onChange={e => setMusicBed(e.target.value)}>
              <option value="auto">Auto — brand brain decides</option>
              {bedOptions.map(b => <option key={b.id} value={b.id}>{b.id} — {b.desc}</option>)}
              <option value="none">None — voiceover only</option>
            </select>
          </div>
        </div>

        <label className="vg-label">Product screenshots <span className="vg-optional">optional — most apps are behind a login, so upload your own</span></label>
        <div className="vg-shots">
          {shots.map((s, i) => (
            <div key={s.key} className="vg-shot">
              <img src={s.url} alt={`screenshot ${i + 1}`} />
              <button type="button" className="vg-shot-x" onClick={() => setShots(prev => prev.filter(x => x.key !== s.key))} aria-label="remove">×</button>
            </div>
          ))}
          {shots.length < 6 && (
            <label className={`vg-shot-add ${uploadingShots ? 'busy' : ''}`}>
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={uploadingShots || !selectedBrainId}
                onChange={e => { uploadShots(e.target.files); e.target.value = ''; }} />
              {uploadingShots ? 'Uploading…' : '+ Add'}
            </label>
          )}
        </div>
        {shots.length > 0 && <div className="vg-shots-note">A "product" scene will showcase these in browser chrome.</div>}

        <button className="vg-btn" onClick={generate} disabled={busy || !selectedBrainId || !brief.trim()}>
          {busy ? 'Generating…' : 'Generate video'}
        </button>
        {error && <div className="vg-error">{error}</div>}
      </div>

      {job && (
        <div className="vg-job">
          {job.status !== 'done' && job.status !== 'error' && (
            <>
              <div className="vg-stage">{STAGE[job.status].label}</div>
              <div className="vg-bar"><div className="vg-bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="vg-pct">{pct}%</div>
            </>
          )}
          {job.direction && (job.direction.voice || job.direction.musicBed) && (
            <div className="vg-direction-note">
              Direction: {[job.direction.mood, job.direction.theme && `style ${job.direction.theme}`, job.direction.voice && `voice ${job.direction.voice}`, job.direction.musicBed && `music ${job.direction.musicBed}`].filter(Boolean).join(' · ')}
            </div>
          )}
          {job.status === 'error' && <div className="vg-error">Render failed: {job.error}</div>}
          {job.status === 'done' && job.outputUrl && (
            <div className="vg-result">
              <video className="vg-video" src={job.outputUrl} controls />
              <a className="vg-download" href={job.outputUrl} target="_blank" rel="noreferrer"><Download /> Download MP4</a>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="vg-recent">
          <h2 className="vg-recent-title">Recent</h2>
          {recent.map(v => (
            <div key={v.id} className="vg-recent-row">
              <span className={`vg-badge vg-badge-${v.status}`}>{v.status}</span>
              <span className="vg-recent-date">{new Date(v.created_at).toLocaleString()}</span>
              {v.output_url && <a className="vg-recent-link" href={v.output_url} target="_blank" rel="noreferrer">View</a>}
              {v.error && <span className="vg-recent-err">{v.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VideoGeneratorPage() {
  return <AppShell><VideoGeneratorContent /></AppShell>;
}
