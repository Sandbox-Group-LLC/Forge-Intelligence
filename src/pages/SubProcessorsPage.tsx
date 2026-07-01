import React from 'react';
import { subProcessors, customerDirectedRecipients, SUBPROCESSORS_UPDATED, type SubProcessor } from '../data/subprocessors';

// Public sub-processor list (GDPR Art. 28). Shareable by URL with a customer's
// legal/procurement team; not in the app nav. Mirrors the PrivacyPage layout.
// Single source of truth: src/data/subprocessors.ts.

const Table = ({ rows }: { rows: SubProcessor[] }) => (
  <div style={styles.tableWrap}>
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Sub-processor</th>
          <th style={styles.th}>Purpose</th>
          <th style={styles.th}>Data categories</th>
          <th style={styles.th}>Region</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.name}>
            <td style={styles.td}><strong style={styles.strong}>{r.name}</strong><br /><span style={styles.url}>{r.url}</span></td>
            <td style={styles.td}>{r.purpose}</td>
            <td style={styles.td}>{r.dataCategories}</td>
            <td style={styles.td}>{r.region}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function SubProcessorsPage() {
  return (
    <div style={styles.root}>
      <div style={styles.container}>
        <div style={styles.header}>
          <a href="/" style={styles.backLink}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            Back
          </a>
          <h1 style={styles.title}>Sub-processors</h1>
          <p style={styles.subtitle}>Last updated: {SUBPROCESSORS_UPDATED} &nbsp;·&nbsp; Forge Intelligence LLC &nbsp;·&nbsp; Portland, OR</p>
        </div>

        <div style={styles.card}>
          <p style={styles.p}>This page lists the third-party sub-processors Forge Intelligence LLC engages to provide the platform, and the customer-directed integrations that may receive data at a customer's instruction. It is referenced by our <a href="/privacy" style={styles.link}>Privacy Policy</a> and forms an Annex to our <a href="/dpa" style={styles.link}>Data Processing Addendum</a>. Each sub-processor is bound by its own data-protection terms.</p>
          <p style={styles.p}>We will update this page before engaging a new sub-processor that processes customer personal data. Customers under an executed DPA may request advance notice of changes by contacting <a href="mailto:legal@forgeintelligence.ai" style={styles.link}>legal@forgeintelligence.ai</a>.</p>

          <h2 style={styles.h2}>Sub-processors</h2>
          <p style={styles.note}>Engaged by Forge to deliver the core service.</p>
          <Table rows={subProcessors} />

          <h2 style={styles.h2}>Customer-directed integrations</h2>
          <p style={styles.note}>Connected by the customer; data flows to these services at the customer's instruction. They are onward recipients the customer selects, not sub-processors Forge engages.</p>
          <Table rows={customerDirectedRecipients} />

          <h2 style={styles.h2}>International transfers</h2>
          <p style={styles.p}>Forge is operated from the United States and most sub-processors process data in the United States. Where customer personal data originating in the EEA or UK is transferred, it is done under appropriate safeguards (e.g. Standard Contractual Clauses) as described in our Data Processing Addendum.</p>

          <h2 style={styles.h2}>Contact</h2>
          <p style={styles.p}>Forge Intelligence LLC, Portland, Oregon, USA &nbsp;·&nbsp; <a href="mailto:legal@forgeintelligence.ai" style={styles.link}>legal@forgeintelligence.ai</a></p>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', backgroundColor: '#0B0F1A', color: '#F8FAFC', fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif", padding: '80px 24px' },
  container: { maxWidth: 920, margin: '0 auto', width: '100%' },
  header: { marginBottom: 48 },
  backLink: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#64748B', textDecoration: 'none', fontSize: 14, marginBottom: 32 },
  title: { fontSize: 36, fontWeight: 700, color: '#F8FAFC', margin: '0 0 8px', letterSpacing: '-0.5px' },
  subtitle: { fontSize: 13, color: '#64748B', margin: 0 },
  card: { backgroundColor: '#1E293B', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.06)', padding: '48px 52px' },
  p: { fontSize: 15, color: '#94A3B8', lineHeight: 1.75, margin: '0 0 12px' },
  note: { fontSize: 13, color: '#64748B', fontStyle: 'italic', margin: '0 0 12px' },
  h2: { fontSize: 18, fontWeight: 600, color: '#F8FAFC', margin: '36px 0 8px' },
  tableWrap: { overflowX: 'auto', margin: '0 0 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid rgba(255,255,255,0.12)', color: '#CBD5E1', fontWeight: 600, whiteSpace: 'nowrap' },
  td: { padding: '10px', borderBottom: '1px solid rgba(255,255,255,0.06)', color: '#94A3B8', verticalAlign: 'top', lineHeight: 1.6 },
  strong: { color: '#F8FAFC', fontWeight: 600 },
  url: { color: '#64748B', fontSize: 12 },
  link: { color: '#3563FF', textDecoration: 'none' },
};
