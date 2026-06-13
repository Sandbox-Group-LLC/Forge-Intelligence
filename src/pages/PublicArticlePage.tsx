import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import './PublicArticlePage.css';
// ── Markdown helper ───────────────────────────────────────────────────────────
const ARTIFACT_RX = /\[(?:NEEDS CITATION|CITATION|SOURCE)[^\]]*\]/gi;

// Combined inline matcher: handles **bold**, *italic*, [text](url), [^N] footnote
// markers, and <https://url> autolinks in a single sweep so they nest cleanly.
// Order matters: more-specific patterns first so [^1] doesn't get parsed as a
// link with empty href, etc.
const INLINE_RX = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[\^(\d+)\])|(\[([^\]]+)\]\(([^)]+)\))|(<(https?:\/\/[^>]+)>)/g;

// Footnote definitions: "[^N]: title — domain. <url>" at the start of a line.
// When the body of a 'References' section is a list of these, we render as <ol>.
const FOOTNOTE_DEF_RX = /^\[\^(\d+)\]:\s+(.+)$/;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const rx = new RegExp(INLINE_RX.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2]) {
      // **bold**
      parts.push(<strong key={`${keyPrefix}-b-${m.index}`}>{m[2]}</strong>);
    } else if (m[4]) {
      // *italic*
      parts.push(<em key={`${keyPrefix}-i-${m.index}`}>{m[4]}</em>);
    } else if (m[6]) {
      // [^N] footnote reference — superscript, links to #ref-N
      const n = m[6];
      parts.push(
        <sup key={`${keyPrefix}-sup-${m.index}`} style={{ fontSize: '0.7em', lineHeight: 0 }}>
          <a href={`#ref-${n}`} id={`cite-${n}`} style={{ textDecoration: 'none' }}>{n}</a>
        </sup>
      );
    } else if (m[8] && m[9]) {
      // [text](url) markdown link
      parts.push(
        <a key={`${keyPrefix}-a-${m.index}`} href={m[9]} target="_blank" rel="noopener noreferrer">{m[8]}</a>
      );
    } else if (m[11]) {
      // <https://url> autolink
      parts.push(
        <a key={`${keyPrefix}-u-${m.index}`} href={m[11]} target="_blank" rel="noopener noreferrer">{m[11]}</a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderBody(raw: string): React.ReactNode {
  const cleaned = raw.replace(ARTIFACT_RX, '').trim();
  const paragraphs = cleaned.split(/\n\n+/);

  // Detect a References section: every paragraph is a [^N]: definition.
  // When that's the case, render the whole thing as an <ol> with <li id="ref-N">.
  const allDefs = paragraphs.length > 0 && paragraphs.every(p => FOOTNOTE_DEF_RX.test(p.trim()));
  if (allDefs) {
    return (
      <ol style={{ paddingLeft: '1.5rem', fontSize: '0.95em', lineHeight: 1.6 }}>
        {paragraphs.map((para, pi) => {
          const m = para.trim().match(FOOTNOTE_DEF_RX);
          if (!m) return null;
          const n = m[1];
          const text = m[2];
          return (
            <li key={pi} id={`ref-${n}`} style={{ marginBottom: '0.6rem' }}>
              {renderInline(text, `def-${n}`)}
              {' '}
              <a href={`#cite-${n}`} style={{ textDecoration: 'none', opacity: 0.6, marginLeft: 4 }} aria-label="back to citation">↩</a>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <>
      {paragraphs.map((para, pi) => {
        const table = tryParseTable(para);
        if (table) {
          return (
            <table
              key={pi}
              style={{
                borderCollapse: 'collapse',
                width: '100%',
                margin: '1.25rem 0',
                fontSize: '0.95em',
                lineHeight: 1.55,
              }}
            >
              <thead>
                <tr>
                  {table.headers.map((h, ci) => (
                    <th
                      key={ci}
                      style={{
                        textAlign: 'left',
                        padding: '8px 12px',
                        borderBottom: '2px solid #E2E8F0',
                        fontWeight: 600,
                        color: '#0F172A',
                      }}
                    >
                      {renderInline(h, `t${pi}-h${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid #F1F5F9',
                          verticalAlign: 'top',
                          color: '#1E293B',
                        }}
                      >
                        {renderInline(cell, `t${pi}-r${ri}-c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return (
          <p key={pi} style={{ marginBottom: '1rem' }}>{renderInline(para, `p${pi}`)}</p>
        );
      })}
    </>
  );
}

// Markdown table parser. Handles both well-formed multi-line GFM and the
// degenerate single-line-flat case where the Content Generator emits a table
// without newlines between rows (the article 63ed73dd-… case). Detection key
// is the GFM separator row "|---|...|" with 3+ dashes per cell.
//
// Approach: ignore whitespace (including newlines), split on "|", trim, then
// use the separator's column count to slice header + data rows out of the
// non-empty cells. Works the same way regardless of how line breaks landed,
// so a single-line flat table and a properly newlined table both round-trip
// to the same structure.
function tryParseTable(raw: string): { headers: string[]; rows: string[][] } | null {
  if (!raw.includes('|')) return null;
  if (!/\|\s*:?-{3,}:?\s*\|/.test(raw)) return null;

  const cells = raw.split('|').map(c => c.trim());
  const isSep = (c: string) => /^:?-{3,}:?$/.test(c);

  const sepStart = cells.findIndex(isSep);
  if (sepStart === -1) return null;
  let sepEnd = sepStart;
  while (sepEnd < cells.length && isSep(cells[sepEnd])) sepEnd++;
  const colCount = sepEnd - sepStart;
  if (colCount < 1) return null;

  // Headers: the last `colCount` non-empty cells before the separator.
  const headers: string[] = [];
  for (let i = sepStart - 1; i >= 0 && headers.length < colCount; i--) {
    if (cells[i].length > 0) headers.unshift(cells[i]);
  }
  if (headers.length !== colCount) return null;

  // Rows: walk cells after the separator in chunks of colCount, skipping
  // row-boundary empties between each chunk. (Empty cells WITHIN a row are
  // preserved because the chunk takes exactly colCount cells without filtering.)
  const after = cells.slice(sepEnd);
  let idx = 0;
  while (idx < after.length && after[idx].length === 0) idx++;
  const rows: string[][] = [];
  while (idx + colCount <= after.length) {
    rows.push(after.slice(idx, idx + colCount));
    idx += colCount;
    while (idx < after.length && after[idx].length === 0) idx++;
  }
  if (rows.length === 0) return null;

  return { headers, rows };
}


interface ArticleSection { heading: string; content?: string; body?: string; }
interface ArticleFAQ { question: string; answer: string; }
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
  keyTakeaway?: string;
  faqs?: ArticleFAQ[];
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

          {/* ── TL;DR / Key Takeaway block ──
              First 150-200 words LLMs weight heaviest for extraction. This is the
              primary machine-readable summary of the article. Rendered as a distinct
              visual block so human readers also use it as a skim anchor. Gracefully
              skipped for articles generated before keyTakeaway was part of the schema. */}
          {article.keyTakeaway && (
            <aside className="pa-tldr" aria-label="Key takeaway">
              <div className="pa-tldr-label">Key takeaway</div>
              <p className="pa-tldr-body">{article.keyTakeaway}</p>
            </aside>
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

          {/* ── FAQ section ──
              Rendered as visible HTML so readers see it AND LLMs can parse it directly
              from the page DOM (FAQPage JSON-LD is in the <head>, but DOM-level Q&A
              structure is what crawlers actually index for featured snippets). */}
          {Array.isArray(article.faqs) && article.faqs.length > 0 && (
            <section className="pa-faqs" aria-label="Frequently asked questions">
              <h2 className="pa-section-heading">Frequently asked questions</h2>
              <div className="pa-faq-list">
                {article.faqs.map((faq, i) => (
                  <details key={i} className="pa-faq-item">
                    <summary className="pa-faq-question">{faq.question}</summary>
                    <div className="pa-faq-answer">{renderBody(faq.answer)}</div>
                  </details>
                ))}
              </div>
            </section>
          )}

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
            {/* EU AI Act Art. 50 — visible AI-content disclosure for human readers
                (the machine-readable IPTC marker rides in the SSR JSON-LD). */}
            <p className="pa-ai-disclosure" style={{ fontSize: 12, color: '#94A3B8', marginTop: 14, fontStyle: 'italic' }}>
              This article was created with AI assistance and reviewed for accuracy before publication.
            </p>
          </footer>

        </article>
      </main>
    </div>
  );
}
