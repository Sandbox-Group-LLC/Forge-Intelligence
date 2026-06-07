import { useState, useEffect, useRef } from 'react';
import './AiVisibilityScanPage.css';

// Engines AI answer-engines we probe, in display order.
const ENGINES: { id: string; label: string }[] = [
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'aiOverviews', label: 'Google AI Overviews' },
];

// Generic platforms vs. brands/vendors — a light, honest split for the
// "who AI cites instead" panel. Anything not in this set is treated as a
// brand/vendor name worth surfacing.
const GENERIC = new Set([
  'youtube.com', 'linkedin.com', 'reddit.com', 'wikipedia.org', 'medium.com',
  'github.com', 'quora.com', 'facebook.com', 'x.com', 'twitter.com', 'substack.com',
]);

type ScanResult = {
  success: boolean;
  error?: string;
  brandName?: string;
  brandDomain?: string;
  visibility?: number;
  totalChecks?: number;
  totalCited?: number;
  byEngine?: Record<string, { checks: number; cited: number; pct: number; available?: boolean }>;
  questions?: string[];
  citedQueries?: string[];
  sources?: { domain: string; mentions: number }[];
};

const LOADING_STEPS = [
  'Reading your site…',
  'Figuring out what your buyers ask AI…',
  'Asking ChatGPT…',
  'Asking Perplexity…',
  'Asking Gemini…',
  'Checking Google AI Overviews…',
  'Counting who gets cited instead…',
  'Scoring your AI visibility…',
];

