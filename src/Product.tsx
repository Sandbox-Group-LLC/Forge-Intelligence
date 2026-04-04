import { Link } from 'react-router-dom';

const DiamondIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 22 12 12 22 2 12" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const stages = [
  { num: 1, name: 'Context Hub', desc: 'Brand voice, personas, competitive gaps — extracted in minutes' },
  { num: 2, name: 'GEO Strategy', desc: 'AI citation opportunities across ChatGPT, Perplexity, Gemini' },
  { num: 3, name: 'Authenticity', desc: 'E-E-A-T signals, SME hooks, first-person experience injection' },
  { num: 4, name: 'Generation', desc: 'Brain-informed content with confidence scoring per section' },
  { num: 5, name: 'Compliance', desc: 'Human gate with auto-learning from every edit' },
  { num: 6, name: 'Publishing', desc: 'Multi-channel distribution with UTM intelligence' },
  { num: 7, name: 'Performance', desc: 'Analytics sync, decay monitoring, citation tracking' },
  { num: 8, name: 'Feedback Loop', desc: 'Patterns extracted, mistakes crystallized, brain compounds' },
];

const timeline = [
  { time: 'Day 1', state: 'Brain empty. Agents start from brand context only.' },
  { time: 'Week 4', state: '10–15 patterns. Agents prefer proven structures.' },
  { time: 'Month 3', state: '50+ patterns. Human edit rate drops 30%.' },
  { time: 'Month 6', state: 'Agents self-correct before human review.' },
  { time: 'Month 12', state: 'Brain is a proprietary asset. Switching means starting over.' },
];

