import { useState } from 'react';
import { AppShell } from '../layouts/AppShell';
import { useApp } from '../context/AppContext';
import './ContentImportPage.css';

interface ImportResult {
  contentId: string;
  title: string;
  overallConfidence: number;
  brainMatchScore: number;
  voiceDeviationScore: number;
  importVerdict: string;
  brainFlags: string[];
  suggestions: string[];
  sectionCount: number;
}

// Lucide-style icons
const IconLink = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);
const IconClipboard = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
  </svg>
);
const IconZap = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const IconBrain = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.077-4.56A3 3 0 0 1 3.83 9.85a3 3 0 0 1 .81-4.87A2.5 2.5 0 0 1 9.5 2Z"/>
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.077-4.56A3 3 0 0 0 20.17 9.85a3 3 0 0 0-.81-4.87A2.5 2.5 0 0 0 14.5 2Z"/>
  </svg>
);
const IconAlert = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
    <path d="M12 9v4"/><path d="M12 17h.01"/>
  </svg>
);
const IconLightbulb = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
    <path d="M9 18h6"/><path d="M10 22h4"/>
  </svg>
);
const IconArrow = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
  </svg>
);

const scoreColor = (n: number) => n >= 75 ? '#10B981' : n >= 50 ? '#F59E0B' : '#EF4444';

export default function ContentImportPage() {
  const { activeBrandId } = useApp();
  const selectedBrand = activeBrandId || localStorage.getItem('forge_active_brand_id') || '';
  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  const runImport = async () => {
    if (!selectedBrand) { setError('No Brain found — run an analysis first'); return; }
    if (mode === 'url' && !url.trim()) { setError('Enter a URL'); return; }
    if (mode === 'paste' && !rawText.trim()) { setError('Paste some content'); return; }
    setImporting(true);
    setError('');
    setResult(null);
    try {
      const r = await fetch('/api/content/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandProfileId: selectedBrand,
          url: mode === 'url' ? url.trim() : undefined,
          rawText: mode === 'paste' ? rawText.trim() : undefined,
          title: manualTitle.trim() || undefined
        })
      });
      const d = await r.json();
      if (d.success) setResult(d);
      else setError(d.error || 'Import failed');
    } catch(e: any) {
      setError(e.message || 'Import failed');
    } finally { setImporting(false); }
  };

  return (
    <AppShell pageTitle="Content Import">
      <div className="ci-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Publishing</div>
            <h1 className="geo-title">Import Article</h1>
            <p className="geo-description">Bring an article written outside Forge. The Brain will read it, score it, and tell you exactly what it thinks.</p>
          </div>
        </div>

        {!result ? (
          <div className="ci-form-card">
            {/* Mode toggle */}
            <div className="ci-field">
              <label className="ci-label">Import Method</label>
              <div className="ci-mode-toggle">
                <button className={`ci-mode-btn ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>
                  <IconLink /> Paste URL
                </button>
                <button className={`ci-mode-btn ${mode === 'paste' ? 'active' : ''}`} onClick={() => setMode('paste')}>
                  <IconClipboard /> Paste Text
                </button>
              </div>
            </div>

            {mode === 'url' ? (
              <div className="ci-field">
                <label className="ci-label">Article URL</label>
                <input
                  className="ci-input"
                  placeholder="https://yourblog.com/your-article"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && runImport()}
                />
              </div>
            ) : (
              <>
                <div className="ci-field">
                  <label className="ci-label">Article Title</label>
                  <input
                    className="ci-input"
                    placeholder="What's the title?"
                    value={manualTitle}
                    onChange={e => setManualTitle(e.target.value)}
                  />
                </div>
                <div className="ci-field">
                  <label className="ci-label">Article Content</label>
                  <textarea
                    className="ci-textarea"
                    placeholder="Paste the full article text here..."
                    value={rawText}
                    onChange={e => setRawText(e.target.value)}
                    rows={12}
                  />
                </div>
              </>
            )}

            {error && <div className="geo-error">{error}</div>}

            <div className="ci-disclaimer">
              <IconZap />
              The Brain will score this article against your brand voice, patterns, and audience data. It will not be gentle.
            </div>

            <button
              className="ci-import-btn"
              onClick={runImport}
              disabled={importing || !selectedBrand}
            >
              {importing ? (
                <><span className="ci-spinner" /> Brain is reading your article...</>
              ) : (
                <><IconArrow /> Import & Audit</>
              )}
            </button>
          </div>
        ) : (
          <div className="ci-result">
            {/* Verdict banner */}
            <div className={`ci-verdict-banner ${result.overallConfidence >= 75 ? 'strong' : result.overallConfidence >= 50 ? 'moderate' : 'weak'}`}>
              <div className="ci-verdict-scores">
                <div className="ci-score-block">
                  <span className="ci-score-val" style={{ color: scoreColor(result.overallConfidence) }}>{result.overallConfidence}</span>
                  <span className="ci-score-label">Overall</span>
                </div>
                <div className="ci-score-divider" />
                <div className="ci-score-block">
                  <span className="ci-score-val" style={{ color: scoreColor(result.brainMatchScore) }}>{result.brainMatchScore}</span>
                  <span className="ci-score-label">Brain Match</span>
                </div>
                <div className="ci-score-divider" />
                <div className="ci-score-block">
                  <span className="ci-score-val" style={{ color: scoreColor(100 - (result.voiceDeviationScore || 0)) }}>{result.voiceDeviationScore || 0}%</span>
                  <span className="ci-score-label">Voice Deviation</span>
                </div>
              </div>
              <div className="ci-verdict-text">
                <div className="ci-verdict-title">{result.title}</div>
                <div className="ci-verdict-copy">"{result.importVerdict}"</div>
              </div>
            </div>

            {/* Brain flags */}
            {result.brainFlags.length > 0 && (
              <div className="ci-section">
                <div className="ci-section-title"><IconBrain /> Brain Flags</div>
                <div className="ci-flags">
                  {result.brainFlags.map((f, i) => (
                    <div key={i} className="ci-flag"><IconAlert /> {f}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Suggestions */}
            {result.suggestions.length > 0 && (
              <div className="ci-section">
                <div className="ci-section-title"><IconLightbulb /> Brain Suggests</div>
                <div className="ci-suggestions">
                  {result.suggestions.map((s, i) => (
                    <div key={i} className="ci-suggestion"><IconArrow /> {s}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="ci-result-actions">
              <a href="/app/compliance-gate" className="ci-action-btn primary">
                <IconArrow /> Review in Compliance Gate
              </a>
              <a href="/app/publishing-queue" className="ci-action-btn secondary">
                View in Queue
              </a>
              <button className="ci-action-btn ghost" onClick={() => { setResult(null); setUrl(''); setRawText(''); setManualTitle(''); }}>
                Import Another
              </button>
            </div>

            <div className="ci-result-note">
              Article imported with {result.sectionCount} sections · staged in Publishing Queue · ready for Compliance Gate review
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
