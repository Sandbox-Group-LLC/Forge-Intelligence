import { useState, useRef, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './CampaignGeneratorPage.css';
import { useApp } from '../context/AppContext';
import GateModal from '../components/GateModal';
import '../components/GateModal.css';

// ── Inline icon components (lucide-react not available) ─────────────────────
const Zap = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
const CheckCircle = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);
const Clock = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);
const AlertCircle = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);
const BookOpen = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

// ── Types ────────────────────────────────────────────────────────────────────
interface Brain { id: string; brandName: string; brandUrl: string; }

const FUNNEL_COLORS: Record<string, string> = {
  TOFU: '#3B82F6', MOFU: '#8B5CF6', BOFU: '#10B981',
};
const TYPE_COLORS: Record<string, string> = {
  Explainer: '#64748B', Contrarian: '#EF4444', 'Case Study': '#F59E0B',
  Comparison: '#3B82F6', 'How-To': '#10B981', Data: '#8B5CF6',
  FAQ: '#EC4899', Listicle: '#14B8A6',
};

interface AngleProfile {
  index: number; week: number; publish_day: string; title: string;
  primary_persona: string; content_type: string; funnel_position: string;
  geo_section: string; eeat_gap: string; angle_summary: string;
  primary_keyword: string; opening_hook: string; estimated_confidence: number;
}
interface ArticleStatus {
  index: number; title: string; week: number;
  status: 'pending' | 'generating' | 'complete' | 'failed';
  article?: any; error?: string;
  imageUrl?: string; imageLoading?: boolean;
}

// ── Stream progress component ─────────────────────────────────────────────────
function StreamProgress({ text }: { text: string }) {
  const headings = Array.from(text.matchAll(/"heading":\s*"([^"]{8,80})"/g))
    .map(m => m[1]).filter((h, i, arr) => arr.indexOf(h) === i);
  if (!headings.length) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
      <span style={{ animation: 'blink 1s step-end infinite', color: '#3563FF' }}>▋</span>
      <span style={{ color: '#475569', fontSize: '11px' }}>Analyzing Brain...</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {headings.map((h, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: '#14B8A6', fontSize: '10px' }}>✓</span>
          <span style={{ fontSize: '11px', color: '#94A3B8' }}>{h}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ animation: 'blink 1s step-end infinite', color: '#3563FF', fontSize: '12px' }}>▋</span>
        <span style={{ fontSize: '11px', color: '#475569' }}>Writing...</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
