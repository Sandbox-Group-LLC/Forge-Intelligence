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
      .then(d => { setArticle(d); setLoading(false); })
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
        <div className="pa-notfound-icon">📄</div>
        <h1>Article not found</h1>
        <p>This article may have been moved or unpublished.</p>
        <a href="https://forgeintelligence.ai" className="pa-home-link">← Back to Forge Intelligence</a>
      </div>
    </div>
  );

  const readTime = Math.max(1, Math.round((article.sections || []).reduce((acc, s) => acc + (s.content?.split(' ').length || 0), 0) / 200));

  return (
    <div className="pa-page">
      <header className="pa-header">
        <a href="https://forgeintelligence.ai" className="pa-brand-link">
          <span className="pa-brand-logo">⚡</span>
          <span className="pa-brand-name">Forge Intelligence</span>
        </a>
      </header>

      <main className="pa-main">
        <article className="pa-article">
          {article.category && <div className="pa-eyebrow">{article.category}</div>}
          <h1 className="pa-title">{article.title}</h1>

          <div className="pa-meta">
            {article.brandName && <span className="pa-author">{article.brandName}</span>}
            <span className="pa-dot">·</span>
            <span className="pa-read-time">{readTime} min read</span>
            {article.createdAt && (
              <>
                <span className="pa-dot">·</span>
                <span className="pa-date">{new Date(article.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </>
            )}
          </div>

          {article.heroImageUrl && (
            <div className="pa-hero">
              <img src={article.heroImageUrl} alt={article.title} />
            </div>
          )}

          <div className="pa-body">
            {(article.sections || []).map((section, i) => (
              <section key={i} className="pa-section">
                {section.heading && <h2 className="pa-section-heading">{section.heading}</h2>}
                <div className="pa-section-body">
                  {renderBody((section as any).body || (section as any).content || '')}
                </div>
              </section>
            ))}
          </div>

          <footer className="pa-footer">
            <div className="pa-footer-brand">
              <span>Created with</span>
              <a href="https://forgeintelligence.ai" className="pa-forge-link">⚡ Forge Intelligence</a>
            </div>
          </footer>
        </article>
      </main>
    </div>
  );
}
