// StatStrip — 4-column KPI row that sits between a page header and the main
// list. Always 4 columns on desktop, 2x2 on mobile. Delta color is semantic:
// 'positive' (success green), 'flat' (muted slate — for context, not delta),
// 'negative' (alert red). Numbers use Inter 28/700/-0.02em.
//
// Drop-in usage:
//   <StatStrip stats={[
//     { label: 'In queue', value: 12, delta: '+3 vs last week', deltaTone: 'positive' },
//     { label: 'Published · 30d', value: 42, delta: '↑ 23.4%', deltaTone: 'positive' },
//     { label: 'GEO citations', value: '1.3k', delta: 'Across 14 prompts', deltaTone: 'flat' },
//     { label: 'Channels live', value: 8, delta: 'LinkedIn · X · Ghost…', deltaTone: 'flat' },
//   ]} />
//
// Pages can compute their stats from existing dashboard data — this component
// just renders. Source: Handoff/stat-strip.html.

export interface Stat {
  label: string;
  value: string | number;
  delta?: string;
  deltaTone?: 'positive' | 'flat' | 'negative';
}

export function StatStrip({ stats }: { stats: Stat[] }) {
  if (!stats.length) return null;
  return (
    <section className="stat-row" aria-label="Key metrics">
      {stats.map(s => (
        <article key={s.label} className="stat-card">
          <span className="stat-label">{s.label}</span>
          <span className="stat-number">{s.value}</span>
          {s.delta && (
            <span className={`stat-delta ${s.deltaTone || 'positive'}`}>{s.delta}</span>
          )}
        </article>
      ))}
      <style>{`
        .stat-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
          margin-bottom: 24px;
        }
        .stat-card {
          background: var(--color-bg-card, #fff);
          border-radius: 12px;
          box-shadow: 0 0 0 1px rgba(53, 99, 255, 0.07), 0 4px 16px rgba(53, 99, 255, 0.08);
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .stat-label {
          font: 600 11px/1 Inter, system-ui, sans-serif;
          color: var(--color-text-muted, #94A3B8);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .stat-number {
          font: 700 28px/1 Inter, system-ui, sans-serif;
          color: var(--color-text-emphasis, #0F172A);
          letter-spacing: -0.02em;
        }
        .stat-delta {
          font: 600 12px/1 Inter, system-ui, sans-serif;
          color: var(--color-success, #0EA572);
        }
        .stat-delta.flat {
          color: var(--color-text-muted, #94A3B8);
          font-weight: 500;
        }
        .stat-delta.negative {
          color: var(--color-error, #DC2626);
        }
        @media (max-width: 768px) {
          .stat-row {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>
    </section>
  );
}
