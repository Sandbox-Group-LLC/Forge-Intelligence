import { useState, useRef, useEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import './CampaignGeneratorPage.css';

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
  const [brains, setBrains] = useState<Brain[]>([]);
  const [selectedBrainId, setSelectedBrainId] = useState('');
  const [step, setStep] = useState<'setup' | 'plan' | 'generating' | 'complete'>('setup');
  const [isPlanning, setIsPlanning] = useState(false);
  const [plan, setPlan] = useState<{ campaign_name: string; topic_cluster: string; articles: AngleProfile[] } | null>(null);
  const [articleStatuses, setArticleStatuses] = useState<ArticleStatus[]>([]);
  const [activeArticle, setActiveArticle] = useState<any | null>(null);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [error, setError] = useState('');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/context-hub/brains').then(r => r.json()).then(d => { if (d.success) setBrains(d.data); });
  }, []);

  const selectedBrain = brains.find(b => b.id === selectedBrainId);

  const handlePlan = async () => {
    if (!selectedBrainId) return;
    setIsPlanning(true); setError('');
    try {
      const res = await fetch('/api/campaign/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId }),
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrainId, plan }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const savedCampaignId = data.campaignId;

      setArticleStatuses(plan.articles.map(a => ({
        index: a.index, title: a.title, week: a.week, status: 'pending' as const,
      })));
      setStep('generating');

      const es = new EventSource(`/api/campaign/generate/${savedCampaignId}`);
      esRef.current = es;

      es.addEventListener('article_start', (e) => {
        const d = JSON.parse(e.data);
        setStreamBuffer('');
        setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'generating' } : a));
      });
      es.addEventListener('chunk', (e) => { setStreamBuffer(prev => prev + e.data); });
      es.addEventListener('article_done', (e) => {
        const d = JSON.parse(e.data);
        setStreamBuffer('');
        setArticleStatuses(prev => prev.map(a =>
          a.index === d.index ? { ...a, status: 'complete', article: d.article } : a
        ));
      });
      es.addEventListener('article_error', (e) => {
        const d = JSON.parse(e.data);
        setArticleStatuses(prev => prev.map(a =>
          a.index === d.index ? { ...a, status: 'failed', error: d.error } : a
        ));
      });
      es.addEventListener('campaign_done', () => { es.close(); setStep('complete'); });
      es.addEventListener('error', (e: any) => { es.close(); setError(e.data?.message || 'Generation failed'); });
    } catch (e: any) { setError(e.message); }
  };

  const completedCount = articleStatuses.filter(a => a.status === 'complete').length;

  return (
    <div className="cg-page">
      <div className="cg-header">
        <div className="cg-stage-label">STAGE 4.5</div>
        <h1 className="cg-title">Campaign Generator</h1>
        <p className="cg-subtitle">8-article campaign — 2 per week for 4 weeks. One brain, zero slop.</p>
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
          <button className="camp-plan-btn" onClick={handlePlan} disabled={isPlanning || !selectedBrainId}>
            {isPlanning ? <><span className="camp-spinner" />Planning angles...</> : <><Zap size={16} />Plan Campaign</>}
          </button>
          {error && <div className="geo-error">{error}</div>}
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
                  <div className="camp-article-view-hint"><BookOpen size={11} /> Click to read</div>
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
        </div>
      )}
    </div>
  );
}

export default function CampaignGeneratorPage() {
  return <AppShell pageTitle="Campaign Generator"><CampaignGeneratorContent /></AppShell>;
}
