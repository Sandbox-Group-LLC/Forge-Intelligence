import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './ContentGeneratorPage.css';

const ShieldCheck = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>
  </svg>
);
const FileText = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
  </svg>
);
const Zap = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

interface Brain { id: string; brandName: string; brandUrl: string; }
interface EnrichedBrief {
  id: string;
  brandName: string;
  confidenceScore: number;
  createdAt: string;
  topic?: string | null;
  topicBriefId?: string | null;
  enrichedTitle?: string | null;
  enrichedH1?: string | null;
  discoverySessionId?: string | null;
  quickWin?: boolean;
  // Article generation state for batch progress footer
  hasArticle?: boolean;
  articleId?: string | null;
  articleTitle?: string | null;
  articleStatus?: string | null; // approved | needs_review | etc
  articlePublishStatus?: string | null; // draft | scheduled | published
  queueStatus?: string | null; // from publishing_queue: pending | scheduled | published | failed
  isOrphan?: boolean; // article whose enriched brief was deleted (legacy)
}

interface ArticleSection {
  id: string;
  heading: string;
  body: string;
  confidence: number;
  confidenceTier: 'green' | 'yellow' | 'red';
  confidenceReason: string;
  eeatInjections: string[];
  smeHooks: string[];
}

interface GeneratedArticle {
  title: string;
  metaDescription: string;
  estimatedReadTime: string;
  overallConfidence: number;
  sections: ArticleSection[];
  authorBlock: { suggestedByline: string; schemaMarkup: object };
  citationOpportunities: string[];
  brainMatchScore: number;
}


// ── Stream progress — shows section titles as they appear, hides raw JSON ────
function StreamProgress({ text }: { text: string }) {
  const headings = Array.from(text.matchAll(/"heading":\s*"([^"]{8,80})"/g))
    .map(m => m[1])
    .filter((h, i, arr) => arr.indexOf(h) === i); // dedupe

  if (!headings.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0' }}>
        <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', color: '#3563FF', fontSize: '20px' }}>▋</span>
        <span style={{ color: '#475569', fontSize: '13px' }}>Analyzing Brain context...</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ fontSize: '12px', color: '#475569', marginBottom: '4px' }}>
        Writing {headings.length} section{headings.length !== 1 ? 's' : ''}...
      </div>
      {headings.map((h, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ color: '#14B8A6', fontSize: '12px' }}>✓</span>
          <span style={{ fontSize: '13px', color: '#94A3B8' }}>{h}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', color: '#3563FF', fontSize: '14px' }}>▋</span>
        <span style={{ fontSize: '13px', color: '#475569' }}>Writing next section...</span>
      </div>
    </div>
  );
}

