import { useNavigate } from 'react-router-dom';
import './NoBrandEmpty.css';

interface NoBrandEmptyProps {
  /** Page name (e.g., 'Publishing Queue', 'Content Library') */
  pageName: string;
  /** One-sentence description of what this page does once a brand exists */
  pageDescription: string;
  /** Optional 2-4 bullet items describing what shows up here */
  features?: string[];
  /** Optional icon override (defaults to compass) */
  icon?: React.ReactNode;
}

const defaultIcon = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
  </svg>
);

export function NoBrandEmpty({ pageName, pageDescription, features, icon }: NoBrandEmptyProps) {
  const navigate = useNavigate();

  return (
    <div className="no-brand-empty">
      <div className="no-brand-empty-card">
        <div className="no-brand-empty-icon">{icon ?? defaultIcon}</div>
        <h2 className="no-brand-empty-title">{pageName}</h2>
        <p className="no-brand-empty-desc">{pageDescription}</p>

        {features && features.length > 0 && (
          <ul className="no-brand-empty-features">
            {features.map((f, i) => (
              <li key={i}>
                <span className="no-brand-empty-bullet">→</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="no-brand-empty-cta-block">
          <p className="no-brand-empty-cta-prompt">Start by creating your first brand profile.</p>
          <button
            className="no-brand-empty-cta-btn"
            onClick={() => navigate('/app/context-hub')}
          >
            Create your first brand →
          </button>
        </div>
      </div>
    </div>
  );
}
