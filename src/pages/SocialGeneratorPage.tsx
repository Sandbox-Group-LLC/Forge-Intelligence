import { useState, useEffect, useRef } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './SocialGeneratorPage.css';

// ─── Lucide-style icons (1.5 stroke, currentColor — UI design directive #7) ───
const Zap = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const Copy = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);
const Edit = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────
interface Brain { id: string; brandName: string; brandUrl: string; }

interface CampaignArc {
  id: string;
  title: string;
  thesis: string;
  acts: { actNumber: number; actTitle: string; actPremise: string }[];
  targetPersona?: string;
  recommendedLength?: number;
}

// Brain elements used by the Regenerate Arcs modal so the user can lean
// into specific moats / personas / gaps. Loaded lazily on first open.
interface BrainElements {
  personas: { id: string; name: string; role?: string }[];
  moats: { capability: string; protects?: string }[];
  gaps: { topic: string; priority?: string }[];
}

type Platform = 'x' | 'instagram';
type Angle = 'provocation' | 'proof' | 'how-to' | 'counter-take';
type ConfidenceTier = 'green' | 'yellow' | 'red';

interface SocialPost {
  id: string;
  batch_id: string;
  platform: Platform;
  angle: Angle;
  hook: string;
  body: string;
  hashtags: string[];
  cta: string | null;
  char_count: number;
  confidence: number;
  confidence_tier: ConfidenceTier;
  confidence_reason: string;
  brain_match_score: number;
  image_prompt_hint?: string;
  image_url: string | null;
  status: 'draft' | 'edited' | 'queued' | 'published';
  user_edited_body: string | null;
  source_topic: string | null;
  published_url: string | null;
  published_at: string | null;
  created_at: string;
}

// Platform character constraints
const PLATFORM_LIMITS: Record<Platform, { max: number; sweet: number; sweetLabel: string }> = {
  x:         { max: 280,  sweet: 240,  sweetLabel: 'Best under 240' },
  instagram: { max: 300,  sweet: 150,  sweetLabel: 'Best under 150 (before "more")' },
};

const ANGLE_LABELS: Record<Angle, string> = {
  'provocation':  'Provocation',
  'proof':        'Proof',
  'how-to':       'How-to',
  'counter-take': 'Counter-take',
};

const ANGLE_COLORS: Record<Angle, string> = {
  'provocation':  '#F5B942',  // Proof Amber
  'proof':        '#14B8A6',  // Signal Teal
  'how-to':       '#3563FF',  // Intelligence Blue
  'counter-take': '#A855F7',  // Purple
};

// ─── Char-count tier helper ─────────────────────────────────────────────────
function charTier(count: number, platform: Platform): { color: string; label: string } {
  const { max, sweet } = PLATFORM_LIMITS[platform];
  if (count > max) return { color: '#EF4444', label: 'Over limit' };
  if (count > sweet) return { color: '#F5B942', label: 'Long' };
  return { color: '#14B8A6', label: 'On target' };
}

