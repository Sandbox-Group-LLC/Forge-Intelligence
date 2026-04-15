import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import './PublicArticlePage.css';
// ── Markdown helper ───────────────────────────────────────────────────────────
const ARTIFACT_RX = /\[(?:NEEDS CITATION|CITATION|SOURCE)[^\]]*\]/gi;
const BOLD_ITALIC_RX = /\*\*(.+?)\*\*|\*(.+?)\*/g;

function renderBody(raw: string): React.ReactNode {
  const cleaned = raw.replace(ARTIFACT_RX, '').trim();
  const paragraphs = cleaned.split(/\n\n+/);
  return (
    <>
      {paragraphs.map((para, pi) => {
        const parts: React.ReactNode[] = [];
        const rx = new RegExp(BOLD_ITALIC_RX.source, 'g');
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(para)) !== null) {
          if (m.index > last) parts.push(para.slice(last, m.index));
          if (m[1]) parts.push(<strong key={m.index}>{m[1]}</strong>);
          else if (m[2]) parts.push(<em key={m.index}>{m[2]}</em>);
          last = m.index + m[0].length;
        }
        if (last < para.length) parts.push(para.slice(last));
        return <p key={pi} style={{ marginBottom: '1rem' }}>{parts}</p>;
      })}
    </>
  );
}


interface ArticleSection { heading: string; content?: string; body?: string; }
interface ArticleData {
  title: string;
  sections: ArticleSection[];
  category?: string;
  overallConfidence?: number;
  heroImageUrl?: string;
  brandName?: string;
  brandUrl?: string;
  createdAt?: string;
  metaDescription?: string;
}

export default function PublicArticlePage() {
  const { brandSlug, articleSlug } = useParams<{ brandSlug: string; articleSlug: string }>();
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!brandSlug || !articleSlug) return;
    fetch(`/api/articles/${brandSlug}/${articleSlug}`)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(async (d) => {
        setArticle(d);
        setLoading(false);
        // If no hero image, generate one silently in background
        if (!d.heroImageUrl) {
          try {
            const imgRes = await fetch(`/api/articles/${brandSlug}/${articleSlug}/ensure-image`, { method: 'POST' });
            const imgData = await imgRes.json();
            if (imgData.imageUrl) {
              setArticle((prev: any) => prev ? { ...prev, heroImageUrl: imgData.imageUrl } : prev);
            }
          } catch(_) {}
        }
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [brandSlug, articleSlug]);

  if (loading) return (
    <div className="pa-loading">
      <div className="pa-spinner" />
    </div>
  );

  if (notFound || !article) return (
    <div className="pa-notfound">
      <div className="pa-notfound-inner">
        <div className="pa-notfound-icon">⚡</div>
        <h1>Article not found</h1>
        <p>This article may have been moved or unpublished.</p>
        <a href={`/articles/${brandSlug}`} className="pa-home-link">← Back to Articles</a>
      </div>
    </div>
  );

  const readTime = Math.max(1, Math.round(
    (article.sections || []).reduce((acc, s) => {
      const text = (s as any).body || s.content || '';
      return acc + text.split(' ').length;
    }, 0) / 200
  ));

  const publishDate = article.createdAt
    ? new Date(article.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const sections = article.sections || [];
  const firstSection = sections[0];
  const restSections = sections.slice(1);

  return (
    <div className="pa-page">

      {/* ── Top nav bar ─── */}
      <nav className="pa-nav">
        <a href="https://forgeintelligence.ai" className="pa-nav-brand">
          <span className="pa-nav-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>
            </svg>
          </span>
          <span className="pa-nav-name">Forge Intelligence</span>
        </a>
        {article.category && <span className="pa-nav-category">{article.category}</span>}
      </nav>

      {/* ── Hero ─── */}
      {article.heroImageUrl ? (
        <div className="pa-hero-wrap">
          <img src={article.heroImageUrl} alt={article.title} className="pa-hero-img" />
          <div className="pa-hero-overlay" />
          <div className="pa-hero-content">
            {article.category && <div className="pa-eyebrow">{article.category}</div>}
            <h1 className="pa-title pa-title-over-hero">{article.title}</h1>
            <div className="pa-meta">
              {article.brandName && <span className="pa-author">{article.brandName}</span>}
              <span className="pa-dot">·</span>
              <span className="pa-read-time">{readTime} min read</span>
              {publishDate && <><span className="pa-dot">·</span><span className="pa-date">{publishDate}</span></>}
            </div>
          </div>
        </div>
      ) : (
        <div className="pa-hero-text-only">
          {article.category && <div className="pa-eyebrow">{article.category}</div>}
          <h1 className="pa-title">{article.title}</h1>
          <div className="pa-meta">
            {article.brandName && <span className="pa-author">{article.brandName}</span>}
            <span className="pa-dot">·</span>
            <span className="pa-read-time">{readTime} min read</span>
            {publishDate && <><span className="pa-dot">·</span><span className="pa-date">{publishDate}</span></>}
          </div>
        </div>
      )}

      {/* ── Article body ─── */}
      <main className="pa-main">
        <article className="pa-article">

          {article.metaDescription && (
            <p className="pa-lede">{article.metaDescription}</p>
          )}

          {/* First section body as lead — larger text */}
          {firstSection && (
            <div className="pa-section pa-section-lead">
              {firstSection.heading && <h2 className="pa-section-heading">{firstSection.heading}</h2>}
              <div className="pa-section-body pa-lead-body">
                {renderBody((firstSection as any).body || firstSection.content || '')}
              </div>
            </div>
          )}

          {restSections.map((section, i) => (
            <section key={i} className="pa-section">
              {section.heading && <h2 className="pa-section-heading">{section.heading}</h2>}
              <div className="pa-section-body">
                {renderBody((section as any).body || section.content || '')}
              </div>
            </section>
          ))}

          {/* ── CTA ─── */}
          <div className="pa-cta">
            <div className="pa-cta-inner">
              <div className="pa-cta-logo">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>
                </svg>
              </div>
              <div className="pa-cta-text">
                <h3 className="pa-cta-headline">See what Forge Intelligence knows about your brand</h3>
                <p className="pa-cta-sub">Drop your URL and get a free brand intelligence profile in seconds — audience signals, competitive gaps, and strategic recommendations.</p>
              </div>
              <a href="https://forgeintelligence.ai/?utm_source=article&utm_medium=cta&utm_campaign=forge-content" className="pa-cta-btn">
                Scan your brand free →
              </a>
            </div>
          </div>

          <footer className="pa-footer">
            <div className="pa-footer-divider" />
            <div className="pa-footer-row">
              <div className="pa-footer-meta">
                {article.brandName && <span className="pa-footer-brand-name">{article.brandName}</span>}
                <span className="pa-footer-powered">
                  Published with <a href="https://forgeintelligence.ai" className="pa-forge-link">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle',marginRight:'4px'}}><path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/></svg>
                    Forge Intelligence
                  </a>
                </span>
              </div>
              <a href={`/articles/${brandSlug}`} className="pa-back-link">← More articles</a>
            </div>
          </footer>

        </article>
      </main>
    </div>
  );
}
