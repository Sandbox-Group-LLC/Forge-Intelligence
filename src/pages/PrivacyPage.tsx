import React from 'react';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={styles.section}>
    <h2 style={styles.sectionTitle}>{title}</h2>
    {children}
  </div>
);

const P = ({ children }: { children: React.ReactNode }) => (
  <p style={styles.p}>{children}</p>
);

const UL = ({ items }: { items: string[] }) => (
  <ul style={styles.ul}>
    {items.map((item, i) => <li key={i} style={styles.li}>{item}</li>)}
  </ul>
);

export default function PrivacyPage() {
  return (
    <div style={styles.root}>
      <div style={styles.container}>

        <div style={styles.header}>
          <a href="/" style={styles.backLink}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </a>
          <h1 style={styles.title}>Privacy Policy</h1>
          <p style={styles.subtitle}>Effective: April 2026 &nbsp;·&nbsp; Sandbox Group LLC &nbsp;·&nbsp; Portland, OR</p>
        </div>

        <div style={styles.card}>

          <Section title="1. Who We Are">
            <P>Forge Intelligence is a B2B marketing intelligence platform operated by Sandbox Group LLC, a company based in Portland, Oregon. References to "Forge," "we," "us," or "our" throughout this policy mean Sandbox Group LLC. Our platform is available at forgeintelligence.ai.</P>
            <P>This policy explains what data we collect, why we collect it, how it is protected, and your rights regarding it. If you have questions, reach us at <a href="mailto:hello@forgeintelligence.ai" style={styles.link}>hello@forgeintelligence.ai</a>.</P>
          </Section>

          <Section title="2. What We Collect and Why">
            <P><strong style={styles.strong}>Account and identity data.</strong> When you sign in via Clerk — using Google, GitHub, or email and password — we receive your email address and a unique user identifier. This is used exclusively to authenticate you, scope your data to your account, and auto-provision your brand workspace. We do not receive your Google or GitHub password.</P>
            <P><strong style={styles.strong}>Brand and business data.</strong> You provide a domain URL to seed the platform. We use that URL to crawl publicly available signals — brand voice, tone, competitive positioning, and content patterns — and store the resulting intelligence in your isolated brand profile. Everything generated from your brand belongs to you.</P>
            <P><strong style={styles.strong}>Content and publishing data.</strong> Articles you generate, compliance edits you make, content you queue, schedule, or publish — including post copy, UTM parameters, and channel metadata — are stored in your brand workspace and used solely to operate the platform on your behalf.</P>
            <P><strong style={styles.strong}>Performance and analytics data.</strong> When you connect Google Search Console, LinkedIn, X, Facebook, Ghost, WordPress, or Webflow, we sync performance signals (impressions, clicks, engagement, read time) into your workspace. This data feeds the feedback loop that makes the platform smarter over time. We do not sell or share this data.</P>
            <P><strong style={styles.strong}>Brain data.</strong> Patterns extracted from your content performance, human compliance edits, and persona signals are stored in your brand brain — tables scoped exclusively to your brand profile ID. This is your proprietary intelligence asset. It is not shared with other accounts and is not used to train any AI model.</P>
            <P><strong style={styles.strong}>Payment data.</strong> Payments are processed by PayPal. We do not receive, store, or process your credit card or bank information. We record only that payment was confirmed and mark your account as active.</P>
            <P><strong style={styles.strong}>Usage data.</strong> We log agent activity — LLM calls, token counts, latency — for operational diagnostics and cost management. These logs are scoped to your account and are not used for advertising.</P>
          </Section>

          <Section title="3. Data We Do Not Collect">
            <UL items={[
              "We do not collect payment card numbers, bank account details, or billing addresses — PayPal handles all of this.",
              "We do not store raw OAuth tokens for LinkedIn, Facebook, HubSpot, or Webflow. Channel connections via Pipedream Connect store only a Pipedream account_id — the underlying tokens never touch our database.",
              "We do not build advertising profiles or sell data to data brokers.",
              "We do not use your content or brain data to train AI models.",
              "We do not share your data across accounts — even anonymized cross-client pattern sharing is off by default and requires explicit opt-in.",
            ]} />
          </Section>

          <Section title="4. How We Use Your Data">
            <UL items={[
              "To operate the 8-stage content intelligence pipeline on your behalf.",
              "To authenticate you and enforce brand-level data isolation across all API endpoints.",
              "To run scheduled jobs (pattern extraction, decay monitoring, GEO re-scoring) that keep your brain current.",
              "To send transactional emails via Resend — account confirmation, review notifications, performance digests. No marketing email without consent.",
              "To sync your user record to HubSpot for our own CRM — limited to your email and sign-in timestamp. No behavioral data.",
              "To generate AI-powered content using Anthropic Claude models. Your inputs are sent to Anthropic per their API terms. We do not enable training data sharing.",
              "To generate hero images using fal.ai Flux. Image prompts derived from your content are sent to fal.ai per their API terms.",
              "To shorten URLs via Bitly Pro for social publishing. Only the article URL and UTM string are sent — no account or user data.",
            ]} />
          </Section>

          <Section title="5. Data Isolation and Security">
            <P>Forge Intelligence is a multi-tenant platform. Every piece of data that touches your account is scoped to your brand profile ID and your Clerk user ID. We enforce this at three independent layers:</P>
            <UL items={[
              "Authentication — every API endpoint that serves or modifies brand data requires a valid Clerk JWT.",
              "Ownership verification — after authentication, every request that includes a brand profile ID verifies you own that brand via a database-level ownership check. A valid login is not enough — you must own the brand you are querying.",
              "Row Level Security — Neon enforces RLS with FORCE ROW LEVEL SECURITY on all sensitive tables: publishing queue, publishing channels, content analytics, brain patterns, brain mistakes, GEO briefs, GEO citations, decay alerts, pre-cog outcomes, topic ideas, reviewers, memories, and publish log. A policy at the database level prevents data from orphaned or unowned brands from being served, regardless of application-layer behavior.",
            ]} />
            <P>On every server boot, brain data belonging to brands with no associated user account is automatically purged. Your data can only be accessed by you.</P>
            <P>Infrastructure is hosted on Render. Our database runs on NeonDB with connection pooling. Code is stored in a private GitHub repository. All data is transmitted over TLS.</P>
          </Section>

          <Section title="6. Third-Party Services">
            <P>The following services process data as part of operating the platform. Each is governed by their own privacy policy.</P>
            <UL items={[
              "Clerk (clerk.com) — authentication, session management, user identity.",
              "NeonDB (neon.tech) — primary database, serverless Postgres with Row Level Security.",
              "Anthropic (anthropic.com) — LLM inference for all AI-powered stages. Claude Sonnet and Haiku models.",
              "fal.ai — hero image generation via Flux models.",
              "Resend (resend.com) — transactional email delivery.",
              "PayPal (paypal.com) — one-time payment processing at 9.",
              "Pipedream Connect (pipedream.com) — OAuth management for LinkedIn, Facebook, HubSpot, and Webflow. Raw tokens are never stored in our database.",
              "Bitly (bitly.com) — URL shortening for social post copy.",
              "Render (render.com) — application hosting and deployment.",
              "Google Search Console (Google LLC) — SEO performance data, synced on demand with your authorization.",
              "HubSpot (hubspot.com) — CRM sync on login. Email and sign-in timestamp only.",
              "EasyCron (easycron.com) — scheduled job triggers for pattern extraction, decay monitoring, and GEO refresh.",
            ]} />
          </Section>

          <Section title="7. Data Retention">
            <P>Your brand workspace — including your brain patterns, generated content, publishing history, and analytics — is retained for as long as your account is active. If you close your account, we will delete your brand data upon written request to <a href="mailto:hello@forgeintelligence.ai" style={styles.link}>hello@forgeintelligence.ai</a>.</P>
            <P>Agent activity logs are retained for 90 days for operational diagnostics and then purged.</P>
            <P>Orphaned brand data — profiles with no associated authenticated user — is purged automatically on every server restart.</P>
          </Section>

          <Section title="8. Your Rights">
            <P>Depending on where you are located, you may have the right to access, correct, export, or delete the personal data we hold about you. To exercise any of these rights, contact us at <a href="mailto:hello@forgeintelligence.ai" style={styles.link}>hello@forgeintelligence.ai</a>. We will respond within 30 days.</P>
            <P>If you are located in the European Economic Area or the United Kingdom, you have additional rights under GDPR and UK GDPR, including the right to lodge a complaint with your local supervisory authority. Our legal basis for processing your data is legitimate interests in operating the service and, where applicable, your consent.</P>
            <P>If you are a California resident, you have rights under the California Consumer Privacy Act (CCPA) including the right to know what personal information we collect, the right to delete it, and the right to opt out of sale. We do not sell personal information.</P>
          </Section>

          <Section title="9. Cookies and Local Storage">
            <P>We use browser localStorage to preserve your session state between visits — specifically your brand profile ID and, in limited cases, a temporary onboarding session token. We do not use third-party advertising cookies. Clerk may set authentication cookies governed by their own policy.</P>
          </Section>

          <Section title="10. Changes to This Policy">
            <P>We will update this policy as the platform evolves. Material changes will be communicated by updating the effective date above and, where appropriate, by email. Continued use of the platform after a change constitutes acceptance.</P>
          </Section>

          <Section title="11. Contact">
            <P>Sandbox Group LLC<br />Portland, Oregon, USA<br /><a href="mailto:hello@forgeintelligence.ai" style={styles.link}>hello@forgeintelligence.ai</a></P>
          </Section>

        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    backgroundColor: '#0B0F1A',
    color: '#F8FAFC',
    fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif",
    padding: '80px 24px',
  },
  container: {
    maxWidth: 760,
    margin: '0 auto',
    width: '100%',
  },
  header: {
    marginBottom: 48,
  },
  backLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: '#64748B',
    textDecoration: 'none',
    fontSize: 14,
    marginBottom: 32,
  },
  title: {
    fontSize: 36,
    fontWeight: 700,
    color: '#F8FAFC',
    margin: '0 0 8px',
    letterSpacing: '-0.5px',
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    margin: 0,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.06)',
    padding: '48px 52px',
  },
  section: {
    marginBottom: 40,
    paddingBottom: 40,
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: '#F8FAFC',
    margin: '0 0 16px',
    letterSpacing: '-0.2px',
  },
  p: {
    fontSize: 15,
    color: '#94A3B8',
    lineHeight: 1.75,
    margin: '0 0 12px',
  },
  ul: {
    margin: '0 0 12px',
    paddingLeft: 20,
  },
  li: {
    fontSize: 15,
    color: '#94A3B8',
    lineHeight: 1.75,
    marginBottom: 8,
  },
  strong: {
    color: '#CBD5E1',
    fontWeight: 600,
  },
  link: {
    color: '#3563FF',
    textDecoration: 'none',
  },
};
