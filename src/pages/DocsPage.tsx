import { useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { docs, docBySlug, docsByCategory } from '../docs';
import './DocsPage.css';

// Vite's ?raw imports drop the file in as a string at build time. SyntaxHighlighter
// renders fenced code blocks with the language hint after the opening fence.
export default function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();

  // Default redirect: /docs → first doc
  if (!slug) {
    const first = docs[0];
    if (!first) return <div className="docs-empty">No docs yet.</div>;
    return <Navigate to={`/docs/${first.slug}`} replace />;
  }

  const doc = docBySlug(slug);
  if (!doc) {
    return (
      <div className="docs-page">
        <Sidebar activeSlug={slug} />
        <main className="docs-main">
          <div className="docs-notfound">
            <h1>Not found</h1>
            <p>No doc matches <code>/{slug}</code>.</p>
            <Link to="/docs" className="docs-back-link">← Back to docs</Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="docs-page">
      <Sidebar activeSlug={slug} />
      <main className="docs-main">
        <article className="docs-article">
          <ShareWithAI doc={doc} />
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
                const match = /language-(\w+)/.exec(className || '');
                if (!inline && match) {
                  return (
                    <SyntaxHighlighter
                      language={match[1]}
                      style={oneDark as { [key: string]: React.CSSProperties }}
                      PreTag="div"
                      customStyle={{ borderRadius: 'var(--radius-sm)', margin: '1.25rem 0', fontSize: 13 }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                }
                return <code className={className} {...props}>{children}</code>;
              },
              a({ href, children, ...rest }) {
                const external = href?.startsWith('http');
                return (
                  <a
                    href={href}
                    target={external ? '_blank' : undefined}
                    rel={external ? 'noopener noreferrer' : undefined}
                    {...rest}
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {doc.content}
          </ReactMarkdown>
        </article>
      </main>
    </div>
  );
}

function Sidebar({ activeSlug }: { activeSlug: string }) {
  const grouped = docsByCategory();
  const categories: (keyof typeof grouped)[] = ['Integrations', 'Concepts', 'Reference'];

  return (
    <aside className="docs-sidebar">
      <Link to="/" className="docs-brand">Forge Intelligence</Link>
      <div className="docs-sidebar-label">Documentation</div>
      <nav className="docs-nav">
        {categories.map(cat => {
          const items = grouped[cat];
          if (!items.length) return null;
          return (
            <div key={cat} className="docs-nav-group">
              <div className="docs-nav-cat">{cat}</div>
              {items.map(d => (
                <Link
                  key={d.slug}
                  to={`/docs/${d.slug}`}
                  className={`docs-nav-link ${d.slug === activeSlug ? 'active' : ''}`}
                >
                  {d.title}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

// "Share With AI" — downloads the doc's markdown source so users can paste
// or attach it to Claude / ChatGPT / Cursor / etc. for help setting up the
// integration on their own stack. Adds a small AI-context preamble at the
// top so the receiving assistant has framing about what the doc is and how
// to act on it.
function ShareWithAI({ doc }: { doc: { slug: string; title: string; description: string; content: string } }) {
  const [copied, setCopied] = useState(false);

  const buildShareableMarkdown = () => {
    const preamble = `<!--
Source: Forge Intelligence — ${doc.title} integration documentation
URL: https://forgeintelligence.ai/docs/${doc.slug}
Description: ${doc.description}

You are helping a user set up the Forge Intelligence "${doc.title}" integration on their own website / application. Read the documentation below carefully. When the user asks for help:

1. Ask which stack they're on (Node/Express, Next.js, static site, etc.) if it's not obvious from context.
2. Use the matching sample receiver below as the starting point.
3. Walk them through the env var setup, database migration, and deployment.
4. Verify their receiver returns 200 OK and includes the optional { url } JSON in the response so Forge can populate the "View on site" link.
5. Help them debug if "Send test payload" in the Forge UI fails — start by checking auth, then endpoint URL, then response shape.

The documentation:
-->

`;
    return preamble + doc.content;
  };

  const downloadMarkdown = () => {
    const blob = new Blob([buildShareableMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forge-${doc.slug}-for-ai.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(buildShareableMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API blocked — fall back to downloading
      downloadMarkdown();
    }
  };

  return (
    <div className="docs-share-bar">
      <div className="docs-share-bar-text">
        <strong>Setting this up on your stack?</strong> Hand this doc to your AI assistant.
      </div>
      <div className="docs-share-bar-actions">
        <button className="docs-share-btn" onClick={copyToClipboard}>
          {copied ? '✓ Copied' : 'Copy for AI'}
        </button>
        <button className="docs-share-btn docs-share-btn-secondary" onClick={downloadMarkdown}>
          Download .md
        </button>
      </div>
    </div>
  );
}