// ─── Stream progress reader ─────────────────────────────────────────────────
function StreamProgress({ text }: { text: string }) {
  // Look for "hook" keys as a proxy for posts arriving
  const hooks = Array.from(text.matchAll(/"hook":\s*"([^"]{4,120})"/g))
    .map(m => m[1])
    .filter((h, i, arr) => arr.indexOf(h) === i);

  if (!hooks.length) {
    return (
      <div className="sg-stream-empty">
        <span className="sg-cursor">▋</span>
        <span>Reading the Brain — patterns, mistakes, voice profile…</span>
      </div>
    );
  }

  return (
    <div className="sg-stream-list">
      <div className="sg-stream-count">Drafting {hooks.length} of 4 posts…</div>
      {hooks.map((h, i) => (
        <div key={i} className="sg-stream-item">
          <span className="sg-stream-check">✓</span>
          <span className="sg-stream-hook">{h}</span>
        </div>
      ))}
      {hooks.length < 4 && (
        <div className="sg-stream-item">
          <span className="sg-cursor">▋</span>
          <span className="sg-stream-pending">Drafting next post…</span>
        </div>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
function SocialGeneratorContent() {
  const { historyEntries, activeBrand, authToken } = useApp();
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [platform, setPlatform] = useState<Platform>(() => {
    if (typeof window === 'undefined') return 'x';
    const saved = localStorage.getItem('forge_social_platform');
    return saved === 'instagram' ? 'instagram' : 'x';
  });
  const [topicPrompt, setTopicPrompt] = useState('');
  const [selectedArcId, setSelectedArcId] = useState<string | null>(null);
  const [arcs, setArcs] = useState<CampaignArc[]>([]);
  const [arcsLoading, setArcsLoading] = useState(false);

  // Regenerate Arcs modal state — lazy-loads brain elements on first open
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState('');
  const [brainElements, setBrainElements] = useState<BrainElements | null>(null);
  const [brainLoading, setBrainLoading] = useState(false);
  const [leanIntoMoats, setLeanIntoMoats] = useState<string[]>([]);
  const [leanIntoPersonas, setLeanIntoPersonas] = useState<string[]>([]);
  const [leanIntoGaps, setLeanIntoGaps] = useState<string[]>([]);
  const [guidance, setGuidance] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mandatories, setMandatories] = useState('');
  const [constraints, setConstraints] = useState('');
  const [audience, setAudience] = useState('');
  const [ctaTarget, setCtaTarget] = useState('');

  const [isRunning, setIsRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [posts, setPosts] = useState<SocialPost[]>([]);
  // Mirror posts to a ref so the 60s fallback timer's closure reads current state.
  useEffect(() => { postsRef.current = posts; }, [posts]);
  const [error, setError] = useState('');
  const streamRef = useRef<EventSource | null>(null);
  // Tracks current posts for the 60s fallback timer's closure — useState reads
  // would otherwise capture stale state from the moment the timer was scheduled.
  const postsRef = useRef<SocialPost[]>([]);
  // Track whether posts were received — used in the SSE error handler to avoid
  // false-alarming when the server cleanly closes the connection after 'complete'.
  const postsReceivedRef = useRef(false);

  // Recent batches (collapsible footer drawer)
  const [recentBatches, setRecentBatches] = useState<{ batch_id: string; created_at: string; platform: Platform; source_topic: string | null; arc_id: string | null; arc_title: string | null; posts: SocialPost[] }[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);

  // Connected publishing channels for this brand — used to enable/disable the
  // 'Publish to X' button on each post card. null = not yet fetched; [] = fetched, none.
  const [connectedChannels, setConnectedChannels] = useState<string[] | null>(null);

  // Brain selector — only show if super-admin has multiple brands
  let brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));
  if (brains.length === 0 && activeBrand) {
    brains.push({ id: activeBrand.id, brandName: activeBrand.brandName || activeBrand.brandUrl, brandUrl: activeBrand.brandUrl });
  }

  // Seed selected brain from active brand context
  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) setSelectedBrainId(id);
  }, []);

  useEffect(() => {
    if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id);
  }, [activeBrand?.id]);

  // Persist platform choice
  useEffect(() => {
    localStorage.setItem('forge_social_platform', platform);
  }, [platform]);

  // Quick Copy handoff — prefill topic + platform once.
  const [handoffBanner, setHandoffBanner] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('forge_quick_copy_social_handoff');
      if (!raw) return;
      sessionStorage.removeItem('forge_quick_copy_social_handoff');
      const data = JSON.parse(raw);
      if (!data || !data.fromQuickCopy) return;
      const topic = (typeof data.topicPrompt === 'string' && data.topicPrompt.trim())
        || (typeof data.body === 'string' ? data.body.trim().slice(0, 280) : '');
      if (topic) setTopicPrompt(topic);
      if (data.platform === 'instagram' || data.platform === 'x') setPlatform(data.platform);
      if (typeof data.body === 'string' && data.body.trim()) {
        setMandatories((m) => m || `Seed angle from Quick Copy:\n${data.body.trim().slice(0, 500)}`);
        setAdvancedOpen(true);
      }
      setHandoffBanner('Prefilled from Quick Copy — pick an arc, then generate.');
    } catch { /* ignore */ }
  }, []);

  // Load arcs when brand changes
  useEffect(() => {
    if (!selectedBrainId || !authToken) { setArcs([]); setArcsLoading(false); return; }
    setArcsLoading(true);
    fetch(`/api/social-generator/arcs/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setArcs(d.arcs || []); else setArcs([]); })
      .catch(() => setArcs([]))
      .finally(() => setArcsLoading(false));
  }, [selectedBrainId, authToken]);

  // Load connected publishing channels when brand changes
  useEffect(() => {
    if (!selectedBrainId || !authToken) { setConnectedChannels(null); return; }
    fetch(`/api/publishing/channels/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => {
        const channels = (d?.channels || []).map((c: { channel: string }) => c.channel);
        setConnectedChannels(channels);
      })
      .catch(() => setConnectedChannels([]));
  }, [selectedBrainId, authToken]);

  // Load recent batches when brand changes
  useEffect(() => {
    if (!selectedBrainId || !authToken) return;
    fetch(`/api/social-generator/recent/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setRecentBatches(d.batches || []); })
      .catch(() => { /* non-fatal */ });
  }, [selectedBrainId, authToken, posts.length /* refresh after generate */]);

  const runGeneration = () => {
    // Arc-first model: an arc must be selected. Custom-topic-only path was
    // removed — if a brand has no arcs, the UI shows a rescan CTA instead of
    // a generation flow. topicPrompt is auto-prefilled from the arc thesis at
    // selection time and may be optionally refined via the 'Narrow this angle'
    // input. Either way, an arc id is required for generation.
    if (!selectedBrainId || !selectedArcId || !topicPrompt.trim()) return;
    setIsRunning(true);
    setStreamText('');
    setPosts([]);
    setError('');

    const qs = new URLSearchParams({ brandProfileId: selectedBrainId, platform, topicPrompt: topicPrompt.trim() });
    if (selectedArcId) qs.set('arcId', selectedArcId);
    if (advancedOpen) {
      if (mandatories.trim()) qs.set('mandatories', mandatories.trim());
      if (constraints.trim()) qs.set('constraints', constraints.trim());
      if (audience.trim()) qs.set('audience', audience.trim());
      if (ctaTarget.trim()) qs.set('ctaTarget', ctaTarget.trim());
    }
    if (authToken) qs.set('token', authToken);

    postsReceivedRef.current = false;
    const es = new EventSource(`/api/social-generator/generate?${qs.toString()}`);
    streamRef.current = es;

    es.addEventListener('busy', (e) => {
      try {
        const d = JSON.parse(e.data);
        const elapsed = d.elapsed ? ` (${d.elapsed}s in)` : '';
        setError(`A social-post run is already in progress for this brand${elapsed}. Try again in a minute.`);
      } catch {}
      setIsRunning(false);
      es.close();
    });

    es.addEventListener('chunk', (e) => {
      setStreamText(prev => prev + e.data);
    });

    es.addEventListener('done', (e) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.posts && Array.isArray(parsed.posts)) {
          postsReceivedRef.current = true;
          setPosts(parsed.posts);
          setStreamText('');
          // Safety net: if SSE drops between 'done' and 'image_done' (proxy buffering, tab idle, etc.)
          // images that successfully generated server-side never make it to the UI. After 60s,
          // hit /recent and merge any image_urls that have been persisted to the DB.
          const batchId = parsed.batchId;
          if (batchId && selectedBrainId && authToken) {
            setTimeout(async () => {
              try {
                const stillPending = (postsRef.current || []).some((p: any) => !p.image_url && p.batch_id === batchId);
                if (!stillPending) return;
                const r2 = await fetch(`/api/social-generator/recent/${selectedBrainId}`, {
                  headers: { 'Authorization': `Bearer ${authToken}` }
                });
                const d2 = await r2.json();
                if (d2.success && Array.isArray(d2.batches)) {
                  const batch = d2.batches.find((b: any) => b.batch_id === batchId);
                  if (batch && Array.isArray(batch.posts)) {
                    setPosts(prev => prev.map(p => {
                      const fresh = batch.posts.find((bp: any) => bp.id === p.id);
                      return fresh && fresh.image_url ? { ...p, image_url: fresh.image_url } : p;
                    }));
                  }
                }
              } catch { /* silent — best-effort fallback */ }
            }, 60000);
          }
        }
      } catch {
        setError('Failed to parse the generated batch. Raw output preserved below.');
      }
      // Wait for image_done events before closing — server keeps SSE open until images return
    });

    es.addEventListener('image_done', (e) => {
      try {
        const d = JSON.parse(e.data);
        // d = { post_id, image_url }
        setPosts(prev => prev.map(p => p.id === d.post_id ? { ...p, image_url: d.image_url } : p));
      } catch {}
    });

    es.addEventListener('image_error', (e) => {
      try {
        const d = JSON.parse(e.data);
        // Mark image as failed — UI shows fallback
        setPosts(prev => prev.map(p => p.id === d.post_id ? { ...p, image_url: null } : p));
      } catch {}
    });

    es.addEventListener('complete', () => {
      setIsRunning(false);
      es.close();
    });

    es.addEventListener('error', (e: any) => {
      es.close();
      setIsRunning(false);
      // postsReceivedRef guards against the spurious error event the browser fires
      // when the server cleanly closes the SSE connection after sending 'complete'.
      if (postsReceivedRef.current) return;
      if (e.data) setError(e.data);
      else setError('Connection lost. The batch may still be generating — refresh in 30 seconds.');
    });
  };

  const reset = () => {
    setPosts([]);
    setStreamText('');
    setError('');
    setSelectedArcId(null);
  };

  // Open the Regenerate Arcs modal. First open lazy-loads brain elements
  // via /api/context-hub/brains/:id (requireAuth, no expires_at filter).
  // Same flattened shape: profile_data fields live at top of d.data.
  //
  // We previously tried /api/context-hub/brand/:brandId, which has an
  // expires_at filter that excludes Forge (and most owned brands whose
  // expiry was set during a trial-style scan and never cleared).
  const openRegenerate = async () => {
    setRegenOpen(true);
    setRegenError('');
    if (brainElements || !selectedBrainId || !authToken) return;
    setBrainLoading(true);
    try {
      const r = await fetch(`/api/context-hub/brains/${selectedBrainId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const d = await r.json();
      if (!d.success || !d.data) {
        setRegenError(d.error || 'Brand not found');
        return;
      }
      const pd = d.data;
      setBrainElements({
        personas: (pd.personas || []).map((p: { id?: string; name?: string; role?: string }) => ({
          id: p.id || p.name || '',
          name: p.name || p.id || 'Unnamed',
          role: p.role
        })),
        moats: (pd.strategicMoats || []).map((m: { capability?: string; protects?: string }) => ({
          capability: m.capability || '',
          protects: m.protects
        })),
        gaps: (pd.competitiveGaps || []).map((g: { topic?: string; priority?: string }) => ({
          topic: g.topic || '',
          priority: g.priority
        })),
      });
    } catch (e) {
      setRegenError(`Could not load brand brain: ${(e as Error).message || 'network error'}`);
    } finally {
      setBrainLoading(false);
    }
  };

  const closeRegenerate = () => {
    setRegenOpen(false);
    setLeanIntoMoats([]); setLeanIntoPersonas([]); setLeanIntoGaps([]);
    setGuidance('');
    setRegenError('');
  };

  const toggleInList = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  const regenerateArcs = async () => {
    if (!selectedBrainId || !authToken || regenLoading) return;
    setRegenLoading(true);
    setRegenError('');
    try {
      const r = await fetch(`/api/social-generator/regenerate-arcs/${selectedBrainId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ leanIntoMoats, leanIntoPersonas, leanIntoGaps, guidance: guidance.trim() })
      });
      const d = await r.json();
      if (!d.success) {
        setRegenError(d.error || 'Regeneration failed');
        return;
      }
      setArcs(d.arcs || []);
      setSelectedArcId(null);
      closeRegenerate();
    } catch (e) {
      setRegenError((e as Error).message || 'Network error');
    } finally {
      setRegenLoading(false);
    }
  };

  const selectArc = (arc: CampaignArc) => {
    if (selectedArcId === arc.id) {
      // Deselect
      setSelectedArcId(null);
      setTopicPrompt('');
    } else {
      setSelectedArcId(arc.id);
      setTopicPrompt(arc.thesis);
    }
  };

  return (
    <div className="sg-container">
      <div className="sg-header">
        <div>
          <div className="sg-eyebrow">Stage 4 — Short-form</div>
          <h1 className="sg-title">Social Generator</h1>
          <p className="sg-description">
            Brain-matched short-form for X and Instagram. Four posts at four angles — provocation, proof, how-to, counter-take — each with a square image tuned for social composition.
          </p>
        </div>
      </div>

      {!isRunning && posts.length === 0 && (
        <div className="sg-input-card">
          {brains.length > 1 && (
            <div className="sg-row">
              <label className="sg-label">Brain</label>
              <select className="sg-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
                <option value="">Select a Brain…</option>
                {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
              </select>
            </div>
          )}

          {/* Platform toggle */}
          <div className="sg-row">
            <label className="sg-label">Platform</label>
            <div className="sg-platform-toggle">
              <button
                type="button"
                className={`sg-platform-btn ${platform === 'x' ? 'active' : ''}`}
                onClick={() => setPlatform('x')}
              >
                <span className="sg-platform-icon">𝕏</span>
                <span>X (Twitter)</span>
                <span className="sg-platform-meta">280 chars · no hashtags by default</span>
              </button>
              <button
                type="button"
                className={`sg-platform-btn ${platform === 'instagram' ? 'active' : ''}`}
                onClick={() => setPlatform('instagram')}
              >
                <span className="sg-platform-icon">◌</span>
                <span>Instagram</span>
                <span className="sg-platform-meta">300 chars · 3-5 hashtags</span>
              </button>
            </div>
          </div>

          {/* Arc picker — the primary entry point. When no arcs exist, brain is
              stale; we show a rescan CTA instead of letting users limp along
              with a custom-topic fallback. */}
          {arcsLoading ? (
            <div className="sg-row">
              <label className="sg-label">Pick a campaign arc</label>
              <div className="sg-arc-loading">Loading arcs from this brand's brain…</div>
            </div>
          ) : arcs.length === 0 ? (
            <div className="sg-row">
              <label className="sg-label">Pick a campaign arc</label>
              <div className="sg-arc-empty">
                <div className="sg-arc-empty-title">No campaign arcs in this brand's brain.</div>
                <div className="sg-arc-empty-body">
                  Campaign arcs are narrative spines for multi-post sequences. Generate a fresh set below, or rescan the brand in Context Hub for a full brain refresh.
                </div>
                <div className="sg-arc-empty-actions">
                  <button type="button" className="sg-arc-empty-cta primary" onClick={openRegenerate}>
                    ↻ Generate new arcs
                  </button>
                  <a className="sg-arc-empty-cta" href="/app/context-hub">
                    Rescan brand in Context Hub →
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="sg-row">
              <div className="sg-arc-header">
                <label className="sg-label">Pick a campaign arc</label>
                <button
                  type="button"
                  className="sg-arc-regen-btn"
                  onClick={openRegenerate}
                  title="Generate a fresh set of campaign arcs"
                >
                  ↻ Generate new arcs
                </button>
              </div>
              <div className="sg-arc-list">
                {arcs.map(arc => (
                  <button
                    key={arc.id}
                    type="button"
                    className={`sg-arc-chip ${selectedArcId === arc.id ? 'active' : ''}`}
                    onClick={() => selectArc(arc)}
                  >
                    <span className="sg-arc-title">{arc.title}</span>
                    <span className="sg-arc-thesis">{arc.thesis.slice(0, 90)}{arc.thesis.length > 90 ? '…' : ''}</span>
                  </button>
                ))}
              </div>
              {selectedArcId && (
                <div className="sg-arc-active-hint">
                  Arc selected — the posts will advance this thesis.
                </div>
              )}
            </div>
          )}

          {/* Narrow this angle — optional refinement, ONLY shown after an arc is
              selected. Pre-filled with the arc thesis so the user can edit in
              place rather than re-typing. Acts as a refinement, not a separate
              entry point. */}
          {selectedArcId && (
            <div className="sg-row">
              <label className="sg-label">
                Narrow this angle <span className="sg-label-optional">(optional)</span>
              </label>
              <textarea
                className="sg-textarea"
                placeholder="Edit to focus the arc on a specific cut. The Brain expands into 4 angles: provocation, proof, how-to, counter-take."
                value={topicPrompt}
                onChange={e => setTopicPrompt(e.target.value)}
                rows={3}
              />
              <div className="sg-hint">
                The arc's thesis is pre-filled. Tighten it to a specific take if you want this batch to focus on one slice rather than the whole arc.
              </div>
            </div>
          )}

          {/* Advanced panel */}
          <div className="sg-advanced">
            <button
              type="button"
              className="sg-advanced-toggle"
              onClick={() => setAdvancedOpen(o => !o)}
            >
              <span>Advanced direction — mandatories, audience, CTA <span className="sg-advanced-optional">(optional)</span></span>
              <span className="sg-advanced-chevron">{advancedOpen ? '−' : '+'}</span>
            </button>
            {advancedOpen && (
              <div className="sg-advanced-body">
                <div className="sg-field">
                  <label className="sg-field-label">Mandatories</label>
                  <div className="sg-field-help">Required disclaimers, must-include phrases, time-bound claims.</div>
                  <textarea
                    className="sg-input-text"
                    rows={2}
                    value={mandatories}
                    onChange={e => setMandatories(e.target.value)}
                    placeholder="e.g. Must mention the 7-day trial. CTA links to /trial."
                  />
                </div>
                <div className="sg-field">
                  <label className="sg-field-label">Constraints</label>
                  <div className="sg-field-help">What posts must NOT do.</div>
                  <textarea
                    className="sg-input-text"
                    rows={2}
                    value={constraints}
                    onChange={e => setConstraints(e.target.value)}
                    placeholder="e.g. No competitor names. No generic 'AI is changing everything' framing."
                  />
                </div>
                <div className="sg-grid-2">
                  <div className="sg-field">
                    <label className="sg-field-label">Target audience</label>
                    <input
                      type="text"
                      className="sg-input-text"
                      value={audience}
                      onChange={e => setAudience(e.target.value)}
                      placeholder="e.g. RevOps leaders at Series B SaaS"
                    />
                  </div>
                  <div className="sg-field">
                    <label className="sg-field-label">CTA target URL/path</label>
                    <input
                      type="text"
                      className="sg-input-text"
                      value={ctaTarget}
                      onChange={e => setCtaTarget(e.target.value)}
                      placeholder="e.g. /trial or /book-demo"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="sg-actions">
            <button
              className="sg-generate-btn"
              onClick={runGeneration}
              disabled={!selectedBrainId || !selectedArcId || !topicPrompt.trim()}
            >
              <Zap size={14} /> Generate 4 posts
            </button>
          </div>
        </div>
      )}

      {isRunning && posts.length === 0 && (
        <div className="sg-running">
          <div className="sg-running-header">
            <Zap size={14} />
            <span>Generating — Brain is writing for {platform === 'x' ? 'X' : 'Instagram'}…</span>
          </div>
          <div className="sg-running-body">
            <StreamProgress text={streamText} />
          </div>
        </div>
      )}

      {handoffBanner && (
        <div className="sg-error" style={{ background: 'rgba(79,70,229,0.08)', borderColor: 'rgba(79,70,229,0.25)', color: 'var(--color-accent)', marginBottom: 12 }}>
          <span>{handoffBanner}</span>
          <button type="button" onClick={() => setHandoffBanner(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
        </div>
      )}
      {error && <div className="sg-error">{error}</div>}

      {posts.length > 0 && (
        <>
          <div className="sg-results-header">
            <div>
              <span className="sg-results-label">Generated {posts.length} posts for {(posts[0]?.platform ?? platform) === 'x' ? 'X' : 'Instagram'}</span>
              <span className="sg-results-sub">Edit inline · copy and paste into your platform</span>
            </div>
            <button className="sg-secondary-btn" onClick={reset}>Generate another batch</button>
          </div>

          <div className="sg-grid">
            {posts.map(post => (
              <PostCard key={post.id} post={post} authToken={authToken} xConnected={connectedChannels?.includes('x') ?? false} onUpdate={(updated) => {
                setPosts(prev => prev.map(p => p.id === updated.id ? updated : p));
              }} />
            ))}
          </div>
        </>
      )}

      {/* Recent batches drawer */}
      {recentBatches.length > 0 && (
        <div className="sg-recent">
          <button className="sg-recent-toggle" onClick={() => setRecentOpen(o => !o)}>
            <span>Recent batches</span>
            <span className="sg-recent-count">{recentBatches.length}</span>
            <span className="sg-recent-chevron">{recentOpen ? '−' : '+'}</span>
          </button>
          {recentOpen && (
            <div className="sg-recent-list">
              {recentBatches.map(batch => (
                <div key={batch.batch_id} className="sg-recent-item">
                  <div className="sg-recent-meta">
                    <span className="sg-recent-platform">{batch.platform === 'x' ? 'X' : 'Instagram'}</span>
                    <span className="sg-recent-date">{(() => {
                      if (!batch.created_at) return '—';
                      // Postgres TIMESTAMPTZ via pg driver -> JS Date -> JSON ISO string.
                      // Some code paths send 'YYYY-MM-DD HH:MM:SS' (no T, no Z); normalize that.
                      const raw = String(batch.created_at);
                      const normalized = /T/.test(raw) ? raw : raw.replace(' ', 'T') + (/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? '' : 'Z');
                      const d = new Date(normalized);
                      return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                    })()}</span>
                  </div>
                  {batch.arc_title && (
                    <div className="sg-recent-arc" title={`Brand arc: ${batch.arc_title}`}>
                      <span className="sg-recent-arc-label">Arc</span>
                      <span className="sg-recent-arc-title">{batch.arc_title}</span>
                    </div>
                  )}
                  <div className="sg-recent-topic">{batch.source_topic || '—'}</div>
                  <button
                    className="sg-recent-load"
                    onClick={() => { setPosts(batch.posts); setStreamText(''); setError(''); }}
                  >
                    Open batch →
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Regenerate Arcs modal */}
      {regenOpen && (
        <div className="sg-modal-overlay" onClick={closeRegenerate}>
          <div className="sg-modal" onClick={e => e.stopPropagation()}>
            <div className="sg-modal-header">
              <div className="sg-modal-title">Generate new campaign arcs</div>
              <button className="sg-modal-close" onClick={closeRegenerate}>×</button>
            </div>
            <div className="sg-modal-body">
              <p className="sg-modal-intro">
                Pick which brand elements to lean into. Leave everything unchecked to let the model use the full brain. Existing arc titles are passed in as “do not duplicate.”
              </p>

              {brainLoading ? (
                <div className="sg-modal-loading">Loading brand brain…</div>
              ) : !brainElements ? (
                <div className="sg-modal-error">Could not load brain. Try closing and reopening.</div>
              ) : (
                <>
                  {brainElements.moats.length > 0 && (
                    <div className="sg-modal-section">
                      <div className="sg-modal-section-label">Strategic moats to emphasize</div>
                      <div className="sg-modal-chips">
                        {brainElements.moats.map(m => (
                          <button
                            key={m.capability}
                            type="button"
                            className={`sg-modal-chip ${leanIntoMoats.includes(m.capability) ? 'active' : ''}`}
                            onClick={() => toggleInList(leanIntoMoats, setLeanIntoMoats, m.capability)}
                          >
                            {m.capability}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {brainElements.personas.length > 0 && (
                    <div className="sg-modal-section">
                      <div className="sg-modal-section-label">Personas to target</div>
                      <div className="sg-modal-chips">
                        {brainElements.personas.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            className={`sg-modal-chip ${leanIntoPersonas.includes(p.id) ? 'active' : ''}`}
                            onClick={() => toggleInList(leanIntoPersonas, setLeanIntoPersonas, p.id)}
                          >
                            {p.name}{p.role ? ` — ${p.role}` : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {brainElements.gaps.length > 0 && (
                    <div className="sg-modal-section">
                      <div className="sg-modal-section-label">Competitive gaps to lean into</div>
                      <div className="sg-modal-chips">
                        {brainElements.gaps.map(g => (
                          <button
                            key={g.topic}
                            type="button"
                            className={`sg-modal-chip ${leanIntoGaps.includes(g.topic) ? 'active' : ''}`}
                            onClick={() => toggleInList(leanIntoGaps, setLeanIntoGaps, g.topic)}
                          >
                            {g.topic}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="sg-modal-section">
                    <div className="sg-modal-section-label">Optional guidance</div>
                    <textarea
                      className="sg-modal-textarea"
                      value={guidance}
                      onChange={e => setGuidance(e.target.value.slice(0, 500))}
                      placeholder="e.g. 'Less event-focused, more attribution methodology' or 'Make arcs more provocative'"
                      rows={3}
                    />
                    <div className="sg-modal-charcount">{guidance.length} / 500</div>
                  </div>
                </>
              )}

              {regenError && <div className="sg-modal-error">{regenError}</div>}
            </div>
            <div className="sg-modal-footer">
              <button className="sg-modal-btn" onClick={closeRegenerate} disabled={regenLoading}>Cancel</button>
              <button
                className="sg-modal-btn primary"
                onClick={regenerateArcs}
                disabled={regenLoading || !brainElements}
              >
                {regenLoading ? 'Generating…' : 'Generate new arcs'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Post card with inline edit + queue ─────────────────────────────────────
function PostCard({ post, authToken, xConnected, onUpdate }: { post: SocialPost; authToken: string | null; xConnected: boolean; onUpdate: (p: SocialPost) => void }) {
  const { reportError } = useApp();
  const [isEditing, setIsEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(post.user_edited_body || post.body);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [shareTipOpen, setShareTipOpen] = useState(false);

  const isPublished = post.status === 'published' && !!post.published_url;

  // Share the post image via Web Share API (with file blob, NOT URL).
  // Why: mobile browsers' long-press → 'Share to Instagram' shares the image URL string,
  // not the image file — Instagram interprets that as a link share, not a photo post.
  // Web Share API with files attached gets the OS to treat it as a real image share, so
  // Instagram's share-target opens its photo composer with the image pre-loaded.
  // Fallback: if the browser doesn't support file sharing, download the image so the user
  // can manually post it from their camera roll.
  const handleShareImage = async (imageUrl: string, filenameSeed: string) => {
    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
      const blob = await imgRes.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').toLowerCase();
      const safeName = (filenameSeed || 'forge-image').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'forge-image';
      const file = new File([blob], `${safeName}.${ext}`, { type: blob.type });

      // Web Share API with files — supported on iOS Safari 15+, Chrome Android, Chrome iOS.
      // canShare() returns false (or is undefined) on browsers that can't share files.
      const navAny = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (navAny.canShare && navAny.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }

      // Fallback: trigger a download so the user can post it themselves.
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e: unknown) {
      // AbortError fires when the user dismisses the share sheet — not an error to surface.
      if (e instanceof Error && e.name === 'AbortError') return;
      console.error('[share-image] failed:', e);
      reportError(e, { area: 'social-generator' });
      alert(`Couldn't share the image: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  const handlePublishX = async () => {
    if (!confirm('Publish this post to X now?')) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch(`/api/social-generator/publish-x/${post.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
      });
      const d = await res.json();
      if (d.success && d.post) {
        onUpdate(d.post);
      } else {
        // Surface code-aware messaging.
        if (d.code === 'X_NOT_CONNECTED' || d.code === 'X_AUTH_EXPIRED') {
          setPublishError(`${d.error} Open Integrations to fix.`);
        } else if (d.code === 'X_MEDIA_UPLOAD_FAILED') {
          setPublishError(`${d.error} Try publishing again in a moment.`);
        } else if (d.code === 'X_MEDIA_UPLOAD_NOT_CONFIGURED') {
          setPublishError(`${d.error}`);
        } else {
          setPublishError(d.error || 'Failed to publish to X.');
        }
      }
    } catch(e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setPublishing(false);
    }
  };

  const displayBody = post.user_edited_body || post.body;
  // While editing, count the live textarea value so the user sees it climb/drop in real time.
  // While not editing, count the saved text. Instagram includes hashtags inline; X does not.
  const effectiveBody = isEditing ? editedBody : displayBody;
  const charCount = effectiveBody.length + (post.platform === 'instagram' && post.hashtags.length ? ('\n\n' + post.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ')).length : 0);
  const tier = charTier(charCount, post.platform);
  const overXLimit = post.platform === 'x' && isEditing && editedBody.length > 280;
  const angleColor = ANGLE_COLORS[post.angle] || '#3563FF';

  const tierColorByConf = (t: ConfidenceTier) => t === 'green' ? '#14B8A6' : t === 'yellow' ? '#F5B942' : '#EF4444';

  const handleCopy = () => {
    let text = displayBody;
    if (post.hashtags.length && post.platform === 'instagram') {
      text += '\n\n' + post.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
    }
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const [saveError, setSaveError] = useState<string | null>(null);
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/social-generator/edit/${post.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ user_edited_body: editedBody }),
      });
      const d = await res.json();
      if (d.success && d.post) {
        onUpdate(d.post);
        setIsEditing(false);
      } else if (d.error) {
        setSaveError(d.error);
      } else {
        setSaveError('Save failed. Please try again.');
      }
    } catch(e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sg-post-card">
      <div className="sg-post-image-wrap">
        {post.image_url ? (
          <img src={post.image_url} alt={post.hook} className="sg-post-image" />
        ) : (
          <div className="sg-post-image-placeholder">
            <span className="sg-spinner" />
            <span>Generating image…</span>
          </div>
        )}
        <span className="sg-angle-badge" style={{ background: angleColor + '22', color: angleColor, borderColor: angleColor + '44' }}>
          {ANGLE_LABELS[post.angle] || post.angle}
        </span>
        {post.image_url && (
          <div className="sg-share-cluster">
            <button
              type="button"
              className="sg-share-tip-btn"
              onClick={() => setShareTipOpen(v => !v)}
              aria-label={shareTipOpen ? 'Hide Instagram instructions' : 'Show Instagram instructions'}
              title="How to post to Instagram"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            </button>
            <button
              type="button"
              className="sg-image-share-btn"
              onClick={() => handleShareImage(post.image_url!, post.hook || 'forge-image')}
              title="Share image"
              aria-label="Share image"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            </button>
            {shareTipOpen && (
              <div className="sg-share-tip-pop" role="tooltip" onClick={(e) => e.stopPropagation()}>
                <div className="sg-share-tip-title">Post to Instagram</div>
                <ol className="sg-share-tip-steps">
                  <li>Copy the post text below</li>
                  <li>Tap the share icon → select Instagram</li>
                  <li>Paste the text as your caption</li>
                </ol>
                <button type="button" className="sg-share-tip-close" onClick={() => setShareTipOpen(false)} aria-label="Close">×</button>
              </div>
            )}
          </div>
        )}
      </div>

      {post.image_url && (
        <div className="sg-image-credit">AI illustration courtesy of fal.ai</div>
      )}

      <div className="sg-post-body">
        {post.hook && <div className="sg-post-hook">{post.hook}</div>}

        {isEditing ? (
          <textarea
            className="sg-post-edit-area"
            value={editedBody}
            onChange={e => setEditedBody(e.target.value)}
            rows={post.platform === 'x' ? 4 : 6}
          />
        ) : (
          <div className="sg-post-text">{displayBody}</div>
        )}

        {post.hashtags.length > 0 && (
          <div className="sg-hashtags">
            {post.hashtags.map((h, i) => (
              <span key={i} className="sg-hashtag">{h.startsWith('#') ? h : '#' + h}</span>
            ))}
          </div>
        )}

        <div className="sg-post-meta">
          <span className="sg-char" style={{ color: tier.color }}>
            {charCount} chars · {tier.label}
          </span>
          <span className="sg-confidence" style={{ background: tierColorByConf(post.confidence_tier) + '22', color: tierColorByConf(post.confidence_tier) }}>
            {post.confidence}% — {post.confidence_reason}
          </span>
        </div>

        <div className="sg-post-actions">
          {!isEditing ? (
            <>
              <button className="sg-action-btn" onClick={handleCopy}>
                <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="sg-action-btn" onClick={() => { setEditedBody(post.user_edited_body || post.body); setIsEditing(true); }} disabled={isPublished}>
                <Edit size={12} /> Edit
              </button>
              {post.platform === 'x' && (
                isPublished ? (
                  <a className="sg-action-btn sg-action-btn-published" href={post.published_url || '#'} target="_blank" rel="noreferrer">
                    Published — View on X →
                  </a>
                ) : (
                  <button
                    className="sg-action-btn sg-action-btn-primary"
                    onClick={handlePublishX}
                    disabled={publishing || !xConnected}
                    title={!xConnected ? 'X is not connected for this brand. Open Integrations to connect.' : 'Publish this post to X now'}
                  >
                    {publishing ? 'Publishing…' : (xConnected ? 'Publish to X' : 'X not connected')}
                  </button>
                )
              )}
              {publishError && (
                <a className="sg-publish-error" href="/app/integrations" target="_self" title={publishError}>{publishError.length > 60 ? publishError.slice(0, 57) + '…' : publishError}</a>
              )}
            </>
          ) : (
            <>
              <button className="sg-action-btn" onClick={() => { setIsEditing(false); setSaveError(null); }} disabled={saving}>Cancel</button>
              <button
                className="sg-action-btn sg-action-btn-primary"
                onClick={handleSave}
                disabled={saving || !editedBody.trim() || overXLimit}
                title={overXLimit ? `${editedBody.length} characters — trim to 280 or fewer to save.` : undefined}
              >
                {saving ? 'Saving…' : overXLimit ? `${editedBody.length}/280 — too long` : 'Save edit'}
              </button>
              {saveError && <span className="sg-publish-error" title={saveError}>{saveError.length > 60 ? saveError.slice(0, 57) + '…' : saveError}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SocialGeneratorPage() {
  return <AppShell><SocialGeneratorContent /></AppShell>;
}