export default function Product() {
  return (
    <div style={styles.root}>
      <div style={styles.gridOverlay} aria-hidden="true" />
      
      {/* Nav */}
      <nav style={styles.nav}>
        <Link to="/" style={styles.wordmark}>
          <span style={styles.diamondWrap}><DiamondIcon /></span>
          <span style={styles.wordmarkText}>Forge Intelligence</span>
        </Link>
        <Link to="/" style={styles.navCta}>
          Try It Free <ArrowRightIcon />
        </Link>
      </nav>

      <div style={styles.container}>
        
        {/* Hero */}
        <section style={styles.hero}>
          <p style={styles.eyebrow}>Content Intelligence Platform</p>
          <h1 style={styles.headline}>
            The only member of your content team who will tell you when the strategy is wrong.
          </h1>
          <p style={styles.subline}>
            Not opinion. Pattern recognition from your own data. No feelings, no politics, no 47-slide deck to justify it.
          </p>
        </section>

        {/* The Problem */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>The Gap Nobody's Filling</h2>
          <div style={styles.problemCard}>
            <p style={styles.problemText}>
              Every AI content tool today solves for <strong>production volume</strong>.
            </p>
            <p style={styles.problemText}>
              None solve for <strong style={{ color: '#3563FF' }}>compounding content intelligence</strong> — 
              where the system gets measurably smarter and more commercially effective with every publish cycle.
            </p>
            <p style={styles.problemPunch}>That's the gap. That's the product.</p>
          </div>
        </section>

        {/* 8-Stage Pipeline */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>The 8-Stage Pipeline</h2>
          <p style={styles.sectionSub}>From URL to revenue attribution in one connected system.</p>
          <div style={styles.stagesGrid}>
            {stages.map((s) => (
              <div key={s.num} style={styles.stageCard}>
                <div style={styles.stageNum}>{s.num}</div>
                <div>
                  <div style={styles.stageName}>{s.name}</div>
                  <div style={styles.stageDesc}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* The Brain */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>The Brain: Your Unfair Advantage</h2>
          <p style={styles.sectionSub}>
            Every publish teaches the system. Every edit sharpens the guardrails. Every pattern compounds.
          </p>
          <div style={styles.timelineWrap}>
            {timeline.map((t, i) => (
              <div key={t.time} style={styles.timelineItem}>
                <div style={styles.timelineDot} />
                {i < timeline.length - 1 && <div style={styles.timelineLine} />}
                <div style={styles.timelineContent}>
                  <div style={styles.timelineTime}>{t.time}</div>
                  <div style={styles.timelineState}>{t.state}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={styles.moatCard}>
            <p style={styles.moatText}>
              "After 90 days, your Client Brain is your biggest unfair advantage."
            </p>
          </div>
        </section>

        {/* For Who */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Built For</h2>
          <div style={styles.audienceGrid}>
            <div style={styles.audienceCard}>
              <div style={styles.audienceLabel}>SMB Marketing Teams</div>
              <p style={styles.audienceText}>
                See your brand understood better in 7 minutes than your last agency understood it in 3 months.
              </p>
              <div style={styles.audiencePrice}>$99 one-time</div>
            </div>
            <div style={styles.audienceCard}>
              <div style={styles.audienceLabel}>Agencies</div>
              <p style={styles.audienceText}>
                You run Forge for your clients the way we run Forge for ours. Every brand gets its own brain.
              </p>
              <div style={styles.audiencePrice}>$499/mo</div>
            </div>
          </div>
        </section>

        {/* What's Included */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>What You Get</h2>
          <div style={styles.featuresGrid}>
            {[
              'Brand Intelligence Profile',
              'GEO Strategy Brief',
              'E-E-A-T Enrichment',
              'AI Content Generation',
              'Compliance Gate',
              'Multi-Channel Publishing',
              'Performance Dashboard',
              'Pattern Learning',
              'Decay Monitoring',
              'Citation Tracking',
              'Campaign Analytics',
              'Unlimited Articles',
            ].map((f) => (
              <div key={f} style={styles.featureItem}>
                <span style={styles.checkIcon}><CheckIcon /></span>
                {f}
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section style={styles.ctaSection}>
          <h2 style={styles.ctaHeadline}>See your brand understood in 7 minutes.</h2>
          <p style={styles.ctaSub}>No account needed. Free analysis. Then decide.</p>
          <Link to="/" style={styles.ctaButton}>
            <span style={styles.buttonInner}>
              Analyze My Brand Free <ArrowRightIcon />
            </span>
          </Link>
        </section>

        {/* Footer */}
        <footer style={styles.footer}>
          <span>© 2026 Sandbox Group LLC</span>
          <span style={styles.footerDivider}>·</span>
          <a href="mailto:hello@forgeintelligence.ai" style={styles.footerLink}>hello@forgeintelligence.ai</a>
        </footer>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    backgroundColor: '#0B0F1A',
    backgroundImage: 'radial-gradient(circle at top left, rgba(53,99,255,0.15), transparent 55%), radial-gradient(circle at bottom right, rgba(20,184,166,0.08), transparent 55%)',
    color: '#F8FAFC',
    fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif",
    position: 'relative',
    overflow: 'hidden',
  },
  gridOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
    backgroundSize: '48px 48px',
    pointerEvents: 'none',
    zIndex: 0,
  },
  nav: {
    position: 'sticky',
    top: 0,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    backgroundColor: 'rgba(11,15,26,0.85)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    zIndex: 100,
  },
  wordmark: { display: 'flex', alignItems: 'center', gap: '10px', color: '#F8FAFC', textDecoration: 'none' },
  diamondWrap: { display: 'flex', alignItems: 'center', color: '#3563FF' },
  wordmarkText: { fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em' },
  navCta: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    backgroundColor: '#3563FF',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '13px',
    fontWeight: 500,
    textDecoration: 'none',
  },
  container: {
    position: 'relative',
    zIndex: 1,
    maxWidth: '900px',
    margin: '0 auto',
    padding: '64px 24px',
  },
  hero: {
    textAlign: 'center',
    marginBottom: '80px',
  },
  eyebrow: {
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#3563FF',
    marginBottom: '16px',
  },
  headline: {
    fontSize: 'clamp(28px, 5vw, 44px)',
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: '-0.025em',
    color: '#F8FAFC',
    margin: '0 0 20px 0',
    maxWidth: '800px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  subline: {
    fontSize: '17px',
    lineHeight: 1.7,
    color: '#94A3B8',
    maxWidth: '600px',
    margin: '0 auto',
  },
  section: {
    marginBottom: '80px',
  },
  sectionTitle: {
    fontSize: '24px',
    fontWeight: 600,
    color: '#F8FAFC',
    marginBottom: '12px',
    textAlign: 'center',
  },
  sectionSub: {
    fontSize: '15px',
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: '32px',
    maxWidth: '500px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  problemCard: {
    backgroundColor: '#1E293B',
    borderRadius: '12px',
    padding: '32px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  problemText: {
    fontSize: '17px',
    lineHeight: 1.7,
    color: '#CBD5E1',
    margin: '0 0 16px 0',
  },
  problemPunch: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#14B8A6',
    margin: 0,
  },
  stagesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '16px',
  },
  stageCard: {
    display: 'flex',
    gap: '16px',
    padding: '20px',
    backgroundColor: '#1E293B',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  stageNum: {
    width: '32px',
    height: '32px',
    borderRadius: '8px',
    backgroundColor: '#3563FF',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stageName: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#F8FAFC',
    marginBottom: '4px',
  },
  stageDesc: {
    fontSize: '13px',
    color: '#94A3B8',
    lineHeight: 1.5,
  },
  timelineWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    marginBottom: '32px',
  },
  timelineItem: {
    display: 'flex',
    gap: '20px',
    position: 'relative',
    paddingBottom: '24px',
  },
  timelineDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: '#3563FF',
    flexShrink: 0,
    marginTop: '4px',
    zIndex: 1,
  },
  timelineLine: {
    position: 'absolute',
    left: '5px',
    top: '16px',
    bottom: '0',
    width: '2px',
    backgroundColor: 'rgba(53,99,255,0.3)',
  },
  timelineContent: {
    flex: 1,
  },
  timelineTime: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#3563FF',
    marginBottom: '4px',
  },
  timelineState: {
    fontSize: '14px',
    color: '#CBD5E1',
    lineHeight: 1.5,
  },
  moatCard: {
    backgroundColor: 'rgba(53,99,255,0.1)',
    borderRadius: '10px',
    padding: '24px',
    border: '1px solid rgba(53,99,255,0.2)',
    textAlign: 'center',
  },
  moatText: {
    fontSize: '17px',
    fontWeight: 500,
    color: '#F8FAFC',
    fontStyle: 'italic',
    margin: 0,
  },
  audienceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: '20px',
  },
  audienceCard: {
    backgroundColor: '#1E293B',
    borderRadius: '12px',
    padding: '28px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  audienceLabel: {
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#14B8A6',
    marginBottom: '12px',
  },
  audienceText: {
    fontSize: '15px',
    lineHeight: 1.7,
    color: '#CBD5E1',
    margin: '0 0 16px 0',
  },
  audiencePrice: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#F8FAFC',
  },
  featuresGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '12px',
  },
  featureItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '14px',
    color: '#CBD5E1',
  },
  checkIcon: {
    color: '#14B8A6',
    display: 'flex',
  },
  ctaSection: {
    textAlign: 'center',
    padding: '48px 0',
  },
  ctaHeadline: {
    fontSize: '28px',
    fontWeight: 600,
    color: '#F8FAFC',
    marginBottom: '12px',
  },
  ctaSub: {
    fontSize: '15px',
    color: '#94A3B8',
    marginBottom: '24px',
  },
  ctaButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '14px 28px',
    backgroundColor: '#3563FF',
    borderRadius: '10px',
    color: '#fff',
    fontSize: '15px',
    fontWeight: 500,
    textDecoration: 'none',
  },
  buttonInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    gap: '12px',
    alignItems: 'center',
    fontSize: '12px',
    color: '#475569',
    paddingTop: '48px',
    borderTop: '1px solid rgba(255,255,255,0.05)',
  },
  footerDivider: { color: '#334155' },
  footerLink: { color: '#475569', textDecoration: 'none' },
};
