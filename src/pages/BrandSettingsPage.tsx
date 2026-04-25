import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import { NoBrandEmpty } from '../components/NoBrandEmpty';
import './BrandSettingsPage.css';

interface BrandSettings {
  id: string;
  brand_name: string;
  brand_url: string;
  article_base_url: string;
  article_url_suffix: string;
  logo_url: string;
  is_paid: boolean;
  created_at: string;
  digest_unsubscribed: boolean;
  settings: Record<string, any>;
}

interface FactualGroundAuthor {
  id: string;
  name: string;
  title: string;
  linkedinUrl: string;
  bio: string;
  credentials: string;
  expertise: string;
}

interface FactualGround {
  companyFacts: string;
  whatWeDo: string;
  whatWeDontDo: string;
  methodology: string;
  foundingStory: string;
  teamComposition: string;
  authors: FactualGroundAuthor[];
  quotablePositions: string;
  competitors: string;
}

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
  </svg>
);

const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

export default function BrandSettingsPage() {
  const { activeBrand } = useApp();
  const { getToken } = useAuth();
  const selected = activeBrand?.id || (() => { try { return localStorage.getItem('forge_active_brand_id'); } catch(e) { return ''; } })() || new URLSearchParams(window.location.search).get('brand') || '';

  const [form, setForm] = useState<Partial<BrandSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Reviewers
  interface Reviewer { id: string; name: string; email: string; title: string; }
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [revName, setRevName] = useState('');
  const [revEmail, setRevEmail] = useState('');
  const [revTitle, setRevTitle] = useState('');
  const [revSaving, setRevSaving] = useState(false);
  const [revError, setRevError] = useState('');

  const [scraping, setScraping] = useState(false);
  const [scrapeSuccess, setScrapeSuccess] = useState(false);
  const [scrapeError, setScrapeError] = useState('');
  const [articleTemplateUrl, setArticleTemplateUrl] = useState('');
  const [catalogTemplateUrl, setCatalogTemplateUrl] = useState('');

  const [voiceAttrs, setVoiceAttrs] = useState<{attribute: string; score: number; description: string}[]>([]);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceSaved, setVoiceSaved] = useState(false);

  const [digestOptOut, setDigestOptOut] = useState(false);
  const [digestSaving, setDigestSaving] = useState(false);

  // Scrape URL override — for masked subdomains / vanity domains pointing to a different origin
  const [scrapeUrlOverride, setScrapeUrlOverride] = useState('');

  // Factual Ground — direct user input to anchor writer claims
  const [factualGround, setFactualGround] = useState<FactualGround>({
    companyFacts: '',
    whatWeDo: '',
    whatWeDontDo: '',
    methodology: '',
    foundingStory: '',
    teamComposition: '',
    authors: [],
    quotablePositions: '',
    competitors: '',
  });
  const [fgSaving, setFgSaving] = useState(false);
  const [fgSaved, setFgSaved] = useState(false);
  // Persistent banner shown after save — prompts user to re-run analysis so Forge
  // can incorporate the new Factual Ground into the Brain. Dismissible.
  const [fgSavedBanner, setFgSavedBanner] = useState(false);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/brand-settings/${selected}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setForm(d.settings);
          setDigestOptOut(!!d.settings?.digest_unsubscribed);
          setScrapeUrlOverride(d.settings?.settings?.scrapeUrlOverride || '');
          if (d.settings?.settings?.factualGround) {
            // Normalize competitors into a textarea-friendly string. Field may be saved as:
            //   - string (newline- or comma-separated, current preferred shape)
            //   - string[] (legacy)
            //   - {name, url}[] (from an earlier experiment)
            let competitorsStr = '';
            const rawComps = d.settings.settings.factualGround.competitors;
            if (typeof rawComps === 'string') {
              competitorsStr = rawComps;
            } else if (Array.isArray(rawComps)) {
              competitorsStr = rawComps.map((c: any) => {
                if (typeof c === 'string') return c;
                if (c && typeof c === 'object') return c.url || c.name || '';
                return '';
              }).filter(Boolean).join('\n');
            }
            setFactualGround({
              companyFacts: d.settings.settings.factualGround.companyFacts || '',
              whatWeDo: d.settings.settings.factualGround.whatWeDo || '',
              whatWeDontDo: d.settings.settings.factualGround.whatWeDontDo || '',
              methodology: d.settings.settings.factualGround.methodology || '',
              foundingStory: d.settings.settings.factualGround.foundingStory || '',
              teamComposition: d.settings.settings.factualGround.teamComposition || '',
              authors: d.settings.settings.factualGround.authors || [],
              quotablePositions: d.settings.settings.factualGround.quotablePositions || '',
              competitors: competitorsStr,
            });
          }
        }
      });
    getToken().then(token => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`/api/brand-settings/${selected}/voice`, { headers })
        .then(r => r.json())
        .then(d => { if (d.success && d.toneAttributes?.length) setVoiceAttrs(d.toneAttributes); })
        .catch(() => {});
    });
  }, [selected, activeBrand?.id]);

  // Load reviewers for active brand
  useEffect(() => {
    if (!selected) return;
    fetch(`/api/reviewers/${selected}`).then(r => r.json()).then(d => {
      if (d.success) setReviewers(d.reviewers || []);
    }).catch(() => {});
  }, [selected]);

  // Scroll to hash target (e.g. #factual-ground) once page has rendered.
  // Browser doesn't auto-scroll on client-side navigation; we polyfill that.
  useEffect(() => {
    const hash = window.location.hash?.slice(1);
    if (!hash) return;
    // Small delay so section DOM is present (Factual Ground renders conditionally on load)
    const t = setTimeout(() => {
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Brief highlight pulse so users see where they landed
        el.style.transition = 'box-shadow 0.4s ease';
        el.style.boxShadow = '0 0 0 3px rgba(20, 184, 166, 0.35)';
        setTimeout(() => { el.style.boxShadow = ''; }, 2000);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [selected]);

  const addReviewer = async () => {
    if (!revName.trim() || !revEmail.trim()) { setRevError('Name and email required'); return; }
    setRevSaving(true); setRevError('');
    try {
      const r = await fetch('/api/reviewers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandProfileId: selected, name: revName.trim(), email: revEmail.trim(), title: revTitle.trim() })
      });
      const d = await r.json();
      if (d.success) { setReviewers(prev => [...prev, d.reviewer]); setRevName(''); setRevEmail(''); setRevTitle(''); }
      else { setRevError(d.error || 'Failed to add reviewer'); }
    } catch { setRevError('Failed to add reviewer'); }
    setRevSaving(false);
  };

  const removeReviewer = async (id: string) => {
    await fetch(`/api/reviewers/${id}`, { method: 'DELETE' });
    setReviewers(prev => prev.filter(r => r.id !== id));
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true); setError('');
    try {
      const r = await fetch(`/api/brand-settings/${selected}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandName: form.brand_name,
          articleBaseUrl: form.article_base_url,
          articleUrlSuffix: form.article_url_suffix,
          logoUrl: form.logo_url,
          settings: { scrapeUrlOverride: scrapeUrlOverride.trim() || null }
        })
      });
      const d = await r.json();
      if (d.success) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
      else setError(d.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const saveFactualGround = async () => {
    if (!selected) return;
    setFgSaving(true);
    try {
      const r = await fetch(`/api/brand-settings/${selected}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { factualGround } })
      });
      const d = await r.json();
      if (d.success) {
        setFgSaved(true);
        setTimeout(() => setFgSaved(false), 3000);
        // Persistent post-save banner — prompts a rescan since Factual Ground is only applied on next analysis
        setFgSavedBanner(true);
      }
    } finally { setFgSaving(false); }
  };

  const [csvImportMsg, setCsvImportMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const addAuthor = () => {
    setFactualGround(prev => ({
      ...prev,
      authors: [...prev.authors, {
        id: `author-${Date.now()}`, name: '', title: '', linkedinUrl: '',
        bio: '', credentials: '', expertise: ''
      }]
    }));
  };

  // Bulk CSV import for enterprise rosters. Parses one row per author, dedupes
  // against existing authors by case-insensitive name match (so re-importing
  // an updated CSV updates fields rather than creating duplicates), and merges
  // into the current author list. Uses native CSV parsing — no library —
  // because the format is constrained and we don't ship Papa here.
  const handleAuthorCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset input so the same file can be re-imported
    if (!file) return;
    setCsvImportMsg({ kind: 'info', text: 'Parsing CSV…' });
    try {
      const text = await file.text();
      // Parse CSV: handle quoted fields, escaped quotes, commas inside quotes.
      const parseCsv = (raw: string): string[][] => {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = '';
        let inQuotes = false;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          if (inQuotes) {
            if (ch === '"') {
              if (raw[i + 1] === '"') { field += '"'; i++; } // escaped quote
              else inQuotes = false;
            } else { field += ch; }
          } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n' || ch === '\r') {
              if (field !== '' || row.length > 0) { row.push(field); rows.push(row); row = []; field = ''; }
              if (ch === '\r' && raw[i + 1] === '\n') i++;
            } else { field += ch; }
          }
        }
        if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
        return rows.filter(r => r.some(c => c && c.trim()));
      };
      const rows = parseCsv(text);
      if (rows.length < 2) {
        setCsvImportMsg({ kind: 'error', text: 'CSV needs at least a header row + 1 data row.' });
        return;
      }
      // Header parse — case-insensitive, accepts variants
      const headers = rows[0].map(h => h.trim().toLowerCase());
      const colIdx: Record<string, number> = {};
      const headerMap: Record<string, string[]> = {
        name: ['name', 'full name', 'fullname'],
        title: ['title', 'job title', 'role'],
        linkedinUrl: ['linkedinurl', 'linkedin url', 'linkedin', 'linkedin_url'],
        bio: ['bio', 'biography', 'about'],
        credentials: ['credentials', 'creds', 'background'],
        expertise: ['expertise', 'areas of expertise', 'expertise areas', 'topics']
      };
      for (const [key, aliases] of Object.entries(headerMap)) {
        const idx = headers.findIndex(h => aliases.includes(h));
        if (idx >= 0) colIdx[key] = idx;
      }
      if (colIdx.name === undefined) {
        setCsvImportMsg({ kind: 'error', text: 'CSV must have a "name" column. Found: ' + headers.join(', ') });
        return;
      }
      // Build new author records
      const incoming = rows.slice(1).map(r => ({
        name: ((r[colIdx.name] || '') as string).trim(),
        title: ((colIdx.title !== undefined ? r[colIdx.title] : '') || '').trim(),
        linkedinUrl: ((colIdx.linkedinUrl !== undefined ? r[colIdx.linkedinUrl] : '') || '').trim(),
        bio: ((colIdx.bio !== undefined ? r[colIdx.bio] : '') || '').trim(),
        credentials: ((colIdx.credentials !== undefined ? r[colIdx.credentials] : '') || '').trim(),
        expertise: ((colIdx.expertise !== undefined ? r[colIdx.expertise] : '') || '').trim(),
      })).filter(a => a.name); // skip rows with no name
      if (!incoming.length) {
        setCsvImportMsg({ kind: 'error', text: 'No valid rows found (every row needs a name).' });
        return;
      }
      // Merge: existing authors with matching name (case-insensitive) get updated;
      // new names get appended.
      setFactualGround(prev => {
        const next = [...prev.authors];
        let added = 0;
        let updated = 0;
        for (const inc of incoming) {
          const lcName = inc.name.toLowerCase();
          const existingIdx = next.findIndex(a => (a.name || '').toLowerCase() === lcName);
          if (existingIdx >= 0) {
            // Merge — only overwrite if the incoming value is non-empty
            next[existingIdx] = {
              ...next[existingIdx],
              ...Object.fromEntries(Object.entries(inc).filter(([_, v]) => v))
            };
            updated++;
          } else {
            next.push({
              id: `author-${Date.now()}-${added}`,
              ...inc,
            });
            added++;
          }
        }
        const parts: string[] = [];
        if (added) parts.push(`${added} added`);
        if (updated) parts.push(`${updated} updated`);
        setCsvImportMsg({ kind: 'success', text: `Imported ${incoming.length} rows: ${parts.join(', ')}. Click Save to persist.` });
        return { ...prev, authors: next };
      });
    } catch (err: any) {
      setCsvImportMsg({ kind: 'error', text: 'Import failed: ' + (err?.message || 'unknown error') });
    }
  };

  const updateAuthor = (id: string, field: keyof FactualGroundAuthor, value: string) => {
    setFactualGround(prev => ({
      ...prev,
      authors: prev.authors.map(a => a.id === id ? { ...a, [field]: value } : a)
    }));
  };

  const removeAuthor = (id: string) => {
    setFactualGround(prev => ({ ...prev, authors: prev.authors.filter(a => a.id !== id) }));
  };

  const handleScrape = async () => {
    if (!selected || !articleTemplateUrl) return;
    setScraping(true); setScrapeError(''); setScrapeSuccess(false);
    try {
      const r = await fetch(`/api/brand-settings/${selected}/scrape-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleUrl: articleTemplateUrl, catalogUrl: catalogTemplateUrl || undefined })
      });
      const d = await r.json();
      if (d.success) { setScrapeSuccess(true); setTimeout(() => setScrapeSuccess(false), 4000); }
      else setScrapeError(d.error || 'Scrape failed');
    } catch { setScrapeError('Network error — check the URLs and try again'); }
    finally { setScraping(false); }
  };

  const handleVoiceSave = async () => {
    if (!selected || !voiceAttrs.length) return;
    setVoiceSaving(true);
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`/api/brand-settings/${selected}/voice`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ toneAdjustments: voiceAttrs.map(a => ({ attribute: a.attribute, score: a.score })) })
    }).catch(() => null);
    const d = r ? await r.json() : null;
    if (d?.success) { setVoiceSaved(true); setTimeout(() => setVoiceSaved(false), 3000); }
    setVoiceSaving(false);
  };

  const handleDigestToggle = async (optOut: boolean) => {
    if (!selected) return;
    setDigestSaving(true);
    const token = await getToken();
    await fetch('/api/digest/preference', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ brandProfileId: selected, unsubscribed: optOut })
    }).catch(() => {});
    setDigestOptOut(optOut);
    setDigestSaving(false);
  };

  const set = (key: keyof BrandSettings, val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const activatedDate = form.created_at
    ? new Date(form.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  if (!activeBrand) {
    return (
      <AppShell pageTitle="Brand Settings">
        <NoBrandEmpty
          pageName="Brand Settings"
          pageDescription="Fine-tune your brand voice, configure publishing destinations, and set reviewer permissions."
          features={[
            'Set your brand tone, style, and forbidden phrases',
            'Connect publishing destinations (LinkedIn, X, your CMS)',
            'Add team members as reviewers with comment-only access',
            'Configure UTM tagging and tracking parameters',
          ]}
        />
      </AppShell>
    );
  }

  return (
    <AppShell pageTitle="Brand Settings">
      <div className="bs-page">
        <div className="geo-header">
          <div>
            <div className="geo-eyebrow">Settings</div>
            <h1 className="geo-title">Brand Settings</h1>
            <p className="geo-description">Configure publishing preferences, custom domain, and identity for each brand.</p>
          </div>
        </div>

        {!selected ? (
          <div className="bs-empty">No brands found. Run a Brain analysis first to create a brand profile.</div>
        ) : (
          <div className="bs-layout">
            <div className="bs-content">

              {/* Save bar */}
              <div className="bs-save-bar">
                {error && <span className="bs-error">{error}</span>}
                {saved && <span className="bs-saved">✓ Saved</span>}
                <button className="bs-save-btn" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>

              {/* ── Factual Ground — user-provided credentials and facts that anchor the writer ── */}
              <section id="factual-ground" className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 6v16"/><path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/><path d="M9 11h6"/><circle cx="12" cy="4" r="2"/></svg>
                    Factual Ground
                  </h2>
                  <p className="bs-section-sub">
                    Structured facts the writer must use verbatim. This is your direct line to the brain — what gets written here shows up <strong>word-for-word</strong> in generated content. Anchor the writer with real credentials, real claims, real positions.
                  </p>
                </div>

                {fgSavedBanner && (
                  <div className="bs-fg-rescan-banner">
                    <div className="bs-fg-rescan-copy">
                      <strong>Factual Ground saved.</strong> Your corrections only apply on the next analysis. Run a new scan so Forge can rebuild the Brain with your updated facts.
                    </div>
                    <div className="bs-fg-rescan-actions">
                      <button
                        className="bs-fg-rescan-primary"
                        onClick={() => { window.location.href = '/app/context-hub'; }}
                      >
                        Run new analysis
                      </button>
                      <button
                        className="bs-fg-rescan-dismiss"
                        onClick={() => setFgSavedBanner(false)}
                        title="Dismiss"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}

                <div className="bs-save-bar">
                  {fgSaved && <span className="bs-saved">✓ Saved</span>}
                  <button className="bs-save-btn" onClick={saveFactualGround} disabled={fgSaving}>
                    {fgSaving ? 'Saving...' : 'Save Factual Ground'}
                  </button>
                </div>

                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">What we actually do</label>
                    <p className="bs-field-hint">The concrete, factual version of your value prop. No marketing fluff. Example: "Forge extracts competitive intelligence from brand websites using an 8-stage AI pipeline."</p>
                    <textarea
                      className="bs-input"
                      rows={3}
                      value={factualGround.whatWeDo}
                      onChange={e => setFactualGround(p => ({ ...p, whatWeDo: e.target.value }))}
                      placeholder="We extract competitive intelligence from brand websites using an 8-stage AI pipeline..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">What we do NOT do</label>
                    <p className="bs-field-hint">Guardrails — what the writer should never claim about you. Example: "We are not a content marketing agency. We do not automate marketing workflows."</p>
                    <textarea
                      className="bs-input"
                      rows={3}
                      value={factualGround.whatWeDontDo}
                      onChange={e => setFactualGround(p => ({ ...p, whatWeDontDo: e.target.value }))}
                      placeholder="We are not a content agency. We do not automate marketing workflows..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Company facts</label>
                    <p className="bs-field-hint">Founding date, location, funding status, team size, key customer types. Verifiable data only.</p>
                    <textarea
                      className="bs-input"
                      rows={3}
                      value={factualGround.companyFacts}
                      onChange={e => setFactualGround(p => ({ ...p, companyFacts: e.target.value }))}
                      placeholder="Founded 2025. Portland, OR. Bootstrapped. 2-person team. Serves mid-market B2B SaaS companies..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Methodology / Approach</label>
                    <p className="bs-field-hint">The technical or procedural detail behind what you do. Lets the writer speak with authority on your process.</p>
                    <textarea
                      className="bs-input"
                      rows={4}
                      value={factualGround.methodology}
                      onChange={e => setFactualGround(p => ({ ...p, methodology: e.target.value }))}
                      placeholder="8-stage Context Agent Architecture: Context Hub → GEO Strategist → Authenticity Enricher → Content Generator → Compliance Gate → Publishing Queue → Performance Dashboard → Brain Memory..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Competitors</label>
                    <p className="bs-field-hint">The companies you actually compete with. One per line — use URLs for the strongest scraping signal, or brand names (e.g. "Alma" or "https://almaagency.com"). Feeds Brand Intelligence gap maps and keeps the Context Hub scan from wandering into lookalike industries.</p>
                    <textarea
                      className="bs-input"
                      rows={4}
                      value={factualGround.competitors}
                      onChange={e => setFactualGround(p => ({ ...p, competitors: e.target.value }))}
                      placeholder={'https://almaagency.com\nhttps://globalhue.com\nhttps://sensisagency.com'}
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Founding story</label>
                    <p className="bs-field-hint">The real origin — why this company exists. Specific enough that the writer can reference it without inventing details.</p>
                    <textarea
                      className="bs-input"
                      rows={3}
                      value={factualGround.foundingStory}
                      onChange={e => setFactualGround(p => ({ ...p, foundingStory: e.target.value }))}
                      placeholder="Brian Morgan founded Forge in 2025 after 10 years running Sandbox-XM, frustrated that every AI content tool solved for volume while none solved for intelligence..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Team composition</label>
                    <p className="bs-field-hint">Who's behind the work. Names, roles, disciplines. Supports E-E-A-T signals.</p>
                    <textarea
                      className="bs-input"
                      rows={2}
                      value={factualGround.teamComposition}
                      onChange={e => setFactualGround(p => ({ ...p, teamComposition: e.target.value }))}
                      placeholder="Brian Morgan (Founder, 10 years in B2B marketing ops); Claude (AI co-architect)..."
                    />
                  </div>

                  <div className="bs-field">
                    <label className="bs-label">Quotable positions</label>
                    <p className="bs-field-hint">Specific beliefs, takes, or phrases you want the writer to use verbatim when relevant. These become brain-certified direct quotes.</p>
                    <textarea
                      className="bs-input"
                      rows={4}
                      value={factualGround.quotablePositions}
                      onChange={e => setFactualGround(p => ({ ...p, quotablePositions: e.target.value }))}
                      placeholder={'"Every AI content tool is stateless. Forge inverts that entirely."\n"Share of voice is a scoreboard. Voice of market is an advantage."'}
                    />
                  </div>

                  <div className="bs-field">
                    <div className="fg-authors-header">
                      <label className="bs-label">Named Authors</label>
                      <div className="fg-authors-actions">
                        <label className="fg-csv-btn" title="Bulk import authors from a CSV file">
                          ↑ Import CSV
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            onChange={handleAuthorCsvImport}
                            style={{ display: 'none' }}
                          />
                        </label>
                        <button className="fg-add-btn" onClick={addAuthor}>+ Add Author</button>
                      </div>
                    </div>
                    <p className="bs-field-hint">Real people with real credentials. Fills the <code>name: null</code> gap in schema markup and gives the writer legitimate authority to reference. <strong>CSV format:</strong> headers <code>name, title, linkedinUrl, bio, credentials, expertise</code> (only <code>name</code> required).</p>
                    {csvImportMsg && <p className={`fg-csv-msg ${csvImportMsg.kind}`}>{csvImportMsg.text}</p>}

                    {factualGround.authors.map(author => (
                      <div key={author.id} className="fg-author-card">
                        <button className="fg-author-remove" onClick={() => removeAuthor(author.id)}>Remove</button>

                        <div className="fg-author-row">
                          <div className="bs-field">
                            <label className="bs-label">Full name</label>
                            <input
                              type="text"
                              value={author.name}
                              onChange={e => updateAuthor(author.id, 'name', e.target.value)}
                              placeholder="Brian Morgan"
                              className="bs-input"
                            />
                          </div>
                          <div className="bs-field">
                            <label className="bs-label">Title</label>
                            <input
                              type="text"
                              value={author.title}
                              onChange={e => updateAuthor(author.id, 'title', e.target.value)}
                              placeholder="Founder & CEO, Forge Intelligence"
                              className="bs-input"
                            />
                          </div>
                        </div>

                        <div className="bs-field">
                          <label className="bs-label">LinkedIn URL</label>
                          <input
                            type="text"
                            value={author.linkedinUrl}
                            onChange={e => updateAuthor(author.id, 'linkedinUrl', e.target.value)}
                            placeholder="https://linkedin.com/in/brianbodhimorgan"
                            className="bs-input"
                          />
                        </div>

                        <div className="bs-field">
                          <label className="bs-label">Bio</label>
                          <textarea
                            value={author.bio}
                            onChange={e => updateAuthor(author.id, 'bio', e.target.value)}
                            placeholder="10 years running Sandbox-XM. Led marketing for [clients]. Based in Portland, OR."
                            rows={2}
                            className="bs-input"
                          />
                        </div>

                        <div className="bs-field">
                          <label className="bs-label">Credentials</label>
                          <textarea
                            value={author.credentials}
                            onChange={e => updateAuthor(author.id, 'credentials', e.target.value)}
                            placeholder="Founded Sandbox-XM (2015). Event marketing experience at [companies]. Speaker at [conferences]."
                            rows={2}
                            className="bs-input"
                          />
                        </div>

                        <div className="bs-field">
                          <label className="bs-label">Areas of expertise</label>
                          <input
                            type="text"
                            value={author.expertise}
                            onChange={e => updateAuthor(author.id, 'expertise', e.target.value)}
                            placeholder="Brand intelligence, AI content architecture, B2B positioning"
                            className="bs-input"
                          />
                        </div>
                      </div>
                    ))}

                    {factualGround.authors.length === 0 && (
                      <div className="fg-empty">
                        No authors added yet. Add at least one to fix the <code>name: null</code> in your schema markup.
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Identity */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Identity</h2>
                  <p className="bs-section-sub">Basic brand information used across the platform.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Brand Name</label>
                    <input className="bs-input" value={form.brand_name || ''} onChange={e => set('brand_name', e.target.value)} placeholder="Acme Corp" />
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Brand URL</label>
                    <input className="bs-input bs-input-readonly" value={form.brand_url || ''} readOnly title="Set during Brain analysis — cannot be changed here" />
                    <span className="bs-field-hint">Set during Brain analysis. To change, run a new analysis.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Logo URL <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={form.logo_url || ''} onChange={e => set('logo_url', e.target.value)} placeholder="https://yoursite.com/logo.png" />
                    <span className="bs-field-hint">Used in article page headers and OG meta images.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Scrape URL Override <span className="bs-optional">advanced · optional</span></label>
                    <input
                      className="bs-input"
                      type="url"
                      value={scrapeUrlOverride}
                      onChange={e => setScrapeUrlOverride(e.target.value)}
                      placeholder="https://actual-origin.example.com"
                    />
                    <span className="bs-field-hint">If your brand URL is a masked subdomain, reverse proxy, or vanity domain pointing to a different origin, Forge will scrape this URL instead. Leave blank to scrape your Brand URL directly.</span>
                  </div>
                </div>
              </section>

              {/* Publishing */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Publishing</h2>
                  <p className="bs-section-sub">Configure where your articles live and how URLs are built.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Article Base URL <span className="bs-optional">BYO domain</span></label>
                    <input className="bs-input" value={form.article_base_url || ''} onChange={e => set('article_base_url', e.target.value)} placeholder="https://yoursite.com/articles" />
                    <span className="bs-field-hint">
                      Leave blank to use Forge-hosted article pages at <code>forgeintelligence.ai/articles</code>.
                      Set this to your own domain and Forge will build all article URLs, UTM links, and canonical tags using it.
                    </span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Article URL Suffix <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={form.article_url_suffix || ''} onChange={e => set('article_url_suffix', e.target.value)} placeholder=".html" style={{ maxWidth: '160px' }} />
                    <span className="bs-field-hint">Append to every article URL — use <code>.html</code> for static sites. Leave blank for clean URLs (Ghost, WordPress, Webflow).</span>
                  </div>
                  <div className="bs-url-preview">
                    <span className="bs-url-preview-label">Article URL preview</span>
                    <code className="bs-url-preview-value">
                      {(form.article_base_url || `https://forgeintelligence.ai/articles/${activeBrand?.brandUrl?.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'your-brand'}`)
                        .replace(/\/+$/, '')}/your-article-title{form.article_url_suffix || ''}
                    </code>
                  </div>
                </div>
              </section>

              {/* Site Template */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Site Template</h2>
                  <p className="bs-section-sub">Paste a sample article URL and your catalog page URL. Forge will scrape the DOM structure so Smart Export HTML matches your site exactly.</p>
                </div>
                <div className="bs-fields">
                  <div className="bs-field">
                    <label className="bs-label">Sample Article URL <span className="bs-optional">required</span></label>
                    <input className="bs-input" value={articleTemplateUrl} onChange={e => setArticleTemplateUrl(e.target.value)} placeholder="https://yoursite.com/articles/any-article.html" />
                    <span className="bs-field-hint">Any published article on your site. Forge extracts class names and DOM structure only — no styling is copied.</span>
                  </div>
                  <div className="bs-field">
                    <label className="bs-label">Article Catalog URL <span className="bs-optional">optional</span></label>
                    <input className="bs-input" value={catalogTemplateUrl} onChange={e => setCatalogTemplateUrl(e.target.value)} placeholder="https://yoursite.com/articles" />
                    <span className="bs-field-hint">The page listing all your articles. Used to generate drop-in card HTML for Smart Export.</span>
                  </div>
                  <div className="bs-scrape-row">
                    {scrapeError && <span className="bs-error">{scrapeError}</span>}
                    {scrapeSuccess && <span className="bs-saved">✓ Template scraped — Smart Export HTML will now match your site structure</span>}
                    <button className="bs-scrape-btn" onClick={handleScrape} disabled={scraping || !articleTemplateUrl}>
                      <IconRefresh />
                      {scraping ? 'Scraping...' : 'Scrape Template'}
                    </button>
                  </div>
                </div>
              </section>

              {/* Voice Calibration */}
              {voiceAttrs.length > 0 && (
                <section className="bs-section">
                  <div className="bs-section-header">
                    <h2 className="bs-section-title">Voice Calibration</h2>
                    <p className="bs-section-sub">Fine-tune how your Brain interprets your brand voice. Adjustments take effect immediately — no re-analysis needed.</p>
                  </div>
                  <div className="bs-voice-sliders">
                    {voiceAttrs.map((attr, i) => (
                      <div key={attr.attribute} className="bs-voice-slider-row">
                        <div className="bs-voice-slider-header">
                          <span className="bs-voice-attr-name">{attr.attribute}</span>
                          <span className="bs-voice-attr-score" style={{ color: attr.score >= 75 ? 'var(--color-accent)' : attr.score >= 50 ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{attr.score}</span>
                        </div>
                        <input
                          type="range" min={0} max={100} value={attr.score}
                          className="bs-voice-range"
                          onChange={e => setVoiceAttrs(prev => prev.map((a, j) => j === i ? { ...a, score: parseInt(e.target.value) } : a))}
                        />
                        {attr.description && <p className="bs-voice-attr-desc">{attr.description}</p>}
                      </div>
                    ))}
                  </div>
                  <div className="bs-voice-save-row">
                    {voiceSaved && <span className="bs-saved">✓ Voice profile updated</span>}
                    <button className="bs-save-btn" onClick={handleVoiceSave} disabled={voiceSaving}>
                      {voiceSaving ? 'Saving...' : 'Save Voice Calibration'}
                    </button>
                  </div>
                </section>
              )}

              {/* Email Preferences */}
              <section className="bs-section">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Email Preferences</h2>
                  <p className="bs-section-sub">Weekly Brain digest — what your Brain learned, top performers, decay alerts, and what to do next.</p>
                </div>
                <label className="bs-toggle-row">
                  <div>
                    <span className="bs-toggle-label">Weekly Brain Digest</span>
                    <span className="bs-toggle-hint">Sent every Monday · Unsubscribe anytime</span>
                  </div>
                  <button
                    className={`bs-toggle-btn ${!digestOptOut ? 'active' : ''}`}
                    onClick={() => handleDigestToggle(!digestOptOut)}
                    disabled={digestSaving}
                    title={digestOptOut ? 'Click to re-subscribe' : 'Click to unsubscribe'}
                  >
                    <span className="bs-toggle-knob" />
                  </button>
                </label>
              </section>

              {/* Plan & Billing */}
              <section className="bs-section bs-section-billing">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Plan & Billing</h2>
                  <p className="bs-section-sub">Your current plan and what's included.</p>
                </div>
                <div className="bs-billing-card">
                  <div className="bs-billing-top">
                    <div>
                      <div className="bs-plan-name">SMB Standard</div>
                      <div className="bs-plan-price">$99 <span className="bs-plan-price-sub">· one-time · lifetime access</span></div>
                      {activatedDate && <div className="bs-plan-since">Active since {activatedDate}</div>}
                    </div>
                    <div className="bs-plan-badge-active">Active</div>
                  </div>
                  <div className="bs-billing-includes">
                    <div className="bs-billing-includes-label">What's included</div>
                    <div className="bs-billing-features">
                      {[
                        'Full 8-stage content intelligence pipeline',
                        '1 brand Brain with compounding memory',
                        'Unlimited content generation',
                        'Multi-channel publishing (LinkedIn, X, Ghost, WordPress, Webflow, Facebook)',
                        'Pre-cog score badge on every article',
                        'Performance Dashboard with decay monitoring',
                        'Weekly Brain digest email',
                        'Pattern Extractor — Stage 8 feedback loop',
                      ].map(f => (
                        <div key={f} className="bs-billing-feature">
                          <span className="bs-billing-check"><IconCheck /></span>
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bs-billing-upgrade">
                    <div className="bs-billing-upgrade-label">Coming soon — Pro tier at $299/mo</div>
                    <div className="bs-billing-upgrade-sub">Full Pre-cog Predictions tab · Deep pattern analysis · HubSpot campaign attribution</div>
                  </div>
                </div>
              </section>

              {/* Danger Zone */}
              <section className="bs-section bs-section-danger">
                <div className="bs-section-header">
                  <h2 className="bs-section-title">Danger Zone</h2>
                  <p className="bs-section-sub">Irreversible actions. Proceed with caution.</p>
                </div>
                <div className="bs-danger-row">
                  <div>
                    <div className="bs-danger-label">Delete this brand</div>
                    <div className="bs-danger-sub">Permanently removes the brand profile, all generated content, campaigns, and publishing history.</div>
                  </div>
                  <button className="bs-danger-btn" disabled title="Coming soon">Delete Brand</button>
                </div>
              </section>


              {/* Reviewers Section */}
              <section style={{ marginTop: 32, padding: '24px', background: 'var(--color-bg-card, #fff)', borderRadius: 12, border: '1px solid var(--color-border, #e2e8f0)' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text, #1e293b)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reviewers</h3>
                <p style={{ fontSize: 13, color: 'var(--color-text-secondary, #64748b)', marginBottom: 16 }}>Reviewers receive an email with a unique link to approve or request changes on articles before publishing.</p>
                <div className="bs-reviewer-add-row" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <input className="bs-reviewer-input" style={{ flex: 1, minWidth: 120, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Name" value={revName} onChange={e => setRevName(e.target.value)} />
                  <input className="bs-reviewer-input" style={{ flex: 1, minWidth: 160, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Email" type="email" value={revEmail} onChange={e => setRevEmail(e.target.value)} />
                  <input className="bs-reviewer-input" style={{ flex: 1, minWidth: 120, padding: '8px 12px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }} placeholder="Title (optional)" value={revTitle} onChange={e => setRevTitle(e.target.value)} />
                  <button className="bs-reviewer-add-btn" onClick={addReviewer} disabled={revSaving} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: 'var(--color-accent, #4F46E5)', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {revSaving ? 'Adding...' : '+ Add'}
                  </button>
                </div>
                {revError && <div style={{ fontSize: 12, color: '#EF4444', marginBottom: 8 }}>{revError}</div>}
                {reviewers.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {reviewers.map(r => (
                      <div className="bs-reviewer-item" key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--color-bg, #f8fafc)', borderRadius: 8, border: '1px solid var(--color-border, #e2e8f0)' }}>
                        <div className="bs-reviewer-avatar" style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--color-accent, #4F46E5)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{r.name[0].toUpperCase()}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text, #1e293b)' }}>{r.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #64748b)' }}>{r.email}{r.title ? ` · ${r.title}` : ''}</div>
                        </div>
                        <button onClick={() => removeReviewer(r.id)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, padding: 4 }} title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #94a3b8)', textAlign: 'center', padding: '16px 0' }}>No reviewers added yet</div>
                )}
              </section>

            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
