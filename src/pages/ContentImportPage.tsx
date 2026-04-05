import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
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

const scoreColor = (n: number) => n >= 75 ? '#10B981' : n >= 50 ? '#F59E0B' : '#EF4444';

export default function ContentImportPage() {
  const { activeBrand } = useApp();


  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  // Brain selection handled by TopBar

  const runImport = async () => {
    if (!activeBrand?.id) { setError('Select a brain from TopBar first'); return; }
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
          brandProfileId: activeBrand?.id,
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
            <div className="geo-eyebrow">Content</div>
            <h1 className="geo-title">Import Article</h1>
            <p className="geo-description">Bring an article written outside Forge. The Brain will read it, score it, and tell you exactly what it thinks.</p>
          </div>
        </div>

        {!result ? (
          <div className="ci-form-card">
            {/* Brain from TopBar */}
            <div className="ci-field">
              <label className="ci-label">Brain</label>
              <div className="geo-select" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {activeBrand ? <><span style={{ color: '#10B981' }}>✓</span> {activeBrand.brandName}</> : <span style={{ opacity: 0.5 }}>Select brain from TopBar</span>}
              </div>
            </div>

            {/* Mode toggle */}
            <div className="ci-field">
              <label className="ci-label">Import Method</label>
              <div className="ci-mode-toggle">
                <button className={`ci-mode-btn ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>
                  🔗 Paste URL
                </button>
                <button className={`ci-mode-btn ${mode === 'paste' ? 'active' : ''}`} onClick={() => setMode('paste')}>
                  📋 Paste Text
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
              <span>⚡</span>
              The Brain will score this article against your brand voice, patterns, and audience data. It will not be gentle.
            </div>

            <button
              className="ci-import-btn"
              onClick={runImport}
              disabled={importing || !activeBrand?.id}
            >
              {importing ? (
                <><span className="ci-spinner" /> Brain is reading your article...</>
              ) : (
                '→ Import & Audit'
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
                <div className="ci-section-title">🧠 Brain Flags</div>
                <div className="ci-flags">
                  {result.brainFlags.map((f, i) => (
                    <div key={i} className="ci-flag">⚠ {f}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Suggestions */}
            {result.suggestions.length > 0 && (
              <div className="ci-section">
                <div className="ci-section-title">💡 Brain Suggests</div>
                <div className="ci-suggestions">
                  {result.suggestions.map((s, i) => (
                    <div key={i} className="ci-suggestion">→ {s}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="ci-result-actions">
              <a href="/app/compliance-gate" className="ci-action-btn primary">
                → Review in Compliance Gate
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
