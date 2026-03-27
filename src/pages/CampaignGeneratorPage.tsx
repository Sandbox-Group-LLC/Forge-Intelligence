import { useState, useRef, useEffect } from 'react';
import { Zap, ChevronRight, CheckCircle, Clock, AlertCircle, RotateCcw, BookOpen } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import './CampaignGeneratorPage.css';

const FUNNEL_COLORS: Record<string, string> = {
  TOFU: '#3B82F6',
  MOFU: '#8B5CF6',
  BOFU: '#10B981',
};

const TYPE_COLORS: Record<string, string> = {
  Explainer: '#64748B',
  Contrarian: '#EF4444',
  'Case Study': '#F59E0B',
  Comparison: '#3B82F6',
  'How-To': '#10B981',
  Data: '#8B5CF6',
  FAQ: '#EC4899',
  Listicle: '#14B8A6',
};

interface AngleProfile {
  index: number;
  week: number;
  publish_day: string;
  title: string;
  primary_persona: string;
  content_type: string;
  funnel_position: string;
  geo_section: string;
  eeat_gap: string;
  angle_summary: string;
  primary_keyword: string;
  opening_hook: string;
  estimated_confidence: number;
}

interface ArticleStatus {
  index: number;
  title: string;
  week: number;
  status: 'pending' | 'generating' | 'complete' | 'failed';
  article?: any;
  error?: string;
}

