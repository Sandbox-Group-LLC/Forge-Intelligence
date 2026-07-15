import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import './BrandIntelligenceBriefPage.css';

export default function BrandIntelligenceBriefPage() {
  const { token } = useParams<{ token: string }>();
  const [brief, setBrief] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/strategy/brief/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) setBrief(d);
        else setError(d.error || 'Brief not found');
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return (
    <div className="bi-brief-loading">
      <div className="bi-brief-loading-text">Loading intelligence brief...</div>
    </div>
  );

  if (error) return (
    <div className="bi-brief-error">
      <div className="bi-brief-error-title">{error === 'This brief link has been revoked' ? 'Brief Revoked' : 'Brief Not Found'}</div>
      <div className="bi-brief-error-text">{error}</div>
    </div>
  );

  if (!brief) return null;

  const pivot = brief.pivot;
  const gaps = brief.gapMap || [];
  const competitors = brief.competitors || [];
  const blindSpots = brief.blindSpots || [];
  const whitespace = brief.whitespace || [];
  const updatedDate = new Date(brief.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const severityColor = (s: string) => s === 'high' ? '#ef4444' : s === 'medium' ? '#f5b942' : '#94a3b8';
  const scoreColor = (s: number) => s >= 75 ? '#14b8a6' : s >= 50 ? '#f5b942' : '#ef4444';

  return (
    <div className="bi-brief">
      {/* Confidential banner */}
      <div className="bi-brief-confidential">CONFIDENTIAL — Prepared exclusively for {brief.brandName}. Do not distribute without authorization.</div>

      {/* Hero */}
      <header className="bi-brief-hero">
        <div className="bi-brief-hero-inner">
          <div className="bi-brief-eyebrow">Brand Intelligence Brief</div>
          <h1 className="bi-brief-brand">{brief.brandName}</h1>
          <div className="bi-brief-date">Updated {updatedDate}</div>
        </div>
      </header>

      <div className="bi-brief-body">

        {/* ═══ POSITIONING PIVOT ═══ */}
        {pivot && (
          <section className="bi-section">
            <div className="bi-section-num">01</div>
            <h2 className="bi-section-title">Recommended Positioning Pivot</h2>

            <div className="bi-pivot-statement">{pivot.pivotStatement}</div>

            <div className="bi-pivot-fromto">
              <div className="bi-pivot-from">
                <div className="bi-fromto-label">FROM</div>
                <div className="bi-fromto-text">{pivot.fromTo?.from}</div>
              </div>
              <div className="bi-pivot-arrow">→</div>
              <div className="bi-pivot-to">
                <div className="bi-fromto-label">TO</div>
                <div className="bi-fromto-text">{pivot.fromTo?.to}</div>
              </div>
            </div>

            <div className="bi-subsection">
              <div className="bi-label">Why Now</div>
              <p>{pivot.whyNow}</p>
            </div>

            {pivot.threeMovesIn90Days && (
              <div className="bi-subsection">
                <div className="bi-label">Three Moves in 90 Days</div>
                {pivot.threeMovesIn90Days.map((m: any, i: number) => (
                  <div key={i} className="bi-move">
                    <div className="bi-move-num">{i + 1}</div>
                    <div className="bi-move-body">
                      <div className="bi-move-title">{m.move}</div>
                      <div className="bi-move-rationale">{m.rationale}</div>
                      <div className="bi-move-outcome">{m.outcome}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pivot.whatToStopDoing && (
              <div className="bi-subsection bi-stop">
                <div className="bi-label">Stop Doing</div>
                <p>{pivot.whatToStopDoing}</p>
              </div>
            )}

            <div className="bi-board-slide">
              <div className="bi-label">The Board Slide</div>
              <p>{pivot.boardSlide}</p>
            </div>
          </section>
        )}

        {/* ═══ GAP MAP ═══ */}
        {gaps.length > 0 && (
          <section className="bi-section">
            <div className="bi-section-num">02</div>
            <h2 className="bi-section-title">Competitive Gap Map</h2>
            <p className="bi-section-desc">Undefended market positions ranked by opportunity.</p>
            {gaps.map((g: any, i: number) => (
              <div key={i} className="bi-card">
                <div className="bi-card-header">
                  <div className="bi-card-title">{g.position}</div>
                  <span className="bi-score" style={{ color: scoreColor(g.opportunityScore) }}>{g.opportunityScore}/100</span>
                </div>
                <div className="bi-card-body">
                  <p>{g.currentState}</p>
                  <div className="bi-label">Board Implication</div>
                  <p className="bi-highlight">{g.boardImplication}</p>
                  <div className="bi-label">Attack Vector</div>
                  <p>{g.attackVector}</p>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ═══ VULNERABILITIES ═══ */}
        {competitors.length > 0 && competitors.some((c: any) => c.pva?.length > 0) && (
          <section className="bi-section">
            <div className="bi-section-num">03</div>
            <h2 className="bi-section-title">Positioning Vulnerabilities</h2>
            <p className="bi-section-desc">Competitor claims that are overexposed or unsubstantiated.</p>
            {competitors.filter((c: any) => c.pva?.length > 0).map((comp: any, ci: number) => (
              <div key={ci} className="bi-comp-group">
                <div className="bi-comp-name">{comp.name}</div>
                {comp.pva.map((v: any, vi: number) => (
                  <div key={vi} className="bi-card">
                    <div className="bi-card-header">
                      <span className="bi-severity" style={{ color: severityColor(v.severity) }}>{v.severity?.toUpperCase()}</span>
                      <span className="bi-type">{v.type?.replace(/_/g, ' ')}</span>
                    </div>
                    <div className="bi-card-body">
                      <div className="bi-quote">"{v.claim}"</div>
                      <p>{v.evidence}</p>
                      <div className="bi-label">Strategic Opening</div>
                      <p>{v.vulnerability}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        {/* ═══ FAULT LINES ═══ */}
        {competitors.length > 0 && competitors.some((c: any) => c.faultLines?.length > 0) && (
          <section className="bi-section">
            <div className="bi-section-num">04</div>
            <h2 className="bi-section-title">Messaging Fault Lines</h2>
            <p className="bi-section-desc">Exact competitor language and differentiation angles.</p>
            {competitors.filter((c: any) => c.faultLines?.length > 0).map((comp: any, ci: number) => (
              <div key={ci} className="bi-comp-group">
                <div className="bi-comp-name">{comp.name}</div>
                {comp.faultLines.map((fl: any, fi: number) => (
                  <div key={fi} className="bi-card">
                    <div className="bi-card-header">
                      <span className="bi-severity" style={{ color: fl.priority === 'high' ? '#3563ff' : fl.priority === 'medium' ? '#8b5cf6' : '#94a3b8' }}>{fl.priority?.toUpperCase()}</span>
                    </div>
                    <div className="bi-card-body">
                      <div className="bi-quote">"{fl.theirLanguage}"</div>
                      <p>{fl.frequency}</p>
                      <div className="bi-label">Differentiation Angle</div>
                      <p>{fl.differentiationAngle}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        {/* ═══ BLIND SPOTS ═══ */}
        {blindSpots.length > 0 && (
          <section className="bi-section">
            <div className="bi-section-num">05</div>
            <h2 className="bi-section-title">Audience Blind Spots</h2>
            <p className="bi-section-desc">Buyer personas the market is ignoring.</p>
            {blindSpots.map((s: any, i: number) => (
              <div key={i} className="bi-card">
                <div className="bi-card-header">
                  <div className="bi-card-title">{s.persona}</div>
                  <span className="bi-score" style={{ color: s.opportunitySize === 'large' ? '#14b8a6' : s.opportunitySize === 'medium' ? '#f5b942' : '#94a3b8' }}>{s.opportunitySize?.toUpperCase()}</span>
                </div>
                <div className="bi-card-body">
                  <div className="bi-role">{s.role}</div>
                  <p>{s.whyBlind}</p>
                  <div className="bi-label">Board Implication</div>
                  <p className="bi-highlight">{s.boardImplication}</p>
                  <div className="bi-label">Activation Play</div>
                  <p>{s.activationPlay}</p>
                  {s.experientialPlay && (
                    <>
                      <div className="bi-label bi-label-purple">Experiential Play</div>
                      <p>{s.experientialPlay}</p>
                    </>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ═══ WHITESPACE ═══ */}
        {whitespace.length > 0 && (
          <section className="bi-section">
            <div className="bi-section-num">06</div>
            <h2 className="bi-section-title">Topical Authority Whitespace</h2>
            <p className="bi-section-desc">Conversations this brand is invisible in.</p>
            {whitespace.map((t: any, i: number) => {
              const pb = t.platformBreakdown || {};
              return (
                <div key={i} className="bi-card">
                  <div className="bi-card-header">
                    <div className="bi-card-title">{t.narrative}</div>
                    <span className="bi-score" style={{ color: t.brandVisibility <= 30 ? '#ef4444' : t.brandVisibility <= 55 ? '#f5b942' : '#94a3b8' }}>Visibility: {t.brandVisibility}/100</span>
                  </div>
                  <div className="bi-card-body">
                    <div className="bi-ws-meta">Controlled by {t.controlledBy} · Reclaim: {t.reclaimDifficulty}{t.quickWin ? ' · ⚡ Quick Win' : ''}</div>
                    <div className="bi-ws-bars">
                      {['chatgpt', 'perplexity', 'gemini', 'aiOverviews'].map(p => (
                        <div key={p} className="bi-ws-bar-row">
                          <span className="bi-ws-bar-label">{p === 'aiOverviews' ? 'AI Overviews' : p.charAt(0).toUpperCase() + p.slice(1)}</span>
                          <div className="bi-ws-bar"><div className="bi-ws-bar-fill" style={{ width: `${pb[p] || 0}%` }} /></div>
                          <span className="bi-ws-bar-val">{pb[p] || 0}</span>
                        </div>
                      ))}
                    </div>
                    <div className="bi-label">Cost of Invisibility</div>
                    <p>{t.invisibilityCost}</p>
                    <div className="bi-label">Board Implication</div>
                    <p className="bi-highlight">{t.boardImplication}</p>
                    <div className="bi-label">90-Day Play</div>
                    <p>{t.ninetyDayPlay}</p>
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </div>

      {/* Forge footer */}
      <footer className="bi-brief-footer">
        <div className="bi-brief-footer-inner">
          <div className="bi-brief-footer-mark">Intelligence compiled by <a href="https://forgeintelligence.ai" target="_blank" rel="noopener">Forge Intelligence</a></div>
          <div className="bi-brief-footer-sub">Context-based brand intelligence that compounds.</div>
          <div className="bi-brief-copyright">&copy; {new Date().getFullYear()} Sandbox Group LLC. All rights reserved. This document contains proprietary competitive intelligence and is intended solely for the authorized recipient. Unauthorized reproduction or distribution is prohibited.</div>
        </div>
      </footer>
    </div>
  );
}
