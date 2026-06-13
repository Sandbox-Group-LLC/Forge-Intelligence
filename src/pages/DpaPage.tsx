import React from 'react';

// Public Data Processing Addendum (GDPR Art. 28). Shareable by URL with a
// customer's legal team; not in the app nav. Standard terms; an executed,
// counter-signed copy is available on request. The sub-processor list lives at
// /subprocessors (single source of truth) and is incorporated as Annex III.

const Section = ({ n, title, children }: { n: string; title: string; children: React.ReactNode }) => (
  <div style={styles.section}>
    <h2 style={styles.h2}>{n}. {title}</h2>
    {children}
  </div>
);
const P = ({ children }: { children: React.ReactNode }) => <p style={styles.p}>{children}</p>;
const UL = ({ items }: { items: React.ReactNode[] }) => <ul style={styles.ul}>{items.map((it, i) => <li key={i} style={styles.li}>{it}</li>)}</ul>;

export default function DpaPage() {
  return (
    <div style={styles.root}>
      <div style={styles.container}>
        <div style={styles.header}>
          <a href="/" style={styles.backLink}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            Back
          </a>
          <h1 style={styles.title}>Data Processing Addendum</h1>
          <p style={styles.subtitle}>Version 1.0 · 2026-06-13 &nbsp;·&nbsp; Forge Intelligence LLC &nbsp;·&nbsp; Portland, OR</p>
        </div>

        <div style={styles.banner}>
          This is Forge Intelligence's standard Data Processing Addendum (DPA), offered to customers who process personal data through the platform. To execute a counter-signed copy for your organization, contact <a href="mailto:legal@forgeintelligence.ai" style={styles.bannerLink}>legal@forgeintelligence.ai</a>. The current sub-processor list (Annex III) is maintained at <a href="/subprocessors" style={styles.bannerLink}>forgeintelligence.ai/subprocessors</a>.
        </div>

        <div style={styles.card}>
          <P>This Data Processing Addendum (&ldquo;DPA&rdquo;) forms part of the agreement between the customer (&ldquo;Customer&rdquo;) and Forge Intelligence LLC (&ldquo;Forge&rdquo;) for use of the Forge Intelligence platform (the &ldquo;Service&rdquo;) and reflects the parties&rsquo; agreement on the processing of personal data under the EU General Data Protection Regulation (GDPR), UK GDPR, and applicable US state privacy laws.</P>

          <Section n="1" title="Definitions">
            <P>&ldquo;Controller&rdquo;, &ldquo;Processor&rdquo;, &ldquo;Data Subject&rdquo;, &ldquo;Personal Data&rdquo;, &ldquo;Processing&rdquo;, and &ldquo;Personal Data Breach&rdquo; have the meanings given in the GDPR. &ldquo;Sub-processor&rdquo; means any processor engaged by Forge to process Customer Personal Data. &ldquo;Customer Personal Data&rdquo; means personal data Forge processes on Customer&rsquo;s behalf under the Service.</P>
          </Section>

          <Section n="2" title="Roles of the Parties">
            <P>For Customer Personal Data, Customer is the Controller and Forge is the Processor. Forge processes Customer Personal Data only to provide the Service and only on Customer&rsquo;s documented instructions, including as set out in this DPA and the agreement.</P>
          </Section>

          <Section n="3" title="Scope and Details of Processing">
            <P>The subject matter, duration, nature, and purpose of processing, the types of personal data, and categories of data subjects are described in <strong style={styles.strong}>Annex I</strong>.</P>
          </Section>

          <Section n="4" title="Processor Obligations">
            <UL items={[
              'Process Customer Personal Data only on Customer&rsquo;s documented instructions, unless required by law (in which case Forge will inform Customer unless legally prohibited).',
              'Ensure persons authorized to process Customer Personal Data are bound by confidentiality.',
              'Implement the technical and organizational measures set out in Annex II (Art. 32).',
              'Respect the sub-processor conditions in Section 6.',
              'Assist Customer, taking into account the nature of processing, in responding to data-subject-rights requests (Section 7) and in meeting its obligations under Arts. 32–36 (security, breach notification, DPIA).',
              'At Customer&rsquo;s election, delete or return Customer Personal Data at the end of the Service (Section 10).',
              'Make available information necessary to demonstrate compliance and allow for audits (Section 9).',
            ]} />
          </Section>

          <Section n="5" title="Security">
            <P>Forge maintains the technical and organizational measures described in <strong style={styles.strong}>Annex II</strong>, including encryption in transit, tenant isolation enforced at the authentication, ownership-verification, and database (Row Level Security) layers, and an access audit log.</P>
          </Section>

          <Section n="6" title="Sub-processors">
            <P>Customer provides a general authorization for Forge to engage the sub-processors listed at <a href="/subprocessors" style={styles.link}>forgeintelligence.ai/subprocessors</a> (incorporated as <strong style={styles.strong}>Annex III</strong>). Forge imposes data-protection obligations on each sub-processor no less protective than those in this DPA and remains responsible for their performance. Forge will update the list before engaging a new sub-processor and, on request, provide a mechanism for advance notice so Customer may object on reasonable data-protection grounds.</P>
          </Section>

          <Section n="7" title="Data Subject Rights">
            <P>Taking into account the nature of the processing, Forge assists Customer by appropriate technical and organizational measures, insofar as possible, in fulfilling Customer&rsquo;s obligation to respond to requests to exercise data-subject rights (access, rectification, erasure, restriction, portability, objection). Forge provides operator tooling to locate, export, and erase a data subject&rsquo;s personal data across the Service.</P>
          </Section>

          <Section n="8" title="Personal Data Breach">
            <P>Forge notifies Customer without undue delay after becoming aware of a Personal Data Breach affecting Customer Personal Data, and provides information reasonably available to assist Customer in meeting its breach-notification obligations.</P>
          </Section>

          <Section n="9" title="Audit">
            <P>Forge makes available information necessary to demonstrate compliance with this DPA and allows for and contributes to audits, including inspections, conducted by Customer or an auditor mandated by Customer, subject to reasonable confidentiality and frequency limits.</P>
          </Section>

          <Section n="10" title="Deletion or Return">
            <P>Upon termination of the Service, Forge will, at Customer&rsquo;s election, delete or return Customer Personal Data, and delete existing copies unless retention is required by law.</P>
          </Section>

          <Section n="11" title="International Transfers">
            <P>Where Forge processes Customer Personal Data originating in the EEA, UK, or Switzerland outside those territories, the parties rely on an appropriate transfer mechanism, including the Standard Contractual Clauses, which are incorporated by reference where applicable.</P>
          </Section>

          <Section n="12" title="Annexes">
            <UL items={[
              <><strong style={styles.strong}>Annex I — Details of Processing.</strong> Subject matter: provision of the Forge Intelligence content-intelligence platform. Duration: the term of the agreement. Nature/purpose: brand analysis, content generation, compliance review, publishing, and performance analytics. Categories of data subjects: Customer&rsquo;s personnel and authorized users; named authors/SMEs; reviewers; and individuals referenced in Customer-provided or publicly sourced brand material. Types of personal data: names, business email addresses, job titles, professional biographies, and professional profile links.</>,
              <><strong style={styles.strong}>Annex II — Technical and Organizational Measures.</strong> Encryption in transit (TLS); tenant isolation at three layers (authentication via JWT, per-request ownership verification, and database Row Level Security); least-privilege access; an access/audit log of privileged and data-access events; automated purge of orphaned data.</>,
              <><strong style={styles.strong}>Annex III — Sub-processors.</strong> The current list at <a href="/subprocessors" style={styles.link}>forgeintelligence.ai/subprocessors</a>.</>,
            ]} />
          </Section>

          <Section n="13" title="Contact">
            <P>Forge Intelligence LLC, Portland, Oregon, USA &nbsp;·&nbsp; <a href="mailto:legal@forgeintelligence.ai" style={styles.link}>legal@forgeintelligence.ai</a></P>
          </Section>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', backgroundColor: '#0B0F1A', color: '#F8FAFC', fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif", padding: '80px 24px' },
  container: { maxWidth: 800, margin: '0 auto', width: '100%' },
  header: { marginBottom: 24 },
  backLink: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#64748B', textDecoration: 'none', fontSize: 14, marginBottom: 32 },
  title: { fontSize: 36, fontWeight: 700, color: '#F8FAFC', margin: '0 0 8px', letterSpacing: '-0.5px' },
  subtitle: { fontSize: 13, color: '#64748B', margin: 0 },
  banner: { background: 'rgba(53,99,255,0.1)', border: '1px solid rgba(53,99,255,0.25)', borderRadius: 10, padding: '14px 18px', fontSize: 13, color: '#CBD5E1', lineHeight: 1.65, marginBottom: 24 },
  bannerLink: { color: '#3563FF', textDecoration: 'none' },
  card: { backgroundColor: '#1E293B', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', padding: '48px 52px' },
  section: { marginBottom: 28, paddingBottom: 28, borderBottom: '1px solid rgba(255,255,255,0.06)' },
  h2: { fontSize: 16, fontWeight: 600, color: '#F8FAFC', margin: '0 0 12px', letterSpacing: '-0.2px' },
  p: { fontSize: 15, color: '#94A3B8', lineHeight: 1.75, margin: '0 0 12px' },
  ul: { margin: '0 0 12px', paddingLeft: 20 },
  li: { fontSize: 15, color: '#94A3B8', lineHeight: 1.75, marginBottom: 8 },
  strong: { color: '#CBD5E1', fontWeight: 600 },
  link: { color: '#3563FF', textDecoration: 'none' },
};