export default function CampaignGeneratorPage() {
  const { selectedBrand } = useAppContext();
  const [step, setStep] = useState<'setup' | 'plan' | 'generating' | 'complete'>('setup');
  const [isPlanning, setIsPlanning] = useState(false);
  const [plan, setPlan] = useState<{ campaign_name: string; topic_cluster: string; articles: AngleProfile[] } | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [articleStatuses, setArticleStatuses] = useState<ArticleStatus[]>([]);
  const [activeArticle, setActiveArticle] = useState<any | null>(null);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [error, setError] = useState('');
  const esRef = useRef<EventSource | null>(null);

  const handlePlan = async () => {
    if (!selectedBrand) return;
    setIsPlanning(true);
    setError('');
    try {
      const res = await fetch('/api/campaign/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrand.id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setPlan(data.plan);
      setStep('plan');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsPlanning(false);
    }
  };

  const handleGenerate = async () => {
    if (!plan || !selectedBrand) return;
    setError('');
    try {
      const res = await fetch('/api/campaign/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selectedBrand.id, plan }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCampaignId(data.campaignId);

      const statuses: ArticleStatus[] = plan.articles.map(a => ({
        index: a.index,
        title: a.title,
        week: a.week,
        status: 'pending',
      }));
      setArticleStatuses(statuses);
      setStep('generating');

      const es = new EventSource(`/api/campaign/generate/${data.campaignId}`);
      esRef.current = es;

      es.addEventListener('article_start', (e) => {
        const d = JSON.parse(e.data);
        setStreamBuffer('');
        setArticleStatuses(prev => prev.map(a => a.index === d.index ? { ...a, status: 'generating' } : a));
      });

      es.addEventListener('chunk', (e) => {
        setStreamBuffer(prev => prev + e.data);
      });

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

      es.addEventListener('campaign_done', () => {
        es.close();
        setStep('complete');
      });

      es.addEventListener('error', (e: any) => {
        es.close();
        setError(e.data?.message || 'Generation failed');
      });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const completedCount = articleStatuses.filter(a => a.status === 'complete').length;
  const generatingIdx = articleStatuses.find(a => a.status === 'generating')?.index;

  return (
    <div className="cg-page">
      <div className="cg-header">
        <div className="cg-stage-label">STAGE 4.5</div>
        <h1 className="cg-title">Campaign Generator</h1>
        <p className="cg-subtitle">
          8-article campaign — 2 per week for 4 weeks. One brain, zero slop.
        </p>
      </div>

      {/* SETUP STEP */}
      {step === 'setup' && (
        <div className="camp-setup">
          <div className="camp-brand-display">
            <div className="camp-brand-name">{selectedBrand?.name || 'No brand selected'}</div>
            <div className="camp-brand-sub">Brain connected · Angle diversity enforced</div>
          </div>
          <div className="camp-stats">
            <div className="camp-stat"><span className="camp-stat-num">8</span><span className="camp-stat-label">Articles</span></div>
            <div className="camp-stat"><span className="camp-stat-num">4</span><span className="camp-stat-label">Weeks</span></div>
            <div className="camp-stat"><span className="camp-stat-num">~$1.14</span><span className="camp-stat-label">Total cost</span></div>
            <div className="camp-stat"><span className="camp-stat-num">~18min</span><span className="camp-stat-label">Est. time</span></div>
          </div>
          <button className="camp-plan-btn" onClick={handlePlan} disabled={isPlanning || !selectedBrand}>
            {isPlanning ? (
              <><span className="camp-spinner" />Planning angles...</>
            ) : (
              <><Zap size={16} />Plan Campaign</>
            )}
          </button>
          {error && <div className="geo-error">{error}</div>}
        </div>
      )}

      {/* PLAN REVIEW STEP */}
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

          {[1, 2, 3, 4].map(week => (
            <div key={week} className="camp-week">
              <div className="camp-week-label">Week {week}</div>
              <div className="camp-week-articles">
                {plan.articles.filter(a => a.week === week).map(article => (
                  <div key={article.index} className="camp-angle-card">
                    <div className="camp-angle-top">
                      <div className="camp-angle-badges">
                        <span className="camp-badge" style={{ background: FUNNEL_COLORS[article.funnel_position] + '22', color: FUNNEL_COLORS[article.funnel_position] }}>
                          {article.funnel_position}
                        </span>
                        <span className="camp-badge" style={{ background: TYPE_COLORS[article.content_type] + '22', color: TYPE_COLORS[article.content_type] }}>
                          {article.content_type}
                        </span>
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

      {/* GENERATING STEP */}
      {(step === 'generating' || step === 'complete') && (
        <div className="camp-generating">
          <div className="camp-progress-bar-wrap">
            <div className="camp-progress-label">
              {step === 'complete' ? '8 / 8 articles complete' : `${completedCount} / 8 articles complete`}
            </div>
            <div className="camp-progress-track">
              <div className="camp-progress-fill" style={{ width: `${(completedCount / 8) * 100}%` }} />
            </div>
          </div>

          <div className="camp-articles-grid">
            {articleStatuses.map(a => (
              <div
                key={a.index}
                className={`camp-article-card ${a.status} ${activeArticle?.index === a.index ? 'active' : ''}`}
                onClick={() => a.article && setActiveArticle(a.status === 'complete' ? a.article : null)}
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
                  <div className="camp-article-stream">
                    <StreamProgress text={streamBuffer} />
                  </div>
                )}
                {a.status === 'complete' && (
                  <div className="camp-article-view-hint">
                    <BookOpen size={11} /> Click to read
                  </div>
                )}
                {a.status === 'failed' && <div className="camp-article-error">{a.error}</div>}
              </div>
            ))}
          </div>

          {/* Article reader */}
          {activeArticle && (
            <div className="camp-article-reader">
              <div className="camp-reader-header">
                <div>
                  <div className="camp-reader-confidence">
                    {activeArticle.overallConfidence && (
                      <span className="cg-confidence-badge" style={{ fontSize: '13px' }}>
                        {activeArticle.overallConfidence}
                      </span>
                    )}
                  </div>
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

function StreamProgress({ text }: { text: string }) {
  const headings = Array.from(text.matchAll(/"heading":\s*"([^"]{8,80})"/g))
    .map(m => m[1])
    .filter((h, i, arr) => arr.indexOf(h) === i);

  if (!headings.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
        <span style={{ animation: 'blink 1s step-end infinite', color: '#3563FF' }}>▋</span>
        <span style={{ color: '#475569', fontSize: '11px' }}>Analyzing Brain...</span>
      </div>
    );
  }
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