export default function AiVisibilityScanPage() {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [stepIdx, setStepIdx] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const stepTimer = useRef<number | null>(null);

  useEffect(() => () => { if (stepTimer.current) window.clearInterval(stepTimer.current); }, []);

  async function runScan(e?: React.FormEvent) {
    e?.preventDefault();
    const clean = url.trim();
    if (!clean) return;
    setPhase('loading'); setError(''); setResult(null); setStepIdx(0);
    stepTimer.current = window.setInterval(
      () => setStepIdx(i => Math.min(i + 1, LOADING_STEPS.length - 1)), 9000
    );
    try {
      const res = await fetch('/api/geo/cold-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      });
      const data: ScanResult = await res.json();
      if (stepTimer.current) window.clearInterval(stepTimer.current);
      if (!res.ok || !data.success) {
        setError(data.error || `Scan failed (${res.status}). Try again shortly.`);
        setPhase('error');
        return;
      }
      setResult(data);
      setPhase('done');
    } catch {
      if (stepTimer.current) window.clearInterval(stepTimer.current);
      setError('Something went wrong reaching the scanner. Try again in a moment.');
      setPhase('error');
    }
  }

  function reset() { setPhase('idle'); setResult(null); setError(''); setUrl(''); }

  const vis = result?.visibility ?? 0;
  const scoreClass = vis === 0 ? 'bad' : vis < 25 ? 'warn' : 'ok';

  const sources = result?.sources || [];
  const vendors = sources.filter(s => !GENERIC.has(s.domain)).slice(0, 7);
  const generic = sources.filter(s => GENERIC.has(s.domain)).slice(0, 5);
  const lostQuestions = (result?.questions || [])
    .filter(q => !(result?.citedQueries || []).includes(q))
    .slice(0, 4);

  return (
    <div className="avs-page">
      <div className="avs-wrap">
        <div className="avs-top">
          <span className="avs-mark" aria-label="Forge Intelligence">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 22 12 12 22 2 12" />
            </svg>
          </span>
          <span className="avs-logo">Forge Intelligence <span>· AI Visibility Scan</span></span>
        </div>

        {(phase === 'idle' || phase === 'error') && (
          <div className="avs-hero">
            <div className="avs-eyebrow">Generative Engine Optimization</div>
            <h1>How often does AI recommend you?</h1>
            <p className="lede">
              ChatGPT, Perplexity, Gemini, and Google AI Overviews answer your buyers’ questions every day.
              Drop your domain and we’ll measure <strong>live</strong> whether they name you, and who they name instead.
            </p>
            <form className="avs-form" onSubmit={runScan}>
              <input
                className="avs-input"
                type="text"
                inputMode="url"
                placeholder="yourcompany.com"
                value={url}
                onChange={e => setUrl(e.target.value)}
                autoFocus
              />
              <button className="avs-btn" type="submit" disabled={!url.trim()}>Run free scan</button>
            </form>
            <div className="avs-formnote">Free · no signup · ~60 seconds · measured across all four engines</div>
            {phase === 'error' && <div className="avs-err">{error}</div>}
          </div>
        )}

        {phase === 'loading' && (
          <div className="avs-loading">
            <div className="avs-spinner" />
            <div className="step">{LOADING_STEPS[stepIdx]}</div>
            <div className="sub">Running real queries against four AI engines. This takes up to a minute.</div>
          </div>
        )}

        {phase === 'done' && result && (
          <>
            <div className="avs-report">
              <div className="avs-rhd">
                <span className="who">{result.brandName || result.brandDomain}</span>
                <span className="tagpill">AI Visibility Report</span>
              </div>
              <div className="avs-rbody">
                <div className="avs-scorewrap">
                  <div className={`avs-score ${scoreClass}`}>{vis}<small>%</small></div>
                  <div className="avs-scoretext">
                    <div className="l">
                      {result.brandName || 'You'} appeared in {result.totalCited} of {result.totalChecks} AI answers.
                    </div>
                    <div className="s">
                      {vis === 0
                        ? 'Not once. Across every engine and every question your buyers ask, AI never named you.'
                        : 'Across the questions your buyers ask AI about your category, measured live, not modeled.'}
                    </div>
                  </div>
                </div>

                <div className="avs-sec">
                  <h2>Visibility by engine</h2>
                  <div className="avs-bars">
                    {ENGINES.map(eng => {
                      const stats = result.byEngine?.[eng.id];
                      // available:false (or missing) => the engine couldn't be queried;
                      // show "not measured" rather than a misleading 0%.
                      const available = stats ? stats.available !== false && stats.checks > 0 : false;
                      const pct = stats?.pct ?? 0;
                      if (!available) {
                        return (
                          <div className="avs-bar" key={eng.id}>
                            <span className="nm">{eng.label}</span>
                            <div className="avs-track" />
                            <span className="pc na">n/a</span>
                          </div>
                        );
                      }
                      return (
                        <div className="avs-bar" key={eng.id}>
                          <span className="nm">{eng.label}</span>
                          <div className="avs-track"><div className={`avs-fill ${pct === 0 ? 'zero' : ''}`} style={{ width: `${Math.max(pct, 1)}%` }} /></div>
                          <span className={`pc ${pct === 0 ? 'zero' : ''}`}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {(vendors.length > 0 || generic.length > 0) && (
                  <div className="avs-sec">
                    <h2>Who AI cites instead</h2>
                    <div className="avs-cols">
                      {vendors.length > 0 && (
                        <div className="avs-card">
                          <h3>Brands &amp; vendors AI names</h3>
                          <div className="cap">When buyers ask about your category, these come up. You don’t.</div>
                          <div className="avs-chips">
                            {vendors.map(v => <span className="avs-chip vendor" key={v.domain}>{v.domain}<b>{v.mentions}</b></span>)}
                          </div>
                        </div>
                      )}
                      {generic.length > 0 && (
                        <div className="avs-card">
                          <h3>Where else AI sends your buyers</h3>
                          <div className="cap">Generic sources AI falls back to when no clear vendor wins.</div>
                          <div className="avs-chips">
                            {generic.map(g => <span className="avs-chip" key={g.domain}>{g.domain}<b>{g.mentions}</b></span>)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {lostQuestions.length > 0 && (
                  <div className="avs-sec">
                    <h2>{vis === 0 ? 'The questions you’re losing' : 'Questions you’re not winning'}</h2>
                    <div className="avs-qlist">
                      {lostQuestions.map((q, i) => (
                        <div className="avs-q" key={i}><span className="x">✕</span><span>“{q}”</span></div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="avs-cta">
                  <div>
                    <div className="t">Turn these answers in your favor.</div>
                    <div className="s">Forge maps every buyer question to the content that earns the AI citation, and tracks your score weekly across all four engines.</div>
                  </div>
                  <a href="/?utm_source=ai-visibility-scan">Get your GEO plan →</a>
                </div>
              </div>
            </div>
            <button className="avs-again" onClick={reset}>← Scan another domain</button>
            <div className="avs-foot">Measured live across ChatGPT · Perplexity · Gemini · Google AI Overviews · {result.totalChecks} checks</div>
          </>
        )}
      </div>
    </div>
  );
}
