import React from 'react';

// Public TL;DR one-pager. A shareable, no-nav explainer for investors and
// prospects who asked "so what is this." Lives at /tldr, not in the app nav.
// Tone is deliberately human and plain. Mirrors the dark marketing style used
// by the legal pages (PrivacyPage / DpaPage / SubProcessorsPage).

const Eyebrow = () => (
  <span style={styles.eyebrow}>TL;DR</span>
);

const Card = ({ kicker, title, children }: { kicker?: string; title: string; children: React.ReactNode }) => (
  <div style={styles.card}>
    {kicker && <div style={styles.kicker}>{kicker}</div>}
    <h2 style={styles.h2}>{title}</h2>
    {children}
  </div>
);

const Step = ({ n, title, children }: { n: string; title: string; children: React.ReactNode }) => (
  <div style={styles.step}>
    <div style={styles.stepNum}>{n}</div>
    <div>
      <div style={styles.stepTitle}>{title}</div>
      <p style={styles.stepBody}>{children}</p>
    </div>
  </div>
);

export default function TldrPage() {
  return (
    <div style={styles.root}>
      <div style={styles.container}>

        {/* Hero */}
        <div style={styles.hero}>
          <Eyebrow />
          <h1 style={styles.title}>AI didn't kill content. It changed who's reading it.</h1>
          <p style={styles.lede}>
            Spoiler: it isn't people anymore. It's Perplexity, ChatGPT, Gemini, and Google's
            AI answers. They read everything and cite almost nothing. Forge is built to be
            the thing they cite.
          </p>
        </div>

        {/* The shift */}
        <Card kicker="The shift" title="For twenty years the game was rank on Google, get the click.">
          <p style={styles.p}>
            That game is ending. People ask an AI now, and the AI hands back an answer with
            three or four sources stapled to it. If you aren't one of those sources, you are
            not in the conversation. Volume used to win. Now volume is just noise the engines
            skip on their way to the answer.
          </p>
        </Card>

        {/* The catch */}
        <Card kicker="The catch (the part you nailed)" title="AI with no human behind it is slop. The engines learned to ignore slop.">
          <p style={styles.p}>
            What they cite is the opposite of slop. Real expertise, a real point of view, real
            authority. So the answer was never "more AI" or "no AI." It's a real human,
            amplified. A person stays at the center and the machine does the reach. That is the
            entire design, not a phase we grow out of.
          </p>
        </Card>

        {/* What Forge does */}
        <Card kicker="What Forge actually does" title="Four moves, in order.">
          <div style={styles.steps}>
            <Step n="1" title="Measures it.">
              We ask the engines, point blank, whether they cite you. Across Perplexity,
              ChatGPT, Gemini, and Google's AI Overviews. You get a number, not a vibe.
            </Step>
            <Step n="2" title="Finds the gaps.">
              Where you should be cited and aren't, the questions buyers actually ask, and what
              a competitor is saying that you simply never said.
            </Step>
            <Step n="3" title="Writes to win them.">
              Not blog filler. Content engineered around the exact questions the engines pull
              from, grounded in your own brand intelligence and your team's real expertise.
            </Step>
            <Step n="4" title="Keeps a human in charge.">
              Nothing publishes without a person signing off, and every piece discloses that
              it's AI assisted. We built that disclosure in before the EU required it, because
              it's also what keeps you citable.
            </Step>
          </div>
        </Card>

        {/* Why the human stays */}
        <Card kicker="Why the human stays" title="The loop isn't training wheels. It's the moat.">
          <p style={styles.p}>
            The human in the loop is not a stopgap we quietly remove next year. The engines
            reward real authority more every month, and regulators are pushing the same way.
            Betting on faceless automation is betting against both of those trends at once.
            We would rather build the version that's still standing in two years.
          </p>
        </Card>

        {/* CTA */}
        <div style={styles.ctaWrap}>
          <h2 style={styles.ctaTitle}>That's the TL;DR.</h2>
          <p style={styles.ctaSub}>
            The longer version is a 20 minute demo on a brand you already know. Or see it on
            your own brand first, no call required.
          </p>
          <div style={styles.ctaButtons}>
            <a href="/scan" style={styles.btnPrimary}>Scan your brand free</a>
            <a href="mailto:hello@forgeintelligence.ai?subject=Forge%20demo" style={styles.btnSecondary}>Book a look</a>
          </div>
        </div>

        <div style={styles.footer}>
          <a href="/" style={styles.footerLink}>forgeintelligence.ai</a>
          <span style={styles.footerDot}>·</span>
          <span>Forge Intelligence LLC</span>
          <span style={styles.footerDot}>·</span>
          <span>Portland, OR</span>
        </div>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', backgroundColor: '#0B0F1A', color: '#F8FAFC', fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif", padding: '72px 24px' },
  container: { maxWidth: 760, margin: '0 auto', width: '100%' },

  hero: { marginBottom: 36 },
  eyebrow: { display: 'inline-block', fontSize: 13, fontWeight: 700, letterSpacing: '2px', color: '#3563FF', background: 'rgba(53,99,255,0.1)', border: '1px solid rgba(53,99,255,0.25)', borderRadius: 999, padding: '5px 14px', marginBottom: 22 },
  title: { fontSize: 40, fontWeight: 700, color: '#F8FAFC', margin: '0 0 18px', letterSpacing: '-0.8px', lineHeight: 1.12 },
  lede: { fontSize: 18, color: '#94A3B8', lineHeight: 1.7, margin: 0 },

  card: { backgroundColor: '#1E293B', borderRadius: 14, border: '1px solid rgba(255,255,255,0.06)', padding: '28px 32px', marginBottom: 16 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase', color: '#3563FF', marginBottom: 10 },
  h2: { fontSize: 21, fontWeight: 700, color: '#F8FAFC', margin: '0 0 12px', letterSpacing: '-0.3px', lineHeight: 1.3 },
  p: { fontSize: 16, color: '#94A3B8', lineHeight: 1.75, margin: 0 },

  steps: { display: 'flex', flexDirection: 'column', gap: 18, marginTop: 4 },
  step: { display: 'flex', gap: 16, alignItems: 'flex-start' },
  stepNum: { flexShrink: 0, width: 30, height: 30, borderRadius: 'var(--radius-sm)', background: 'rgba(53,99,255,0.12)', border: '1px solid rgba(53,99,255,0.3)', color: '#3563FF', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  stepTitle: { fontSize: 16, fontWeight: 600, color: '#F8FAFC', marginBottom: 4 },
  stepBody: { fontSize: 15, color: '#94A3B8', lineHeight: 1.7, margin: 0 },

  ctaWrap: { textAlign: 'center', padding: '40px 24px 24px' },
  ctaTitle: { fontSize: 26, fontWeight: 700, color: '#F8FAFC', margin: '0 0 10px', letterSpacing: '-0.4px' },
  ctaSub: { fontSize: 16, color: '#94A3B8', lineHeight: 1.7, margin: '0 auto 24px', maxWidth: 520 },
  ctaButtons: { display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' },
  btnPrimary: { display: 'inline-block', background: '#3563FF', color: '#fff', fontSize: 15, fontWeight: 600, textDecoration: 'none', padding: '12px 24px', borderRadius: 'var(--radius-sm)'},
  btnSecondary: { display: 'inline-block', background: 'transparent', color: '#CBD5E1', fontSize: 15, fontWeight: 600, textDecoration: 'none', padding: '12px 24px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.14)' },

  footer: { textAlign: 'center', marginTop: 40, paddingTop: 24, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 13, color: '#64748B', display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' },
  footerLink: { color: '#3563FF', textDecoration: 'none' },
  footerDot: { color: '#334155' },
};
