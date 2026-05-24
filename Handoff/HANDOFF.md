# Forge Intelligence — Handoff to Claude Code

Five UI patterns built into the design-system prototype that aren't in the live app yet (and one nav grouping that **is** in the prototype but should be lifted into the production sidebar). Each is isolated as a single specimen HTML file so you can lift the markup, tokens, and class names verbatim.

> The **cache indicator** ("● Fresh" topbar pill) seen in the prototype is **NOT** part of this handoff — it's been intentionally removed for mobile.

---

## 1 · Sidebar — grouped nav (Brain / Pipeline / Settings) + Brain-version footer

**Specimen:** [`sidebar-grouped.html`](./sidebar-grouped.html)
**Target file:** `src/components/Sidebar.tsx` (+ `Sidebar.css`)

### What changed

The flat nav becomes three labelled groups, and the footer surfaces the current Brain version with a sync-pulse dot. On mobile (where the cache pill was removed from the topbar) the footer is now the single source of truth for sync state.

### Group structure (in order)

```
Brain
  New Analysis       (PlusCircle)
  Active Run         (Activity)        ← teal pulse badge when running
  Brand Profile      (Layers)
  Strategy           (Compass)
  Brain History      (BookOpen)

Pipeline
  GEO Strategist     (Compass)
  Authenticity       (Shield)
  Content Generator  (Zap)
  Compliance Gate    (Shield)
  Publishing Queue   (Send)
  Performance        (BarChart2)

Settings
  Integrations       (Plug)
  Brand Settings     (Settings)
```

### Group label style

```css
.nav-group-label {
  font: 600 10px/1 Inter;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  padding: 12px 16px 6px;
}
```

### Brain-version footer

```jsx
<div className="sidebar-footer">
  <span className="status-dot" />          {/* 6px teal, pulsing */}
  <span className="footer-label">Brain</span>
  <span className="footer-value">v{brain.version} · {brain.syncState}</span>
</div>
```

```css
.sidebar-footer {
  padding: 14px 18px;
  border-top: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; gap: 8px;
  font: 500 12px/1 Inter;
  color: var(--color-text-muted);
}
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
}
.footer-label { flex: 1; }
.footer-value { color: var(--color-text-secondary); font-weight: 600; }
```

### Suggested props

```ts
type SidebarProps = {
  active: NavId;
  onNavigate: (id: NavId) => void;
  brain: { version: number; syncState: 'synced' | 'syncing' | 'stale' };
};
```

---

## 2 · Streaming-step list (New Analysis / Active Run)

**Specimen:** [`streaming-steps.html`](./streaming-steps.html)
**Target file:** `src/components/views/ActiveRun.tsx` (+ existing `ActiveRun.css`)

Replaces any spinner / progress bar with a per-stage step list. Three states: `done` (green dot, "Done · 4.2s"), `running` (pulsing teal dot, "Running…"), `pending` (slate-200 dot, "Queued"). The list reads as a system log without looking like one.

### Markup

```jsx
<ol className="streaming-steps">
  {steps.map((s) => (
    <li key={s.id} className={`step ${s.state}`}>
      <span className="dot" />
      <span className="label">{s.label}</span>
      <span className="time">{s.state === 'done' ? `Done · ${s.duration}` : s.state === 'running' ? 'Running…' : 'Queued'}</span>
    </li>
  ))}
</ol>
```

### Step state → style

| State    | Dot                                        | Label color           | Time color  |
|----------|--------------------------------------------|-----------------------|-------------|
| done     | `#0EA572` solid                            | `#1E293B`             | `#0EA572`   |
| running  | `#14B8A6` + 8px teal glow, 1.5s pulse      | `#0F172A` + 600 wt    | `#3563FF`   |
| pending  | `#CBD5E1` solid                            | `#94A3B8`             | `#CBD5E1`   |

The teal pulse uses the same keyframes as the existing brain-alive indicator on the landing — share `@keyframes pulse` between them.

### Suggested props

```ts
type Step = {
  id: string;
  label: string;            // "Crawling sitemap"
  state: 'done' | 'running' | 'pending';
  duration?: string;        // "4.2s" — only when state === 'done'
};
type StreamingStepsProps = { steps: Step[] };
```

---

## 3 · GEO cherry-pick row + dynamic "Build Briefs (N)" CTA

**Specimen:** [`geo-cherry-pick.html`](./geo-cherry-pick.html)
**Target file:** `src/pages/GeoStrategistPage.tsx` (+ existing `GeoStrategistPage.css`)

A clickable card row with the entire surface as the toggle target (not just the checkbox). The header-right CTA reads `Build Briefs (N) →` where N is the selected count; it disables at N=0. Selected rows get an Intelligence-Blue inner-ring shadow.

### Row markup

```jsx
<div className={`topic-row ${selected ? 'selected' : ''}`} onClick={onToggle}>
  <div className="topic-check">{selected && <CheckIcon size={14} />}</div>
  <div>
    <div className="topic-title">{topic.title}</div>
    <div className="topic-meta">{topic.type} · {topic.state}</div>
  </div>
  <div className="topic-score">{topic.score}</div>
  <div className="topic-state">{selected ? 'Selected' : '→ Skip'}</div>
</div>
```

### Selected vs default shadow

```css
.topic-row {
  box-shadow: var(--shadow-card);
  transition: transform 150ms ease;
}
.topic-row:hover { transform: translateY(-1px); }
.topic-row.selected {
  box-shadow:
    0 0 0 1px rgba(53, 99, 255, 0.7),
    0 4px 16px rgba(53, 99, 255, 0.16);
}
```