function ContentGeneratorContent() {
  const [briefs, setBriefs] = useState<EnrichedBrief[]>([]);
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [selectedBriefId, setSelectedBriefId] = useState(() => {
    // Pre-select if we came from Enricher with ?enrichedBriefId=... in URL
    if (typeof window !== 'undefined') {
      const urlId = new URLSearchParams(window.location.search).get('enrichedBriefId');
      return urlId || '';
    }
    return '';
  });
  const [isRunning, setIsRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [article, setArticle] = useState<GeneratedArticle | null>(null);
  const [articleImageUrl, setArticleImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'article' | 'meta' | 'schema'>('article');
  const streamRef = useRef<EventSource | null>(null);
  const [topicPrompt, setTopicPrompt] = useState('');
  // Manual-topic constraint fields (mirrors EmailCampaignPage's Mandatories & Constraints,
  // expanded for article-shaped output). Only sent to the server when topic is typed AND
  // user has opened the advanced panel — both gates intentional so the brief-driven path
  // stays clean.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mandatories, setMandatories] = useState('');
  const [constraints, setConstraints] = useState('');
  const [audience, setAudience] = useState('');
  const [ctaTarget, setCtaTarget] = useState('');
  const [desiredAction, setDesiredAction] = useState('');
  const [wordCountTarget, setWordCountTarget] = useState('');
  const [writingAs, setWritingAs] = useState(''); // '' = brief default, 'company', or an author id
  const [availableAuthors, setAvailableAuthors] = useState<Array<{ id: string; name: string; title?: string }>>([]);
  const [ideaDrawerOpen, setIdeaDrawerOpen] = useState(false);
  const [ideas, setIdeas] = useState<{id:string;topic:string;note:string|null;status:string;created_at:string}[]>([]);
  const [newIdea, setNewIdea] = useState('');
  const [newIdeaNote, setNewIdeaNote] = useState('');
  const [savingIdea, setSavingIdea] = useState(false);
  const [preflight, setPreflight] = useState<{ status: string; signal?: string; confidence?: string; reframe?: string; reframeRationale?: string; reason?: string }>({ status: 'idle' });
  const [buildingBrief, setBuildingBrief] = useState(false);

  const navigate = useNavigate();
  const { historyEntries, activeBrand, authToken } = useApp();
  let brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));

  // Ensure current brand appears in dropdown even if historyEntries hasn't loaded yet (auth redirect race)
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

  // Auto-hydrate REMOVED: Content Generator no longer silently restores the last finished article.
  // The user's current context is their cherry-pick batch, not whichever article happens to be latest.
  // If they arrived with ?enrichedBriefId=X, the batch card for that brief is pre-selected (see state init).
  // If no param, they see the full batch and pick what to work on next.
  // The only way to see a previously-generated article is via Content Library, where it belongs.

  // Brief fetcher — refactored to support refetching on tab focus and explicit triggers.
  // Original bug: useEffect only fired on mount + selectedBrainId/authToken change. If user
  // enriched a brief in another tab/page and came back, briefs state was stale and the new
  // brief never appeared. Now the fetcher reruns on visibilitychange + window focus events.
  const fetchBriefs = React.useCallback(() => {
    if (!selectedBrainId || !authToken) return;
    fetch(`/api/content-generator/enriched-briefs/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setBriefs(d.briefs || []);
          if (typeof window !== 'undefined') {
            const urlObj = new URL(window.location.href);
            if (urlObj.searchParams.has('enrichedBriefId')) {
              urlObj.searchParams.delete('enrichedBriefId');
              window.history.replaceState({}, '', urlObj.toString());
            }
          }
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [selectedBrainId, authToken]);

  // Load the brand's Factual Ground authors so "Writing as" can offer real people,
  // not just the company default.
  useEffect(() => {
    if (!selectedBrainId || !authToken) { setAvailableAuthors([]); return; }
    fetch(`/api/factual-ground/authors/${selectedBrainId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setAvailableAuthors(d.authors || []); })
      .catch(() => { /* non-fatal */ });
  }, [selectedBrainId, authToken]);

  useEffect(() => {
    if (!selectedBrainId) { setBriefs([]); setSelectedBriefId(''); return; }
    if (!authToken) return;
    loadIdeas(selectedBrainId);
    fetchBriefs();
  }, [selectedBrainId, authToken]);

  // Refetch when tab regains visibility (user switched away to enrich, then came back)
  // and on window focus. Both cover the workflow where the user navigates between
  // pages or tabs without unmounting Content Generator.
  useEffect(() => {
    if (!selectedBrainId || !authToken) return;
    const onVis = () => { if (document.visibilityState === 'visible') fetchBriefs(); };
    const onFocus = () => fetchBriefs();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
    };
  }, [selectedBrainId, authToken, fetchBriefs]);

  const checkTopic = async () => {
    if (!selectedBrainId || !topicPrompt.trim()) { setPreflight({ status: 'idle' }); return; }
    setPreflight({ status: 'checking' });
    try {
      const r = await fetch('/api/content/topic-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: topicPrompt })
      });
      const d = await r.json();
      if (d.success) setPreflight({ status: 'done', ...d });
      else setPreflight({ status: 'idle' });
    } catch { setPreflight({ status: 'idle' }); }
  };

  const loadIdeas = async (brandId: string) => {
    if (!brandId) return;
    const d = await fetch(`/api/topic-ideas/${brandId}`, { headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} }).then(r => r.json());
    if (d.success) setIdeas(d.ideas);
  };

  const saveIdea = async () => {
    if (!newIdea.trim() || !selectedBrainId) return;
    setSavingIdea(true);
    try {
      const d = await fetch('/api/topic-ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: newIdea.trim(), note: newIdeaNote.trim() || null })
      }).then(r => r.json());
      if (d.success) { setIdeas(prev => [d.idea, ...prev]); setNewIdea(''); setNewIdeaNote(''); }
    } finally { setSavingIdea(false); }
  };

  const deleteIdea = async (id: string) => {
    await fetch(`/api/topic-ideas/${id}`, { method: 'DELETE' });
    setIdeas(prev => prev.filter(i => i.id !== id));
  };

  const useIdea = (idea: { id: string; topic: string }) => {
    setTopicPrompt(idea.topic);
    fetch(`/api/topic-ideas/${idea.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' })
    });
    setIdeas(prev => prev.map(i => i.id === idea.id ? { ...i, status: 'in_progress' } : i));
    setIdeaDrawerOpen(false);
    setTimeout(() => document.querySelector<HTMLElement>('.cg-topic-input')?.focus(), 150);
  };

  // User typed a topic but hasn't selected an existing enriched brief — enter
  // the pipeline at the brief-creation stage and hand off to the Authenticity
  // Enricher (which auto-fires when arriving with ?topicBriefId=X).
  const buildBriefFromTopic = async () => {
    if (!activeBrand?.id || !topicPrompt.trim() || buildingBrief) return;
    setBuildingBrief(true);
    try {
      const r = await fetch('/api/geo/topic-brief/from-topic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId: activeBrand.id,
          topic: topicPrompt.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Brief build failed');
      navigate(`/app/authenticity-enricher?topicBriefId=${d.briefId}`);
    } catch (e) {
      console.error('[CG] from-topic brief build failed:', (e as Error).message);
      alert(`Couldn't build brief from topic: ${(e as Error).message}`);
    } finally {
      setBuildingBrief(false);
    }
  };

  const runGeneration = () => {
    if (!selectedBrainId) return;
    setIsRunning(true);
    setStreamText('');
    setArticle(null);
    setArticleImageUrl(null);
    setImageLoading(true);
    setError('');

    // Build the SSE URL via URLSearchParams — cleaner than chained ternaries now that
    // we have 6 optional constraint params on top of brandProfileId/enrichedBriefId/topicPrompt.
    const qs = new URLSearchParams({ brandProfileId: selectedBrainId });
    if (selectedBriefId) qs.set('enrichedBriefId', selectedBriefId);
    if (topicPrompt.trim()) qs.set('topicPrompt', topicPrompt.trim());
    if (topicPrompt.trim() && advancedOpen) {
      if (mandatories.trim()) qs.set('mandatories', mandatories.trim());
      if (constraints.trim()) qs.set('constraints', constraints.trim());
      if (audience.trim()) qs.set('audience', audience.trim());
      if (ctaTarget.trim()) qs.set('ctaTarget', ctaTarget.trim());
      if (desiredAction.trim()) qs.set('desiredAction', desiredAction.trim());
      if (wordCountTarget.trim()) qs.set('wordCountTarget', wordCountTarget.trim());
    }
    if (writingAs) qs.set('writingAs', writingAs);
    if (authToken) qs.set('token', authToken);
    const es = new EventSource(`/api/content-generator/generate?${qs.toString()}`);
    streamRef.current = es;

    es.addEventListener('busy', (e) => {
      try {
        const d = JSON.parse(e.data);
        const elapsed = d.elapsed ? ` (${d.elapsed}s in)` : '';
        setError(`Generation already in progress${elapsed}. Come back in a minute — your article is being written.`);
        setIsRunning(false);
      } catch {}
      es.close();
    });

    es.addEventListener('chunk', (e) => {
      setStreamText(prev => prev + e.data);
    });

    es.addEventListener('done', (e) => {
      setIsRunning(false);
      try {
        const parsed = JSON.parse(e.data);
        setArticle(parsed);
        setStreamText('');
        setImageLoading(true);
      } catch {
        es.close();
        setImageLoading(false);
        setError('Failed to parse generated article. Raw output preserved.');
        setStreamText(prev => prev || e.data);
      }
    });
    es.addEventListener('image_done', (e) => {
      try { const d = JSON.parse(e.data); setArticleImageUrl(d.image_url); } catch {}
      setImageLoading(false);
      es.close();
    });
    es.addEventListener('image_error', () => {
      setImageLoading(false);
      es.close();
    });

    es.addEventListener('error', (e: any) => {
      es.close();
      setIsRunning(false);
      setImageLoading(false);
      // SSE dropped — check if article was actually generated (iOS tab suspension kills streams)
      if (!e.data) {
        const checkGenerated = async () => {
          try {
            const safeId = selectedBrainId.replace(/-/g, '_');
            const checkRes = await fetch(`/api/content/${safeId}/latest`, {
              headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
            });
            const checkData = await checkRes.json();
            if (checkData.success && checkData.article) {
              setArticle(checkData.article);
              setStreamText('');
              setError('');
              return;
            }
          } catch {}
          setError('Connection lost — your article may still be generating. Refresh in 30 seconds.');
        };
        setTimeout(checkGenerated, 3000);
      } else {
        setError(e.data);
      }
    });
  };

  const tierColor = (tier: string) => {
    if (tier === 'green') return '#10B981';
    if (tier === 'yellow') return '#F5B942';
    return '#EF4444';
  };

  const tierLabel = (tier: string) => {
    if (tier === 'green') return '🟢';
    if (tier === 'yellow') return '🟡';
    return '🔴';
  };

  return (
    <div className="geo-content">
      <div className="geo-header">
        <div>
          <div className="geo-eyebrow">Stage 4</div>
          <h1 className="geo-title">Content Generator</h1>
          <p className="geo-description">
            Transforms your Enriched Brief into a Brain-matched, GEO-optimized long-form article with per-section confidence scoring.
          </p>
        </div>
        <div className="cg-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="cg-header-btn" onClick={() => setIdeaDrawerOpen(!ideaDrawerOpen)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 'var(--radius-sm)', background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
            <span className="btn-icon-decorative"><Zap size={14} /></span> {ideaDrawerOpen ? 'Close Ideas' : '+ Ideas'}
          </button>
          {article && (
            <div className="geo-score-badge">
              <div className="score-value">{article.overallConfidence}</div>
              <div className="score-label">Confidence</div>
            </div>
          )}
        </div>
      </div>

      {!isRunning && !article && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Brand (Brain) selector — only needed for users with multiple brands */}
          {brains.length > 1 && (
            <div className="geo-input-bar">
              <div className="geo-select-wrap" style={{ flex: 1 }}>
                <select className="geo-select" value={selectedBrainId} onChange={e => setSelectedBrainId(e.target.value)}>
                  <option value="">Select a Brain...</option>
                  {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Unified enriched-brief selection — replaces the old dual surface (batch cards + dropdown).
              All ungenerated enriched briefs render as cards, sorted newest-first. The most recent
              discovery session gets a subtle "Latest" chip on its cards for visual grouping without
              needing a separate batch section. */}
          {briefs.length === 0 ? (
            <div className="cg-batch-section" style={{ textAlign: 'center', padding: '32px 24px' }}>
              <div style={{ color: 'var(--color-text-muted, #94a3b8)', fontSize: 14, marginBottom: 6 }}>No enriched briefs yet</div>
              <div style={{ color: 'var(--color-text-secondary, #475569)', fontSize: 13 }}>Run the Authenticity Enricher on a GEO topic brief to generate one.</div>
            </div>
          ) : (() => {
            // All ungenerated briefs, newest first
            const available = briefs
              .filter(b => !b.hasArticle)
              .slice()
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            if (available.length === 0) {
              return (
                <div className="cg-batch-section" style={{ textAlign: 'center', padding: '24px' }}>
                  <div style={{ color: 'var(--color-text-muted, #94a3b8)', fontSize: 14 }}>All enriched briefs have been generated into articles. Run Enricher on more topics to queue new work.</div>
                </div>
              );
            }
            // Identify the most recent discovery session so we can visually flag its cards
            const latestSession = available.find(b => b.discoverySessionId)?.discoverySessionId;
            return (
              <div className="cg-batch-section">
                <div className="cg-batch-header">
                  <span className="cg-batch-label">Enriched briefs ready to generate</span>
                  <span className="cg-batch-sub">{available.length} {available.length === 1 ? 'brief' : 'briefs'} · newest first</span>
                </div>
                <div className="cg-batch-grid">
                  {available.map(b => {
                    const isLatest = latestSession && b.discoverySessionId === latestSession;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`cg-batch-card ${selectedBriefId === b.id ? 'selected' : ''}`}
                        onClick={() => setSelectedBriefId(b.id)}
                      >
                        <div className="cg-batch-card-top">
                          {b.quickWin && <span className="cg-batch-qw">⚡ Quick Win</span>}
                          {isLatest && !b.quickWin && <span className="cg-batch-qw" style={{ background: '#DBEAFE', color: '#1E40AF' }}>Latest</span>}
                          <span className="cg-batch-confidence">Confidence {b.confidenceScore}</span>
                        </div>
                        <div className="cg-batch-topic">{b.enrichedTitle || b.enrichedH1 || b.topic || b.articleTitle || b.brandName}</div>
                        <div className="cg-batch-date">{new Date(b.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {selectedBrainId && (
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', whiteSpace: 'nowrap' }}>Writing as</label>
              <select
                value={writingAs}
                onChange={e => setWritingAs(e.target.value)}
                title="Who is speaking in this article: the company (third-person) or a named person (first-person). Leave on Brief default to let the enriched brief's own editorial contract decide."
                style={{ padding: '6px 10px', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, background: 'var(--color-bg-card, #fff)' }}
              >
                <option value="">Brief default</option>
                <option value="company">Company (third-person)</option>
                {availableAuthors.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.title ? ` — ${a.title}` : ''} (first-person)</option>
                ))}
              </select>
            </div>
          )}

          <div className="geo-input-bar">
          <div style={{ flex: 1 }}>
            <input
              className="geo-input cg-topic-input"
              placeholder={selectedBriefId ? "Optional: refine the angle within the selected brief" : "Type a topic to start the pipeline (no GEO Strategist run required)"}
              value={topicPrompt}
              onChange={e => { setTopicPrompt(e.target.value); setPreflight({ status: 'idle' }); }}
              onBlur={checkTopic}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            {preflight.status === 'checking' && (
              <div className="cg-preflight-checking">Brain checking topic alignment...</div>
            )}
            {preflight.status === 'done' && (
              <div className={`cg-preflight cg-preflight-${preflight.signal}`}>
                <div className="cg-preflight-header">
                  <span className="cg-preflight-icon">{preflight.signal === 'strong' ? '✓' : preflight.signal === 'caution' ? '⚠' : '✕'}</span>
                  <span className="cg-preflight-confidence">{preflight.confidence}</span>
                </div>
                <p className="cg-preflight-reason">{preflight.reason}</p>
                {preflight.reframe && (
                  <div className="cg-preflight-reframe">
                    <span className="cg-preflight-reframe-label">Brain suggests instead:</span>
                    <div className="cg-preflight-reframe-card" onClick={() => { setTopicPrompt(preflight.reframe || ''); setPreflight({ status: 'idle' }); }}>
                      <span className="cg-preflight-reframe-topic">{preflight.reframe}</span>
                      <span className="cg-preflight-use-hint">tap to use</span>
                    </div>
                    {preflight.reframeRationale && (
                      <p className="cg-preflight-reframe-rationale">{preflight.reframeRationale}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Conditional CTA:
                - Brief selected → "Generate Article" (proceed with that brief)
                - No brief + typed topic → "Build brief →" (user-typed-topic
                  entry into the pipeline; lands at Authenticity Enricher with
                  the new brief auto-firing enrichment)
                - Neither → disabled "Generate Article" with hint
              The build-brief path replaces the dead-end UX where a typed topic
              had no path forward unless the user backtracked to GEO Strategist. */}
          {selectedBriefId ? (
            <button className="geo-run-btn" onClick={runGeneration} disabled={!selectedBrainId}>
              <FileText size={14} /> Generate Article
            </button>
          ) : topicPrompt.trim() ? (
            <button className="geo-run-btn" onClick={buildBriefFromTopic} disabled={!selectedBrainId || buildingBrief}>
              <FileText size={14} /> {buildingBrief ? 'Building brief…' : 'Build brief →'}
            </button>
          ) : (
            <button className="geo-run-btn" disabled title="Select a brief or type a topic">
              <FileText size={14} /> Generate Article
            </button>
          )}
          </div>

          {/* Advanced direction — only when user has typed a topic. Lets them
              specify mandatories/constraints/audience/CTA/etc. that the LLM
              respects as harder than brand patterns. Mirrors the email campaign
              generator's 'Mandatories & Constraints' section. */}
          {topicPrompt.trim() && (
            <div className="cg-advanced" style={{ marginTop: 12, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-card, #fff)' }}>
              <button
                type="button"
                onClick={() => setAdvancedOpen(o => !o)}
                style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>Advanced direction — mandatories, audience, CTA{' '}<span style={{ fontWeight: 400, color: 'var(--color-text-muted, #94a3b8)', fontSize: 12 }}>(optional)</span></span>
                <span style={{ fontSize: 14, color: 'var(--color-text-muted, #94a3b8)' }}>{advancedOpen ? '−' : '+'}</span>
              </button>

              {advancedOpen && (
                <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>Mandatories</label>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', marginBottom: 6 }}>Legal disclaimers, required CTAs, must-include phrases, time-bound claims.</div>
                    <textarea
                      value={mandatories}
                      onChange={e => setMandatories(e.target.value)}
                      placeholder="e.g. Must include 30-day money-back guarantee. CTA must link to /pricing. Mention SOC 2 certification."
                      rows={2}
                      style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>Constraints</label>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted, #94a3b8)', marginBottom: 6 }}>What the article must NOT do. Things to avoid mentioning.</div>
                    <textarea
                      value={constraints}
                      onChange={e => setConstraints(e.target.value)}
                      placeholder="e.g. No claims about competitor pricing. Don't mention specific revenue figures. Avoid medical advice framing."
                      rows={2}
                      style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>Target audience</label>
                      <input
                        type="text"
                        value={audience}
                        onChange={e => setAudience(e.target.value)}
                        placeholder="e.g. RevOps leaders at Series B SaaS"
                        style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>CTA target URL/path</label>
                      <input
                        type="text"
                        value={ctaTarget}
                        onChange={e => setCtaTarget(e.target.value)}
                        placeholder="e.g. /pricing or /book-demo"
                        style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>Desired reader action</label>
                      <input
                        type="text"
                        value={desiredAction}
                        onChange={e => setDesiredAction(e.target.value)}
                        placeholder="e.g. Book a demo, Download the playbook, Subscribe"
                        style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #1a1a1a)', marginBottom: 4 }}>Length</label>
                      <select
                        value={wordCountTarget}
                        onChange={e => setWordCountTarget(e.target.value)}
                        style={{ width: '100%', padding: 10, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', background: 'var(--color-bg-card, #fff)' }}
                      >
                        <option value="">Default (Forge picks)</option>
                        <option value="600">Concise (~600 words)</option>
                        <option value="1500">Standard (~1500 words)</option>
                        <option value="2500">Long-form (~2500 words)</option>
                        <option value="4000">Deep dive (~4000 words)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isRunning && (
        <div className="geo-running">
          <div className="cg-stream-header">
            <Zap size={14} />
            <span>Generating — Brain is writing...</span>
          </div>
          <div className="cg-stream-body">
            <StreamProgress text={streamText} />
          </div>
        </div>
      )}

      {error && <div className="geo-error">{error}</div>}

      {article && !isRunning && (
        <>
          <div className="cg-meta-bar">
            <span className="cg-meta-item"><FileText size={12} /> {article.estimatedReadTime}</span>
            {article.brainMatchScore != null && (<span className="cg-meta-item" style={{ color: '#10B981' }}>Brain Match: {article.brainMatchScore}/100</span>)}
            <span className="cg-meta-item">{article.citationOpportunities?.length || 0} citations needed</span>
            <div className="cg-tabs">
              {(['article', 'meta', 'schema'] as const).map(tab => (
                <button key={tab} className={`cg-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'article' && (
            <div className="cg-article">
              <h2 className="cg-article-title">{article.title}</h2>
              {articleImageUrl ? (
                <div className="cg-article-hero">
                  <img src={articleImageUrl} alt={article.title} />
                </div>
              ) : imageLoading ? (
                <div className="cg-article-hero-loading">
                  <span className="cg-spinner-sm" /> Generating hero image…
                </div>
              ) : null}
              {article.sections?.map(section => (
                <div key={section.id} className="cg-section" style={{ borderLeftColor: tierColor(section.confidenceTier) }}>
                  <div className="cg-section-header">
                    {section.heading && <h3 className="cg-section-heading">{section.heading}</h3>}
                    <div className="cg-confidence-badge" style={{ background: tierColor(section.confidenceTier) + '22', color: tierColor(section.confidenceTier) }}>
                      {tierLabel(section.confidenceTier)} {section.confidence}% — {section.confidenceReason}
                    </div>
                  </div>
                  <p className="cg-section-body">{section.body}</p>
                  {section.eeatInjections?.length > 0 && (
                    <div className="cg-injections">
                      <span className="cg-injection-label">E-E-A-T:</span>
                      {section.eeatInjections.map((inj, i) => <span key={i} className="cg-injection-tag">{inj}</span>)}
                    </div>
                  )}
                  {section.smeHooks?.length > 0 && (
                    <div className="cg-sme-hooks">
                      {section.smeHooks.map((hook, i) => <div key={i} className="cg-sme-hook">💬 {hook}</div>)}
                    </div>
                  )}
                </div>
              ))}
              {article.authorBlock && (
                <div className="cg-author-block">
                  <ShieldCheck size={14} /> {article.authorBlock.suggestedByline}
                </div>
              )}
            </div>
          )}

          {activeTab === 'meta' && (
            <div className="cg-panel">
              <div className="cg-panel-row"><span>Meta Description</span><p>{article.metaDescription}</p></div>
              {article.citationOpportunities?.length > 0 && (
                <div className="cg-panel-row">
                  <span>Citation Opportunities</span>
                  <ul>{article.citationOpportunities.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
            </div>
          )}

          {activeTab === 'schema' && (
            <div className="cg-panel">
              <pre className="cg-schema-pre">{JSON.stringify(article.authorBlock?.schemaMarkup || {}, null, 2)}</pre>
            </div>
          )}

          <div className="cg-article-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="cg-article-btn" onClick={() => { setArticle(null); setStreamText(''); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 'var(--radius-sm)', background: '#fff', color: '#64748b', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              <span className="btn-icon-decorative"><FileText size={14} /></span> Generate Another
            </button>
            <button className="cg-article-btn cg-article-btn-primary" onClick={() => window.location.href = '/app/content-library'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius-sm)', background: '#4F46E5', color: '#fff', border: '1px solid #4F46E5', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              View in Content Library
            </button>
            <button className="cg-article-btn cg-article-btn-success" onClick={() => window.location.href = '/app/compliance-gate'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius-sm)', background: '#10b981', color: '#fff', border: '1px solid #10b981', cursor: 'pointer', textDecoration: 'none', lineHeight: 1, boxSizing: 'border-box', margin: 0, fontFamily: 'inherit' }}>
              <span className="btn-icon-decorative"><ShieldCheck size={14} /></span> Send to Compliance Gate
            </button>
          </div>
        </>
      )}

      {ideaDrawerOpen && (
        <div className="cg-idea-drawer">
          <div className="cg-idea-drawer-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <span className="cg-idea-drawer-title">Topic Ideas</span>
              <span className="cg-idea-drawer-sub">Park it now, generate when ready</span>
            </div>
            <button onClick={() => setIdeaDrawerOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
          <div className="cg-idea-capture">
            <input
              className="cg-idea-input"
              placeholder="What's the topic idea?"
              value={newIdea}
              onChange={e => setNewIdea(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveIdea(); }}
              autoFocus
            />
            <input
              className="cg-idea-note-input"
              placeholder="Optional note..."
              value={newIdeaNote}
              onChange={e => setNewIdeaNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveIdea(); }}
            />
            <button className="cg-idea-save-btn" onClick={saveIdea} disabled={savingIdea || !newIdea.trim() || !selectedBrainId}>
              {savingIdea ? 'Saving...' : 'Save Idea'}
            </button>
            {!selectedBrainId && <p className="cg-idea-warn">Select a Brain first.</p>}
          </div>
          {ideas.length > 0 && (
            <div className="cg-idea-list">
              {ideas.map(idea => (
                <div key={idea.id} className={`cg-idea-item${idea.status === 'in_progress' ? ' in-progress' : ''}`}>
                  <div className="cg-idea-item-top">
                    <span className="cg-idea-topic">{idea.topic}</span>
                    <div className="cg-idea-item-actions">
                      <button className="cg-idea-use-btn" onClick={() => useIdea(idea)}>→ Use</button>
                      <button className="cg-idea-del-btn" onClick={() => deleteIdea(idea.id)}>✕</button>
                    </div>
                  </div>
                  {idea.note && <p className="cg-idea-note-text">{idea.note}</p>}
                  {idea.status === 'in_progress' && <span className="cg-idea-in-progress">In progress</span>}
                </div>
              ))}
            </div>
          )}
          {ideas.length === 0 && selectedBrainId && (
            <p className="cg-idea-empty">No ideas yet — type one above ↑</p>
          )}
        </div>
      )}


      {briefs.length > 0 && (() => {
        const latestSession = briefs.find(b => b.discoverySessionId)?.discoverySessionId;
        // Batch = current cherry-pick session's briefs + any orphaned articles (legacy work).
        // Orphans have no sessionId because their enriched_brief row was deleted by the pre-refactor
        // "DELETE all on new enrichment" behavior. They're still part of the user's recent work.
        const batch = latestSession
          ? briefs.filter(b => b.discoverySessionId === latestSession || b.isOrphan)
          : briefs;
        if (batch.length === 0) return null;
        // Treat both 'published' (all channels shipped) AND 'partial' (at least one channel shipped)
        // as published. The user's mental model: "is this article in the wild being seen" — yes in
        // both cases. 'partial' happens when one channel shipped (e.g., LinkedIn) but another errored
        // or is still queued; it's a production state, not a generation state.
        const isPublishedState = (b: EnrichedBrief) => b.hasArticle && (b.queueStatus === 'published' || b.queueStatus === 'partial');
        const pending = batch.filter(b => !b.hasArticle).length;
        const generated = batch.filter(b => b.hasArticle).length;
        const published = batch.filter(isPublishedState).length;
        const generatedOnly = generated - published;
        const statusFor = (b: EnrichedBrief) => {
          if (isPublishedState(b)) return 'published';
          if (b.hasArticle) return 'generated';
          return 'pending';
        };
        const segments = [
          pending > 0 ? `${pending} pending` : null,
          generatedOnly > 0 ? `${generatedOnly} generated` : null,
          published > 0 ? `${published} published` : null,
        ].filter(Boolean).join(' · ');
        return (
          <div className="cg-batch-progress">
            <div className="cg-batch-progress-header">
              <span className="cg-batch-progress-label">Batch progress</span>
              <span className="cg-batch-progress-sub">{segments || `${batch.length} total`}</span>
            </div>
            <div className="cg-batch-progress-chips">
              {batch.map(b => {
                const st = statusFor(b);
                return (
                  <span
                    key={b.id}
                    className={`cg-batch-progress-chip status-${st}${st === 'generated' ? ' clickable' : ''}`}
                    onClick={() => { if (st === 'generated' && b.articleId) window.location.href = `/app/compliance-gate?articleId=${b.articleId}&brandProfileId=${selectedBrainId}`; }}
                    title={st === 'generated' ? 'Continue to Compliance Gate →' : undefined}
                    style={st === 'generated' ? { cursor: 'pointer' } : undefined}
                  >
                    {b.enrichedTitle || b.articleTitle || b.enrichedH1 || b.topic || b.brandName}
                    <span className="cg-batch-progress-chip-status">{st}{st === 'generated' ? ' →' : ''}</span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

export default function ContentGeneratorPage() {
  return <AppShell><ContentGeneratorContent /></AppShell>;
}