function CampaignGeneratorContent() {
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [step, setStep] = useState<'setup' | 'plan' | 'generating' | 'complete'>('setup');
  const [isPlanning, setIsPlanning] = useState(false);
  const [topicPrompt, setTopicPrompt] = useState('');
  const [preflight, setPreflight] = useState<{ status: string; signal?: string; confidence?: string; reframe?: string; reason?: string }>({ status: 'idle' });
  const [plan, setPlan] = useState<{ campaign_name: string; topic_cluster: string; articles: AngleProfile[] } | null>(null);
  const [articleStatuses, setArticleStatuses] = useState<ArticleStatus[]>([]);
  const [activeArticle, setActiveArticle] = useState<any | null>(null);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [error, setError] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const { historyEntries, activeBrand } = useApp();

  const brains: Brain[] = historyEntries.map(e => ({ id: e.id, brandName: e.brandName, brandUrl: e.brandUrl }));

  // Seed selected brain from active brand context
  useEffect(() => {
    const id = activeBrand?.id || localStorage.getItem('forge_active_brand_id') || '';
    if (id) setSelectedBrainId(id);

    // Restore campaign state from localStorage if < 2 hours old
    try {
      const saved = localStorage.getItem('forge_campaign_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        const age = Date.now() - (parsed.savedAt || 0);
        if (age < 2 * 60 * 60 * 1000 && parsed.plan && parsed.articleStatuses) {
          setPlan(parsed.plan);
          setArticleStatuses(parsed.articleStatuses);
          setStep('complete');
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (activeBrand?.id && !selectedBrainId) setSelectedBrainId(activeBrand.id);
  }, [activeBrand?.id]);

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [pastCampaigns, setPastCampaigns] = useState<{id:string;name:string;topic_cluster:string;status:string;completed_count:number;created_at:string}[]>([]);

  const { authToken } = useApp();

  useEffect(() => {
    const id = activeBrand?.id;
    if (!id || !authToken) return;
    fetch(`/api/campaign/list/${id}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.campaigns) setPastCampaigns(d.campaigns); })
      .catch(() => {});
  }, [activeBrand?.id, authToken]);

  const loadCampaign = async (campaignId: string) => {
    try {
      const r = await fetch(`/api/campaign/${campaignId}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
      const d = await r.json();
      if (!d.campaign || !d.articles) return;
      setActiveCampaignId(campaignId);
      setPlan({ campaign_name: d.campaign.name, topic_cluster: d.campaign.topic_cluster, articles: d.campaign.plan?.articles || [] });
      const statuses = d.articles.map((a: any) => ({
        index: a.article_index,
        status: (a.status === 'complete' ? 'complete' : 'pending') as 'complete' | 'pending',
        title: a.generated_content?.title || a.angle_profile?.title || a.angle_profile?.angle || `Article ${a.article_index + 1}`,
        week: a.week_number || Math.floor(a.article_index / 2) + 1,
        article: a.generated_content || null,
        imageUrl: a.image_url || null,
        imageLoading: false,  // already complete or failed — not loading
      }));
      setArticleStatuses(statuses);
      setStep('complete');
    } catch { setError('Failed to load campaign.'); }
  };

  const resumeGeneration = (campaignId: string) => {
    const es = new EventSource(`/api/campaign/generate/${campaignId}?token=${authToken}`);
    esRef.current = es;
    setStep('generating');

    es.addEventListener('busy', () => {
      setError('Campaign generation already in progress. Your articles are being written — check back shortly.');
      setStep('setup');
      es.close();
    });
    es.addEventListener('article_start', (e) => {
      const d = JSON.parse(e.data);
      setStreamBuffer('');
      setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'generating' as const } : a));
    });
    es.addEventListener('chunk', (e) => { setStreamBuffer(prev => prev + e.data); });
    es.addEventListener('article_done', (e) => {
      const d = JSON.parse(e.data);
      setStreamBuffer('');
      setArticleStatuses(prev => prev.map(a =>
        a.index === d.index ? { ...a, status: 'complete' as const, article: d.article, imageLoading: true } : a
      ));
    });
    es.addEventListener('image_done', (e) => {
      const d = JSON.parse(e.data);
      setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, imageUrl: d.image_url, imageLoading: false } : a));
    });
    es.addEventListener('all_done', () => { es.close(); setStep('complete'); });
    es.addEventListener('error', (e: any) => { es.close(); setStep('complete'); setError(e.data || 'Generation failed.'); });
  };

  const selectedBrain = brains.find(b => b.id === selectedBrainId);

  const checkTopic = async () => {
    if (!selectedBrainId || !topicPrompt.trim()) { setPreflight({ status: 'idle' }); return; }
    setPreflight({ status: 'checking' });
    try {
      const r = await fetch('/api/content/topic-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topic: topicPrompt })
      });
      const d = await r.json();
      if (d.success) setPreflight({ status: 'done', ...d });
      else setPreflight({ status: 'idle' });
    } catch { setPreflight({ status: 'idle' }); }
  };

  const handlePlan = async () => {
    if (!selectedBrainId) return;
    setIsPlanning(true); setError('');
    localStorage.removeItem('forge_campaign_state');
    try {
      const res = await fetch('/api/campaign/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ brandProfileId: selectedBrainId, topicPrompt: topicPrompt.trim() || undefined }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setPlan(data.plan); setStep('plan');
    } catch (e: any) { setError(e.message); }
    finally { setIsPlanning(false); }
  };

  const handleGenerate = async () => {
    if (!plan || !selectedBrainId) return;
    setError('');
    try {
      const res = await fetch('/api/campaign/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ brandProfileId: selectedBrainId, plan }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const savedCampaignId = data.campaignId;

      setArticleStatuses(plan.articles.map(a => ({
        index: a.index, title: a.title, week: a.week, status: 'pending' as const,
      })));
      setStep('generating');

      const es = new EventSource(`/api/campaign/generate/${savedCampaignId}?token=${authToken}`);
      esRef.current = es;

      es.addEventListener('busy', () => {
        setError('Campaign generation already in progress. Your articles are being written — check back shortly.');
        setStep('setup');
        es.close();
      });
      es.addEventListener('article_start', (e) => {
        const d = JSON.parse(e.data);
        setStreamBuffer('');
        setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'generating' } : a));
      });
      es.addEventListener('chunk', (e) => { setStreamBuffer(prev => prev + e.data); });
      es.addEventListener('article_done', (e) => {
        const d = JSON.parse(e.data);
        setStreamBuffer('');
        setArticleStatuses(prev => {
          const updated = prev.map(a =>
            a.index === d.index ? { ...a, status: 'complete' as const, article: d.article, imageLoading: true } : a
          );
          // Articles persisted to DB via campaign/generate route
          return updated;
        });
      });
      es.addEventListener('image_done', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a =>
          a.index === d.index ? { ...a, imageUrl: d.image_url, imageLoading: false } : a
        ));
      });
      es.addEventListener('image_error', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a =>
          a.index === d.index ? { ...a, imageLoading: false } : a
        ));
      });
      es.addEventListener('article_error', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a =>
          a.index === d.index ? { ...a, status: 'failed', error: d.error } : a
        ));
      });
      es.addEventListener('campaign_done', () => {
        setStep('complete');
        // Keep SSE open 90s for async image_done events, then close
        setTimeout(() => es.close(), 90000);
      });
      es.addEventListener('error', (e: any) => { es.close(); setError(e.data?.message || 'Generation failed'); });
    } catch (e: any) { setError(e.message); }
  };

  const completedCount = articleStatuses.filter(a => a.status === 'complete').length;

  const restartCampaign = async (campaignId: string) => {
    setIsRestarting(true);
    try {
      const res = await fetch(`/api/campaign/reset/${campaignId}`, {
        method: 'POST', headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error);
      // Re-trigger generation
      setStep('generating');
      const es = new EventSource(`/api/campaign/generate/${campaignId}?token=${authToken}`);
      esRef.current = es;
      es.addEventListener('busy', () => {
        setError('Campaign generation already in progress. Your articles are being written — check back shortly.');
        setStep('setup');
        es.close();
      });
      es.addEventListener('article_start', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'generating' } : a));
      });
      es.addEventListener('article_complete', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'complete' } : a));
      });
      es.addEventListener('complete', () => {
        setStep('complete');
        es.close();
        loadCampaign(campaignId);
      });
      es.addEventListener('error', () => {
        setStep('setup');
        es.close();
      });
    } catch (err: any) {
      console.error('[RESTART]', err.message);
    } finally {
      setIsRestarting(false);
    }
  };


  return (
    <div className="cg-page">
      <div className="geo-header">
        <div>
          <div className="geo-eyebrow">Stage 4.5</div>
          <h1 className="geo-title">Campaign Generator</h1>
          <p className="geo-description">8-article campaign — 2 per week for 4 weeks. One brain, zero slop.</p>
        </div>
      </div>

      {step === 'setup' && (
        <div className="camp-setup">
          <div className="camp-brand-display">
            <select
              className="geo-select"
              value={selectedBrainId}
              onChange={e => setSelectedBrainId(e.target.value)}
              style={{ width: '100%', marginBottom: '4px' }}
            >
              <option value="">Select a Brain...</option>
              {brains.map(b => <option key={b.id} value={b.id}>{b.brandName} — {b.brandUrl}</option>)}
            </select>
            <div className="camp-brand-sub">
              {selectedBrain ? `${selectedBrain.brandName} · Angle diversity enforced` : 'Choose an existing brain to begin'}
            </div>
          </div>
          <div className="camp-stats">
            {[['8','Articles'],['4','Weeks'],['~$1.14','Total cost'],['~18min','Est. time']].map(([n,l]) => (
              <div key={l} className="camp-stat">
                <span className="camp-stat-num">{n}</span>
                <span className="camp-stat-label">{l}</span>
              </div>
            ))}
          </div>
          <div style={{ width: '100%' }}>
            <input
              className="geo-input"
              placeholder="Optional: direct the campaign topic — e.g. 'Competitive intelligence for sales teams'"
              value={topicPrompt}
              onChange={e => { setTopicPrompt(e.target.value); setPreflight({ status: 'idle' }); }}
              onBlur={checkTopic}
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: '8px' }}
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
                    <span className="cg-preflight-reframe-text" onClick={() => { setTopicPrompt(preflight.reframe || ''); setPreflight({ status: 'idle' }); }}>
                      {preflight.reframe} <span className="cg-preflight-use-hint">tap to use</span>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          <button className="camp-plan-btn" onClick={handlePlan} disabled={isPlanning || !selectedBrainId}>
            {isPlanning ? <><span className="camp-spinner" />Planning angles...</> : <><Zap size={16} />Plan Campaign</>}
          </button>
          {error && <div className="geo-error">{error}</div>}
        </div>
      )}

      {step === 'setup' && pastCampaigns.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 12 }}>Recent Campaigns</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pastCampaigns.slice(0, 5).map((camp: {id:string;name:string;topic_cluster:string;status:string;completed_count:number;created_at:string}) => (
              <button key={camp.id} onClick={() => loadCampaign(camp.id)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--color-bg-card)', border: 'none', borderRadius: 10, boxShadow: 'var(--shadow-card)', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}>{camp.name || camp.topic_cluster}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{camp.completed_count} of 8 articles · {new Date(camp.created_at).toLocaleDateString()}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {camp.status === 'generating' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); restartCampaign(camp.id); }}
                      disabled={isRestarting}
                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, background: 'var(--color-warning-muted)', color: 'var(--color-warning)', border: 'none', cursor: 'pointer' }}
                    >
                      {isRestarting ? '...' : 'Restart'}
                    </button>
                  )}
                  <div style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, background: camp.status === 'complete' ? 'var(--color-success-muted)' : camp.status === 'generating' ? 'rgba(245,185,66,0.12)' : 'var(--color-accent-muted)', color: camp.status === 'complete' ? 'var(--color-success)' : camp.status === 'generating' ? 'var(--color-warning)' : 'var(--color-accent)' }}>
                    {camp.status === 'complete' ? 'Complete' : camp.status === 'generating' ? 'Stalled' : 'In Progress'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'plan' && plan && (
        <div className="camp-plan">
          <div className="camp-plan-header">
            <div>
              <div className="camp-plan-name">{plan.campaign_name}</div>
              <div className="camp-plan-cluster">{plan.topic_cluster}</div>
            </div>
            <button className="camp-generate-btn" onClick={handleGenerate}>
              <Zap size={14} />Generate All 8 Articles
            </button>
          </div>
          {[1,2,3,4].map(week => (
            <div key={week} className="camp-week">
              <div className="camp-week-label">Week {week}</div>
              <div className="camp-week-articles">
                {plan.articles.filter(a => a.week === week).map(article => (
                  <div key={article.index} className="camp-angle-card">
                    <div className="camp-angle-top">
                      <div className="camp-angle-badges">
                        <span className="camp-badge" style={{ background: FUNNEL_COLORS[article.funnel_position] + '22', color: FUNNEL_COLORS[article.funnel_position] }}>{article.funnel_position}</span>
                        <span className="camp-badge" style={{ background: (TYPE_COLORS[article.content_type] || '#64748B') + '22', color: TYPE_COLORS[article.content_type] || '#64748B' }}>{article.content_type}</span>
                      </div>
                      <span className="camp-publish-day">{article.publish_day}</span>
                    </div>
                    <div className="camp-angle-title">{article.title}</div>
                    <div className="camp-angle-persona">→ {article.primary_persona}</div>
                    <div className="camp-angle-summary">{article.angle_summary}</div>
                    <div className="camp-angle-meta">
                      <span className="camp-angle-meta-item">GEO: {article.geo_section}</span>
                      <span className="camp-angle-meta-item">E-E-A-T: {article.eeat_gap}</span>
                    </div>
                    <div className="camp-angle-hook">"{article.opening_hook}"</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(step === 'generating' || step === 'complete') && (
        <div className="camp-generating">
          <div className="camp-progress-bar-wrap">
            <div className="camp-progress-label">{completedCount} / 8 articles complete</div>
            <div className="camp-progress-track">
              <div className="camp-progress-fill" style={{ width: `${(completedCount / 8) * 100}%` }} />
            </div>
          </div>
          <div className="camp-articles-grid">
            {articleStatuses.map(a => (
              <div
                key={a.index}
                className={`camp-article-card ${a.status} ${activeArticle?.index === a.index ? 'active' : ''}`}
                onClick={() => a.status === 'complete' && a.article && setActiveArticle(a.article)}
              >
                <div className="camp-article-card-top">
                  <span className="camp-article-num">#{a.index}</span>
                  <span className="camp-article-week">Wk {a.week}</span>
                  {a.status === 'complete' && <CheckCircle size={14} color="#10B981" />}
                  {a.status === 'generating' && <span className="camp-spinner-sm" />}
                  {a.status === 'pending' && <Clock size={14} color="#475569" />}
                  {a.status === 'failed' && <AlertCircle size={14} color="#EF4444" />}
                </div>
                <div className="camp-article-card-title">{a.title}</div>
                {a.status === 'generating' && (
                  <div className="camp-article-stream"><StreamProgress text={streamBuffer} /></div>
                )}
                {a.status === 'complete' && (
                  <>
                    {a.imageUrl ? (
                      <div className="camp-article-thumb">
                        <img src={a.imageUrl} alt={a.title} />
                      </div>
                    ) : a.imageLoading ? (
                      <div className="camp-article-img-loading"><span className="camp-spinner-sm" /> Generating image…</div>
                    ) : null}
                    <div className="camp-article-view-hint"><BookOpen size={11} /> Click to read</div>
                  </>
                )}
                {a.status === 'failed' && <div className="camp-article-error">{a.error}</div>}
              </div>
            ))}
          </div>

          {activeArticle && (
            <div className="camp-article-reader">
              <div className="camp-reader-header">
                <div>
                  {activeArticle.overallConfidence && (
                    <span className="cg-confidence-badge" style={{ fontSize: '13px' }}>{activeArticle.overallConfidence}</span>
                  )}
                  <h2 className="camp-reader-title">{activeArticle.title}</h2>
                  <div className="camp-reader-meta">{activeArticle.estimatedReadTime}</div>
                </div>
                <button className="camp-reader-close" onClick={() => setActiveArticle(null)}>✕</button>
              </div>
              {articleStatuses.find(a => a.article === activeArticle)?.imageUrl && (
                <div className="camp-reader-hero">
                  <img src={articleStatuses.find(a => a.article === activeArticle)!.imageUrl} alt={activeArticle.title} />
                </div>
              )}
              {activeArticle.sections?.map((section: any, i: number) => (
                <div key={i} className="cg-section-card">
                  <div className="cg-confidence-strip" style={{ background: section.confidence >= 80 ? '#10B981' : section.confidence >= 65 ? '#F59E0B' : '#EF4444' }} />
                  <div className="cg-section-content">
                    <div className="cg-section-header">
                      <h3 className="cg-section-heading">{section.heading}</h3>
                      <span className="cg-confidence-label">{section.confidence}%</span>
                    </div>
                    <div className="cg-section-body">{section.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        {/* Compliance CTA — shown when all 8 articles complete */}
        {completedCount < 8 && activeCampaignId && step === 'complete' && (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--color-border)' }}>
            <button
              onClick={() => resumeGeneration(activeCampaignId)}
              style={{ padding: '10px 24px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              {completedCount === 0 ? 'Start Generation' : `Resume Generation (${8 - completedCount} remaining)`}
            </button>
          </div>
        )}

        {completedCount === 8 && (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--color-border)' }}>
            <button
              onClick={() => {
                localStorage.removeItem('forge_campaign_state');
                setPlan(null); setArticleStatuses([]); setStep('setup');
              }}
              style={{ padding: '10px 24px', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text-secondary)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              New Campaign
            </button>
            <button
              onClick={() => window.location.href = '/app/compliance-gate'}
              style={{ padding: '10px 24px', background: '#10b981', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              Send All to Compliance Gate
            </button>
          </div>
        )}
        </div>
      )}
    </div>
  );
}

export default function CampaignGeneratorPage() {
  const { isPaid , brandLoading } = useApp();
  if (brandLoading) return null;
  if (!isPaid) {
    return (
      <AppShell pageTitle="Campaign Generator">
        <div className="geo-gate-wrapper">
          <GateModal
            featureName="Campaign Generator"
            onClose={() => window.location.href = '/app/context-hub'}
            onUnlocked={() => {}}
          />
        </div>
      </AppShell>
    );
  }

  return <AppShell pageTitle="Campaign Generator"><CampaignGeneratorContent /></AppShell>;
}