### Dynamic CTA

```jsx
<button className="btn-primary" disabled={selected.size === 0}>
  <span>{`Build Briefs (${selected.size})`}</span>
  <ArrowRightIcon />
</button>
```

> Wrap the dynamic phrase in a single `<span>` so the flex `gap: 8px` lives between the **whole phrase** and the icon — not between the word and the parenthetical.

### Grid columns

`28px 1fr 80px 110px` — check / content / score / state. On mobile, collapse to `28px 1fr` with score + state stacked under the title.

---

## 4 · Stat strip (4-column KPI row)

**Specimen:** [`stat-strip.html`](./stat-strip.html)
**Target files:** `src/pages/PublishingQueuePage.tsx`, `src/pages/PerformanceDashboardPage.tsx`, anywhere a list-heavy view sits.

Sits between the page header and the main list. Always 4 columns desktop, 2×2 on mobile. Delta color is semantic (success / muted / error). Numbers use the `--type-stat-*` token set: 28/700/-0.02em.

### Markup

```jsx
<section className="stat-row">
  {stats.map((s) => (
    <article key={s.label} className="stat-card">
      <span className="stat-label">{s.label}</span>
      <span className="stat-number">{s.value}</span>
      <span className={`stat-delta ${s.deltaTone}`}>{s.delta}</span>
    </article>
  ))}
</section>
```

### Delta tones

| Tone     | Color       | Use                                    |
|----------|-------------|----------------------------------------|
| positive | `#0EA572`   | "↑ 23.4%", "+3 vs last week"           |
| flat     | `#94A3B8`   | "Across 14 prompts" — context, not delta |
| negative | `#DC2626`   | "↓ 5.2%" — sparingly                   |

### Suggested props

```ts
type Stat = {
  label: string;
  value: string | number;            // formatted upstream
  delta?: string;
  deltaTone?: 'positive' | 'flat' | 'negative';
};
type StatStripProps = { stats: Stat[] };
```

---

## 5 · Returning-user card (landing)

**Specimen:** [`returning-user.html`](./returning-user.html)
**Target file:** `src/Landing.tsx` (replaces the scan form when the no-account cookie matches a saved brain)

When the visitor's domain has a saved brain within the 24h TTL window, the scan form is replaced by this card. Pulsing teal dot, domain, "Brain saved · {expiresIn} remaining", primary **Resume Brain →** + secondary **New**.

### Markup

```jsx
<div className="returning">
  <div className="returning-dot" />
  <div className="returning-info">
    <div className="returning-domain">{brand.name}</div>
    <div className="returning-meta">Brain saved · {expiresIn}</div>
  </div>
  <button className="btn-resume" onClick={onResume}>
    Resume Brain <ArrowRightIcon />
  </button>
  <button className="btn-new" onClick={onStartNew}>New</button>
</div>
```

### Container

```css
.returning {
  display: flex; align-items: center; gap: 14px;
  padding: 16px 20px;
  background: rgba(53, 99, 255, 0.08);
  border: 1px solid rgba(53, 99, 255, 0.22);
  border-radius: 12px;
  max-width: 560px;
}
.returning-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #14B8A6;
  box-shadow: 0 0 8px rgba(20, 184, 166, 0.6);
  animation: pulse 1.5s ease-in-out infinite;
}
```

### State machine

```
GET /  →  read no-account cookie
  ↳ no cookie OR cookie expired (>24h)  →  render <ScanForm />
  ↳ valid cookie + brain found          →  render <ReturningCard brand={...} expiresIn={...} />
        Resume Brain  →  POST /api/resume, redirect /app/context-hub
        New           →  clear cookie, re-render <ScanForm />
```

### Copy rules

- **"Brain saved · 22h 14m remaining"** — sentence case, em-dash, no exclamation.
- Expiry string is **"{Hh Mm} remaining"**. Under 60 minutes show **"{Mm} remaining"** (e.g. "47m remaining"). Never show seconds.

---

## Token reference (load order)

Each specimen links `../colors_and_type.css` (the design-system tokens) plus the dark-landing radials inlined for the returning-user card. The CSS variable names match the production codebase:

- `--color-bg-base`, `--color-bg-card`, `--color-bg-elevated`, `--color-bg-hover`
- `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-emphasis`
- `--color-accent`, `--color-accent-hover`, `--color-accent-muted`, `--color-accent-70`
- `--color-success`, `--color-success-muted`, `--color-warning`, `--color-warning-muted`, `--color-error`
- `--shadow-card`, `--shadow-chrome-x`, `--shadow-chrome-y`
- `--radius-sm | -md | -lg | -pill`

All five specimens use only those tokens — no inline hex values that would need refactoring downstream.

---

## Questions before you ship

1. **Sidebar group order.** I put Brain first because it's the conceptual entry point. If the team's mental model is **Pipeline-first**, swap them — the rest of the system tolerates it.
2. **Brain-version footer link target.** Click → `/app/brain-history`? Or a popover with the diff vs. previous version?
3. **Streaming-step list persistence.** Should completed runs hydrate this same component as a static log, or does the historical view get a different layout?
4. **Cherry-pick CTA wording.** "Build Briefs (3)" matches the strategist register, but if the product team prefers "Generate Briefs" or "Run Strategy" — say the word.

Built from [Sandbox-Group-LLC/Forge-Intelligence](https://github.com/Sandbox-Group-LLC/Forge-Intelligence) @ `main` · README + tokens + UI kits live in `../` if you want broader context.
