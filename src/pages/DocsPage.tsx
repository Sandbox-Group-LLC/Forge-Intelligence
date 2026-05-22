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
                      customStyle={{ borderRadius: 8, margin: '1.25rem 0', fontSize: 13 }}
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
