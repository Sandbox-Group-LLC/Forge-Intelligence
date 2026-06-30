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

const proofPoints = [
  {
    date: 'May 7-8, 2026',
    title: 'Google AI Mode citation',
    body: 'Google AI Mode returned a definition of Forge Intelligence using Forge-coined vocabulary: context decay, Context Agent Architecture, context-first infrastructure. No paid placement. The output of a deliberate evidence chain Forge built and watched land through its own analytics.',
  },
  {
    date: 'May 24, 2026',
    title: '100% Google Ads optimization score',
    body: 'The Ads Generator’s first auto-built Search pack (headlines, descriptions, sitelinks, callouts, and match-typed keywords sourced from a single brain pass) hit a perfect 100% Google Ads optimization score on the Forge Intelligence account. Started at 99.9%, climbed to ceiling within hours of ad-rank scoring. No manual tuning.',
  },
];

const principles = [
  {
    title: 'Intelligence is upstream of generation.',
    body: 'AI content tools amplify whatever you feed them, including the absence of strategy. Without competitive intelligence, audience clarity, and a defensible positioning angle, generated content sounds exactly like every competitor’s generated content. Faster mediocrity isn’t a win.',
  },
  {
    title: 'Architecture beats volume.',
    body: 'A coherent evidence chain across the right surfaces produces AI citations and Quality Scores that no amount of volume can buy. Forge’s 8-stage pipeline is built to construct those chains, not just publish into them.',
  },
  {
    title: 'The brain is the product.',
    body: 'Every published article, every compliance edit, every analytics signal gets written back into a per-brand brain. Month 12, the brain is a proprietary asset. Switching means starting over.',
  },
];

export default function About() {
  return (
    <div style={styles.root}>
      <div style={styles.gridOverlay} aria-hidden="true" />

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
          <p style={styles.eyebrow}>About Forge Intelligence</p>
          <h1 style={styles.headline}>
            The intelligence layer behind modern marketing.
          </h1>
          <p style={styles.subline}>
            Forge Intelligence turns fragmented marketing activity into clear intelligence and confident action. It's a Context Agent Architecture built so every published asset makes the next one easier to brief, faster to write, and more likely to convert.
          </p>
        </section>

        {/* Why */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Why Forge exists</h2>
          <div style={styles.problemCard}>
            <p style={styles.problemText}>
              Every AI content tool on the market today solves for production volume. None solve for compounding content intelligence: the system getting measurably smarter and more commercially effective with every publish cycle. That’s the gap. That’s the product.
            </p>
            <p style={styles.problemPunch}>The bottleneck isn’t production. It’s intelligence.</p>
          </div>
        </section>

        {/* Principles */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>What we believe</h2>
          <p style={styles.sectionSub}>Three principles that shape every decision in the product.</p>
          <div style={styles.gapsGrid}>
            {principles.map(p => (
              <div key={p.title} style={styles.gapCard}>
                <div style={styles.gapTitle}>{p.title}</div>
                <p style={styles.gapOurs}>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Proof */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Forge is its own first case</h2>
          <p style={styles.sectionSub}>
            We run Forge on Forge. Two documented, dated outcomes from the system operating on its own brand.
          </p>
          <div style={styles.proofGrid}>
            {proofPoints.map(p => (
              <div key={p.title} style={styles.proofCard}>
                <div style={styles.proofDate}>{p.date}</div>
                <div style={styles.proofTitle}>{p.title}</div>
                <p style={styles.proofBody}>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Founder note */}
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>From the founder</h2>
          <div style={styles.founderCard}>
            <p style={styles.founderText}>
              I spent a decade running content operations for mid-market B2B brands and agencies. The same pattern showed up every time: teams could produce content faster than they could think strategically about it. The bottleneck was never volume. It was the layer that should have been telling the team what to write, who to write for, and what evidence to bring. No tool actually built that layer.
            </p>
            <p style={styles.founderText}>
              Forge is the layer I wanted to buy and couldn’t. An 8-stage agent architecture that reads the brand site, maps the competitive landscape, finds the topical gaps, injects E-E-A-T proof, writes voice-matched content, runs it past a compliance gate, distributes it across the right surfaces, syncs the analytics back, and writes every pattern into a brain that compounds. Same loop your best in-house team would run, except it never sleeps, never forgets, and gets smarter every cycle.
            </p>
            <p style={styles.founderSign}>Brian, founder</p>
          </div>
        </section>

        {/* CTA */}
        <section style={styles.ctaSection}>
          <h2 style={styles.ctaTitle}>See your brand through Forge.</h2>
          <p style={styles.ctaSub}>
            Drop your URL and get a free brand intelligence profile in about 60 seconds. No pitch call required.
          </p>
          <Link to="/" style={styles.ctaButton}>
            Try It Free <ArrowRightIcon />
          </Link>
        </section>
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
    zIndex: 10,
  },
  wordmark: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    color: '#F8FAFC',
    textDecoration: 'none',
  },
  diamondWrap: {
    color: '#3563FF',
    display: 'flex',
  },
  wordmarkText: {
    fontSize: '16px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
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
    margin: '0 auto 20px',
    maxWidth: '800px',
  },
  subline: {
    fontSize: '17px',
    lineHeight: 1.7,
    color: '#94A3B8',
    maxWidth: '640px',
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
    maxWidth: '560px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  problemCard: {
    backgroundColor: '#1E293B',
    borderRadius: '6px',
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
  gapsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: '20px',
  },
  gapCard: {
    backgroundColor: '#1E293B',
    borderRadius: '6px',
    padding: '24px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  gapTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#3563FF',
    marginBottom: '12px',
  },
  gapOurs: {
    fontSize: '14px',
    color: '#CBD5E1',
    margin: 0,
    lineHeight: 1.6,
  },
  proofGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: '20px',
  },
  proofCard: {
    backgroundColor: '#1E293B',
    borderRadius: '6px',
    padding: '24px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  proofDate: {
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: '#14B8A6',
    marginBottom: '8px',
  },
  proofTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#F8FAFC',
    marginBottom: '12px',
  },
  proofBody: {
    fontSize: '14px',
    color: '#CBD5E1',
    margin: 0,
    lineHeight: 1.6,
  },
  founderCard: {
    backgroundColor: '#1E293B',
    borderRadius: '6px',
    padding: '32px',
    border: '1px solid rgba(255,255,255,0.05)',
    maxWidth: '720px',
    margin: '0 auto',
  },
  founderText: {
    fontSize: '15px',
    lineHeight: 1.7,
    color: '#CBD5E1',
    margin: '0 0 16px 0',
  },
  founderSign: {
    fontSize: '14px',
    color: '#94A3B8',
    margin: '8px 0 0 0',
    fontStyle: 'italic',
  },
  ctaSection: {
    textAlign: 'center',
    padding: '48px 24px',
    backgroundColor: '#1E293B',
    borderRadius: '16px',
    border: '1px solid rgba(255,255,255,0.05)',
  },
  ctaTitle: {
    fontSize: 'clamp(22px, 4vw, 32px)',
    fontWeight: 600,
    color: '#F8FAFC',
    marginBottom: '12px',
  },
  ctaSub: {
    fontSize: '15px',
    color: '#94A3B8',
    marginBottom: '24px',
    maxWidth: '540px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  ctaButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 24px',
    backgroundColor: '#3563FF',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 500,
    textDecoration: 'none',
  },
};
