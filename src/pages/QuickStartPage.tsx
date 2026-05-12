import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Rocket } from 'lucide-react';
import './QuickStartPage.css';

interface FounderBrief {
  brandName: string;
  whatWeDo: string;
  whatWeDoNot: string;
  competitors: string;
  foundingStory: string;
  methodology: string;
  teamComposition: string;
  quotablePositions: string;
  namedAuthors: string;
  logoUrl: string;
}

const emptyBrief: FounderBrief = {
  brandName: '',
  whatWeDo: '',
  whatWeDoNot: '',
  competitors: '',
  foundingStory: '',
  methodology: '',
  teamComposition: '',
  quotablePositions: '',
  namedAuthors: '',
  logoUrl: '',
};

const REQUIRED_KEYS: Array<keyof FounderBrief> = ['brandName', 'whatWeDo', 'whatWeDoNot', 'competitors'];

function genSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `qs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function QuickStartPage() {
  const navigate = useNavigate();
  const [brief, setBrief] = useState<FounderBrief>(emptyBrief);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = REQUIRED_KEYS.every(k => brief[k].trim().length > 0) && !submitting;

  const update = (k: keyof FounderBrief) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setBrief(b => ({ ...b, [k]: e.target.value }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    // Trim everything; only send non-empty optional fields to keep the payload tight.
    const trimmed: Partial<FounderBrief> = {};
    (Object.keys(brief) as Array<keyof FounderBrief>).forEach(k => {
      const v = brief[k].trim();
      if (v) trimmed[k] = v;
    });

    // Anonymous session token — survives until the founder signs up via Clerk,
    // at which point the server can claim profiles owned by this session.
    let sessionId: string;
    try {
      sessionId = localStorage.getItem('forge_quick_start_session') || genSessionId();
      localStorage.setItem('forge_quick_start_session', sessionId);
    } catch {
      sessionId = genSessionId();
    }

    try {
      sessionStorage.setItem('forge_onboard_factual_ground', JSON.stringify(trimmed));
    } catch {
      // sessionStorage blocked — fall back to URL state? For MVP, surface a
      // browser-level error rather than silently dropping the brief.
      setSubmitting(false);
      alert('Your browser is blocking sessionStorage, which Forge needs to hand off your brief. Try a different browser or enable storage for this site.');
      return;
    }

    navigate('/app/context-hub');
  };

  return (
    <div className="quick-start-page">
      <header className="qs-header">
        <div className="qs-eyebrow">Forge Intelligence · Quick Start</div>
        <h1 className="qs-headline">Tell us what your product actually does.</h1>
        <p className="qs-subhead">
          We'll build the brand brain. Then you build the product.
        </p>
      </header>

      <form className="qs-form" onSubmit={handleSubmit} noValidate>
        <div className="qs-section-label">The Founder Brief</div>

        <div className="qs-field">
          <label htmlFor="brandName">Brand Name <span className="qs-req">*</span></label>
          <input
            id="brandName"
            type="text"
            value={brief.brandName}
            onChange={update('brandName')}
            placeholder="What's it called?"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="qs-field">
          <label htmlFor="whatWeDo">What we actually do <span className="qs-req">*</span></label>
          <textarea
            id="whatWeDo"
            value={brief.whatWeDo}
            onChange={update('whatWeDo')}
            placeholder="In plain language — what does your product do and for whom?"
            rows={4}
          />
        </div>

        <div className="qs-field">
          <label htmlFor="whatWeDoNot">What we do <em>NOT</em> do <span className="qs-req">*</span></label>
          <textarea
            id="whatWeDoNot"
            value={brief.whatWeDoNot}
            onChange={update('whatWeDoNot')}
            placeholder="What do people assume you do that you don't? What's explicitly out of scope?"
            rows={3}
          />
          <p className="qs-helper">These non-actions become your <strong>strategic moats</strong> — they protect your positioning, not your competitive gaps.</p>
        </div>

        <div className="qs-field">
          <label htmlFor="competitors">Competitors <span className="qs-req">*</span></label>
          <textarea
            id="competitors"
            value={brief.competitors}
            onChange={update('competitors')}
            placeholder="Who are you most often compared to? Who would a buyer also evaluate?"
            rows={3}
          />
        </div>

        <div className="qs-field">
          <label htmlFor="foundingStory">Founding story <span className="qs-optional">(optional)</span></label>
          <textarea
            id="foundingStory"
            value={brief.foundingStory}
            onChange={update('foundingStory')}
            placeholder="Why does this exist? What happened that made you build it?"
            rows={3}
          />
        </div>

        <button
          type="button"
          className="qs-advanced-toggle"
          onClick={() => setAdvancedOpen(o => !o)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? <ChevronUp size={16} strokeWidth={1.5} /> : <ChevronDown size={16} strokeWidth={1.5} />}
          <span>{advancedOpen ? 'Hide additional context' : 'Add more context'}</span>
        </button>

        {advancedOpen && (
          <div className="qs-advanced">
            <div className="qs-field">
              <label htmlFor="methodology">Methodology / Approach</label>
              <textarea
                id="methodology"
                value={brief.methodology}
                onChange={update('methodology')}
                placeholder="How do you do what you do differently than everyone else?"
                rows={3}
              />
            </div>

            <div className="qs-field">
              <label htmlFor="teamComposition">Team composition</label>
              <textarea
                id="teamComposition"
                value={brief.teamComposition}
                onChange={update('teamComposition')}
                placeholder="Who's building this? Relevant backgrounds, expertise."
                rows={2}
              />
            </div>

            <div className="qs-field">
              <label htmlFor="quotablePositions">Quotable positions</label>
              <textarea
                id="quotablePositions"
                value={brief.quotablePositions}
                onChange={update('quotablePositions')}
                placeholder="Hot takes, beliefs, contrarian stances your brand owns."
                rows={3}
              />
            </div>

            <div className="qs-field">
              <label htmlFor="namedAuthors">Named Authors</label>
              <textarea
                id="namedAuthors"
                value={brief.namedAuthors}
                onChange={update('namedAuthors')}
                placeholder="Real humans who should be attributed as thought leaders."
                rows={2}
              />
            </div>

            <div className="qs-field">
              <label htmlFor="logoUrl">Logo URL</label>
              <input
                id="logoUrl"
                type="url"
                value={brief.logoUrl}
                onChange={update('logoUrl')}
                placeholder="https://..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        <div className="qs-actions">
          <button type="submit" className="qs-submit" disabled={!canSubmit}>
            <Rocket size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{submitting ? 'Building your brand brain…' : 'Build My Brand Brain →'}</span>
          </button>
          <p className="qs-loading-note">
            This takes about 60 seconds. We're synthesizing your positioning, voice, personas, and competitive whitespace.
          </p>
        </div>
      </form>
    </div>
  );
}
