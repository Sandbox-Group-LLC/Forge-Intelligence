import React from 'react';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={styles.section}>
    <h2 style={styles.sectionTitle}>{title}</h2>
    {children}
  </div>
);

const Sub = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={styles.sub}>
    <h3 style={styles.subTitle}>{title}</h3>
    {children}
  </div>
);

const P = ({ children }: { children: React.ReactNode }) => (
  <p style={styles.p}>{children}</p>
);

const UL = ({ items }: { items: (string | React.ReactNode)[] }) => (
  <ul style={styles.ul}>
    {items.map((item, i) => <li key={i} style={styles.li}>{item}</li>)}
  </ul>
);

export default function AcceptableUsePage() {
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
          <h1 style={styles.title}>Acceptable Use Policy</h1>
          <p style={styles.subtitle}>Effective: April 20, 2026 &nbsp;·&nbsp; Forge Intelligence LLC &nbsp;·&nbsp; Portland, OR</p>
        </div>

        <div style={styles.card}>

          <Section title="1. Overview">
            <P>This Acceptable Use Policy ("AUP") governs the use of the Forge Intelligence platform and all related services (the "Service"). This AUP is incorporated by reference into the Forge Intelligence <a href="/terms" style={styles.link}>Terms of Service</a> ("Terms"). Capitalized terms not defined in this AUP have the meanings set forth in the Terms.</P>
            <P>All Customers and their Authorized Users must comply with this AUP. Customer is responsible for ensuring that its Authorized Users are aware of and adhere to this AUP.</P>
            <P>Forge Intelligence reserves the right to update this AUP at any time. Material changes will be communicated to Customers at least thirty (30) days before they take effect.</P>
          </Section>

          <Section title="2. Permitted Use">
            <P>The Service is intended for lawful business purposes. Customers may use the Service to:</P>
            <UL items={[
              "Submit Brand URLs for which Customer has proper authorization to scan, analyze, and generate Brand Profiles.",
              "Generate AI-powered content (articles, emails, social media posts, and other formats) based on Brand Profiles for which Customer has proper authorization.",
              "Publish and distribute Generated Content through Connected Platforms that Customer has lawfully connected via OAuth or API integration, and for which Customer has publishing authority.",
              "Integrate the Service with Customer's authorized third-party tools and systems via supported APIs and connectors.",
              "Enable Authorized Users to access the Service in accordance with the Terms and this AUP.",
            ]} />
            <P>All use of the Service is subject to the Brand Authorization requirements set forth in Section 4 of the <a href="/terms" style={styles.link}>Terms of Service</a>.</P>
          </Section>

          <Section title="3. Prohibited Conduct">
            <P>You may not use the Service, or permit any third party to use the Service, in any manner that:</P>

            <Sub title="3.1 Illegal or Harmful Activity">
              <UL items={[
                "(a) Violates any applicable local, state, national, or international law or regulation.",
                "(b) Infringes, misappropriates, or violates the intellectual property, privacy, publicity, or other rights of any third party.",
                "(c) Promotes, facilitates, or enables fraud, deception, or misrepresentation.",
                "(d) Facilitates money laundering, terrorist financing, or sanctions evasion.",
                "(e) Involves the processing of data in violation of applicable data protection or privacy laws, including processing Personal Data without a valid legal basis.",
              ]} />
            </Sub>

            <Sub title="3.2 Harmful Content">
              <UL items={[
                "(a) Uploads, transmits, or stores content that is unlawful, defamatory, obscene, abusive, threatening, or harassing.",
                "(b) Distributes malware, viruses, worms, trojan horses, or any other malicious or destructive code.",
                "(c) Transmits unsolicited bulk communications (spam) through or using the Service.",
              ]} />
            </Sub>

            <Sub title="3.3 System Integrity">
              <UL items={[
                "(a) Attempts to probe, scan, test, or breach the security or authentication measures of the Service or any related system or network.",
                "(b) Interferes with, disrupts, or degrades the performance of the Service or the servers and networks connected to the Service.",
                "(c) Uses the Service to launch denial-of-service attacks or similar disruptive activities against any target.",
                "(d) Attempts to gain unauthorized access to any accounts, systems, or data not belonging to you.",
                "(e) Circumvents or attempts to circumvent any usage limits, rate limits, or access controls imposed by the Service.",
              ]} />
            </Sub>

            <Sub title="3.4 Abuse of the Platform">
              <UL items={[
                "(a) Uses the Service to build or train a competing product or service.",
                "(b) Scrapes, crawls, or uses automated means to access the Service for purposes not expressly permitted by the Terms.",
                "(c) Resells, redistributes, or sublicenses access to the Service without Forge Intelligence's prior written consent.",
                "(d) Benchmarks the Service for publication without Forge Intelligence's prior written consent.",
                "(e) Misrepresents your identity or affiliation when using the Service.",
                "(f) Creates multiple accounts to evade suspension, termination, or usage limits.",
              ]} />
            </Sub>

            <Sub title="3.5 Brand Abuse and Impersonation">
              <UL items={[
                <><strong style={styles.strong}>Brand Squatting.</strong> Submitting Brand URLs for the purpose of reserving, occupying, or blocking a Third-Party Brand's ability to use the Service, without a legitimate business relationship or authorization from the brand owner.</>,
                <><strong style={styles.strong}>Impersonation.</strong> Using the Service to impersonate a Third-Party Brand, or to create the false impression that Customer is the owner, employee, agent, or authorized representative of a Third-Party Brand when Customer is not.</>,
                <><strong style={styles.strong}>Unauthorized Brand Scanning.</strong> Submitting a Brand URL to generate a Brand Profile without proper authorization from the Third-Party Brand owner, in violation of Section 4 of the Terms of Service.</>,
                <><strong style={styles.strong}>Deceptive Content Generation.</strong> Using the Service to generate content that is intentionally misleading, deceptive, or designed to confuse consumers about the source, sponsorship, or affiliation of the content.</>,
                <><strong style={styles.strong}>Competitor Sabotage.</strong> Using the Service to generate or publish content on behalf of a Third-Party Brand with the intent to damage that brand's reputation, market position, or customer relationships.</>,
                <><strong style={styles.strong}>Credential Misuse.</strong> Using stolen, forged, or unauthorized OAuth tokens, API keys, or platform credentials to connect third-party publishing accounts that Customer does not have the right to access.</>,
                <><strong style={styles.strong}>False Authorization Claims.</strong> Providing false, fabricated, or misleading documentation when responding to a request for proof of authorization under Section 4.3 of the Terms of Service or during the Verification and Dispute Process under Section 5 of the Terms of Service.</>,
              ]} />
            </Sub>

            <Sub title="3.6 Data Misuse">
              <UL items={[
                "(a) Uploads or processes Personal Data without ensuring appropriate legal basis, consent, or authorization as required by applicable law.",
                "(b) Processes sensitive categories of Personal Data (e.g., health, biometric, financial, or children's data) through the Service unless expressly authorized under Customer's subscription and supported by appropriate safeguards.",
                "(c) Uses the Service to make automated decisions about individuals that produce legal or similarly significant effects without appropriate human oversight and safeguards.",
                "(d) Transfers Personal Data to or through the Service in violation of applicable cross-border data transfer requirements.",
                "(e) Retains or processes Personal Data beyond what is necessary for the stated purpose.",
              ]} />
            </Sub>
          </Section>

          <Section title="4. Usage Limits">
            <P>Customers must use the Service within the usage limits specified in their subscription plan and Order Form. This includes, but is not limited to:</P>
            <UL items={[
              "Number of Authorized Users.",
              "Data storage and processing volumes.",
              "API call volumes and rate limits.",
              "Number of integrations or connected systems.",
            ]} />
            <P>Forge Intelligence monitors usage for compliance with plan limits. If Customer consistently exceeds its plan limits, Forge Intelligence may require Customer to upgrade to an appropriate plan or reduce its usage.</P>
          </Section>

          <Section title="5. Security Obligations">
            <P>Customers are responsible for:</P>
            <UL items={[
              "(a) Maintaining the security of account credentials and access tokens.",
              "(b) Implementing appropriate access controls for Authorized Users, including role-based access where available.",
              "(c) Promptly revoking access for Authorized Users who no longer require it (e.g., upon termination of employment).",
              <>(d) Promptly notifying Forge Intelligence of any suspected or confirmed security incident involving the Service at <a href="mailto:security@forgeintelligence.ai" style={styles.link}>security@forgeintelligence.ai</a>.</>,
              "(e) Ensuring that integrations with third-party systems do not introduce security vulnerabilities.",
            ]} />
          </Section>

          <Section title="6. Monitoring and Enforcement">
            <Sub title="6.1 Monitoring">
              <P>Forge Intelligence may monitor use of the Service for compliance with this AUP. Such monitoring may include automated analysis of usage patterns but will not involve accessing the content of Customer Data except where necessary to investigate a reported or suspected violation.</P>
            </Sub>
            <Sub title="6.2 Reporting Violations">
              <P>If you become aware of any violation of this AUP, please report it to <a href="mailto:abuse@forgeintelligence.ai" style={styles.link}>abuse@forgeintelligence.ai</a>.</P>
            </Sub>
            <Sub title="6.3 Enforcement Actions">
              <P>If Forge Intelligence determines that a violation of this AUP has occurred, we may take one or more of the following actions, depending on the severity and nature of the violation:</P>
              <UL items={[
                <><strong style={styles.strong}>Warning:</strong> Notify Customer of the violation and request remediation.</>,
                <><strong style={styles.strong}>Restriction:</strong> Temporarily restrict access to specific features or functionality.</>,
                <><strong style={styles.strong}>Suspension:</strong> Suspend Customer's access to the Service until the violation is resolved.</>,
                <><strong style={styles.strong}>Termination:</strong> Terminate Customer's subscription in accordance with the Terms.</>,
                <><strong style={styles.strong}>Removal:</strong> Remove or disable access to content that violates this AUP.</>,
              ]} />
            </Sub>
            <Sub title="6.4 Process">
              <P>Except in cases where immediate action is necessary to prevent harm to the Service, other customers, or third parties, Forge Intelligence will:</P>
              <UL items={[
                "(a) Provide Customer with written notice of the alleged violation.",
                "(b) Allow Customer a reasonable opportunity (not less than five (5) business days) to respond and remediate the issue.",
                "(c) Consider Customer's response before taking enforcement action.",
              ]} />
              <P>In emergency situations involving imminent risk to the Service, data security, or legal compliance, Forge Intelligence may take immediate protective action and notify Customer as soon as reasonably practicable thereafter.</P>
            </Sub>
          </Section>

          <Section title="7. Consequences of Violation">
            <P>Violations of this AUP may result in:</P>
            <UL items={[
              "Suspension or termination of Customer's access to the Service.",
              "Liability for damages caused by the violation.",
              "Reporting to appropriate law enforcement or regulatory authorities where required by law or where the violation involves illegal activity.",
              "Forfeiture of prepaid fees in cases of termination for material breach.",
            ]} />
          </Section>

          <Section title="8. Reporting and Contact">
            <P>For questions about this AUP or to report a violation:</P>
            <UL items={[
              <><strong style={styles.strong}>General inquiries:</strong> <a href="mailto:legal@forgeintelligence.ai" style={styles.link}>legal@forgeintelligence.ai</a></>,
              <><strong style={styles.strong}>Abuse reports:</strong> <a href="mailto:abuse@forgeintelligence.ai" style={styles.link}>abuse@forgeintelligence.ai</a></>,
              <><strong style={styles.strong}>Security incidents:</strong> <a href="mailto:security@forgeintelligence.ai" style={styles.link}>security@forgeintelligence.ai</a></>,
            ]} />
          </Section>

          <div style={{ textAlign: 'center', paddingTop: 16, color: '#64748B', fontSize: 13 }}>
            <P>Forge Intelligence LLC &nbsp;·&nbsp; Portland, Oregon &nbsp;·&nbsp; <a href="mailto:hello@forgeintelligence.ai" style={styles.link}>hello@forgeintelligence.ai</a> &nbsp;·&nbsp; <a href="https://forgeintelligence.ai" style={styles.link}>forgeintelligence.ai</a></P>
          </div>

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
  sub: {
    marginBottom: 20,
  },
  subTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#CBD5E1',
    margin: '0 0 8px',
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
