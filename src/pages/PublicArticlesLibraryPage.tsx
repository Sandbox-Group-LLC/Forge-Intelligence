import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import './PublicArticlesLibraryPage.css';

interface ArticlePreview {
  id: string;
  title: string;
  metaDescription: string;
  brandSlug: string;
  articleSlug: string;
  brandName: string;
  publishedAt: string;
  heroImageUrl?: string;
}

export default function PublicArticlesLibraryPage() {
  const { brandSlug } = useParams<{ brandSlug?: string }>();
  const [articles, setArticles] = useState<ArticlePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [brandName, setBrandName] = useState<string>('');

  useEffect(() => {
    const fetchArticles = async () => {
      try {
        const url = brandSlug 
          ? `/api/public/articles?brandSlug=${encodeURIComponent(brandSlug)}`
          : '/api/public/articles';
        const res = await fetch(url);
        const data = await res.json();
        if (data.success) {
          setArticles(data.articles || []);
          if (data.brandName) setBrandName(data.brandName);
        }
      } catch (err) {
        console.error('Failed to fetch articles:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchArticles();
  }, [brandSlug]);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', { 
        year: 'numeric', month: 'short', day: 'numeric' 
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="pal-container">
      <header className="pal-header">
        <div className="pal-header-inner">
          <Link to="/" className="pal-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3563FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>
            </svg>
            <span>Forge Intelligence</span>
          </Link>
          <a href="https://forgeintelligence.ai" className="pal-cta-link">
            Run your brand →
          </a>
        </div>
      </header>

      <main className="pal-main">
        <div className="pal-hero">
          <h1 className="pal-title">
            {brandSlug 
              ? (brandName || 'Articles')
              : 'Forge Articles'
            }
          </h1>
          <p className="pal-subtitle">
            {brandSlug
              ? `Content published with Forge Intelligence`
              : 'AI-powered content from brands using Forge Intelligence'
            }
          </p>
        </div>

        {loading ? (
          <div className="pal-loading">
            <div className="pal-spinner" />
            <span>Loading articles...</span>
          </div>
        ) : articles.length === 0 ? (
          <div className="pal-empty">
            <p>No published articles yet.</p>
            <a href="https://forgeintelligence.ai" className="pal-empty-cta">
              Be the first to publish with Forge →
            </a>
          </div>
        ) : (
          <div className="pal-grid">
            {articles.map(article => (
              <Link 
                key={article.id} 
                to={`/articles/${article.brandSlug}/${article.articleSlug}`}
                className="pal-card"
              >
                {article.heroImageUrl && (
                  <div className="pal-card-image">
                    <img src={article.heroImageUrl} alt={article.title} />
                  </div>
                )}
                <div className="pal-card-content">
                  <h2 className="pal-card-title">{article.title}</h2>
                  {article.metaDescription && (
                    <p className="pal-card-desc">{article.metaDescription}</p>
                  )}
                  <div className="pal-card-meta">
                    <span className="pal-card-brand">{article.brandName}</span>
                    {article.publishedAt && (
                      <>
                        <span className="pal-card-dot">·</span>
                        <span className="pal-card-date">{formatDate(article.publishedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <footer className="pal-footer">
        <div className="pal-footer-inner">
          <span className="pal-footer-text">
            Powered by{' '}
            <a href="https://forgeintelligence.ai">Forge Intelligence</a>
          </span>
          <a href="https://forgeintelligence.ai" className="pal-footer-cta">
            Build content that compounds →
          </a>
        </div>
      </footer>
    </div>
  );
}
