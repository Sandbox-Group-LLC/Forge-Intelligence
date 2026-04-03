import { useState, useEffect } from 'react';
import './ReviewPage.css';

interface Section { heading?: string; body?: string; content?: string; }
interface ArticleJson { sections?: Section[]; metaDescription?: string; }

interface ReviewData {
  queueId: string;
  title: string;
  brandName: string;
  brandUrl: string;
  heroImageUrl: string | null;
  articleJson: ArticleJson | null;
  confidence: number;
  createdAt: string;
  reviewStatus: string;
  reviewComment: string | null;
  reviewRequestedAt: string;
}

export default function ReviewPage() {
  const token = window.location.pathname.split('/review/')[1];
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<'approved' | 'changes_requested' | null>(null);

  useEffect(() => {
    fetch(`/api/review/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setData(d);
          if (d.reviewStatus === 'approved' || d.reviewStatus === 'changes_requested') {
            setDone(d.reviewStatus);
          }
        } else setError(d.error || 'Review link not found');
      })
      .catch(() => setError('Could not load review'));
  }, [token]);

  const submit = async (decision: 'approved' | 'changes_requested') => {
    setSubmitting(true);
    try {
      const r = await fetch(`/api/review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment })
      });
      const d = await r.json();
      if (d.success) setDone(decision);
      else setError(d.error || 'Submission failed');
    } finally { setSubmitting(false); }
  };

  if (error) return (
    <div className="rv-shell rv-error-shell">
      <div className="rv-logo">◈ Forge Intelligence</div>
      <div className="rv-error-card">
        <div className="rv-error-icon">⚠</div>
        <p className="rv-error-title">Link not found</p>
        <p className="rv-error-sub">{error}</p>
      </div>
    </div>
  );

  if (!data) return (
    <div className="rv-shell rv-loading-shell">
      <div className="rv-logo">◈ Forge Intelligence</div>
      <div className="rv-spinner" />
    </div>
  );

  const sections = data.articleJson?.sections || [];

  if (done) return (
    <div className="rv-shell rv-done-shell">
      <div className="rv-logo">◈ Forge Intelligence</div>
      <div className={`rv-done-card ${done}`}>
        <div className="rv-done-icon">{done === 'approved' ? '✓' : '↩'}</div>
        <p className="rv-done-title">
          {done === 'approved' ? 'Article approved' : 'Changes requested'}
        </p>
        <p className="rv-done-sub">
          {done === 'approved'
            ? 'The content team has been notified. This article is ready to publish.'
            : 'Your feedback has been sent. The content team will make revisions.'}
        </p>
        {comment && <p className="rv-done-comment">"{comment}"</p>}
      </div>
    </div>
  );

  return (
    <div className="rv-shell">
      {/* Top bar */}
      <header className="rv-header">
        <div className="rv-logo">◈ Forge Intelligence</div>
        <div className="rv-header-meta">
          <span className="rv-brand-tag">{data.brandName}</span>
          <span className="rv-review-label">Awaiting your review</span>
        </div>
      </header>

      <div className="rv-layout">
        {/* Article column */}
        <article className="rv-article">
          {data.heroImageUrl && (
            <img src={data.heroImageUrl} alt={data.title} className="rv-hero" />
          )}
          <div className="rv-article-body">
            <h1 className="rv-title">{data.title}</h1>
            <div className="rv-byline">
              <span>{data.brandName}</span>
              <span className="rv-dot">·</span>
              <span>{new Date(data.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              {data.confidence > 0 && (
                <>
                  <span className="rv-dot">·</span>
                  <span className="rv-confidence">{data.confidence}% confidence</span>
                </>
              )}
            </div>
            {data.articleJson?.metaDescription && (
              <p className="rv-lede">{data.articleJson.metaDescription}</p>
            )}
            <div className="rv-sections">
              {sections.map((s, i) => (
                <div key={i} className="rv-section">
                  {s.heading && <h2 className="rv-section-heading">{s.heading}</h2>}
                  <p className="rv-section-body">{s.body || s.content}</p>
                </div>
              ))}
            </div>
          </div>
        </article>

        {/* Review panel */}
        <aside className="rv-panel">
          <div className="rv-panel-inner">
            <div className="rv-panel-title">Your Review</div>
            <p className="rv-panel-sub">Leave a comment and approve or request changes below.</p>

            <textarea
              className="rv-comment"
              placeholder="Add a comment or feedback (optional)..."
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={5}
            />

            <button
              className="rv-btn rv-btn-approve"
              onClick={() => submit('approved')}
              disabled={submitting}
            >
              {submitting ? '...' : '✓ Approve'}
            </button>
            <button
              className="rv-btn rv-btn-changes"
              onClick={() => submit('changes_requested')}
              disabled={submitting}
            >
              {submitting ? '...' : '↩ Request Changes'}
            </button>

            <div className="rv-panel-footer">
              <span>◈</span> Powered by Forge Intelligence
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
