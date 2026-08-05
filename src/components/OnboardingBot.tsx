import { useState, useEffect, useRef } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';
import { useNavigate } from 'react-router-dom';
import './OnboardingBot.css';

interface Step {
  id: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: { label: string; href: string };
  nudge?: string;
}

const IconBrain = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.077-4.56A3 3 0 0 1 3.83 9.85a3 3 0 0 1 .81-4.87A2.5 2.5 0 0 1 9.5 2Z"/>
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.077-4.56A3 3 0 0 0 20.17 9.85a3 3 0 0 0-.81-4.87A2.5 2.5 0 0 0 14.5 2Z"/>
  </svg>
);
const IconZap = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const IconGlobe = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
);
const IconShield = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);
const IconSend = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>
  </svg>
);
const IconBarChart = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
  </svg>
);
const IconRefresh = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M16 8h5V3"/>
  </svg>
);
const IconSparkle = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
  </svg>
);
const IconX = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const IconForge = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

const STEPS: Step[] = [
  {
    id: 'welcome',
    icon: <IconSparkle />,
    title: "Welcome to Forge Intelligence",
    body: "You just unlocked something different. Most AI content tools solve for volume. Forge solves for compounding intelligence — your content gets measurably smarter and more commercially effective with every publish cycle. I'll walk you through how it all works.",
    cta: undefined
  },
  {
    id: 'brain',
    icon: <IconBrain />,
    title: "Your Brain is your foundation",
    body: "Everything in Forge starts with the Context Hub. Drop in your brand URL. Forge runs Perplexity Sonar for competitor and ICP discovery, then reads your full site — homepage, pricing, blog, about, customers, FAQ, anywhere with content — via Jina Reader (with a Bright Data Chromium fallback for SPAs and bot-protected sites). Claude Opus synthesizes it all into a full Brand Intelligence Profile. This is your Brain — it shapes every word the platform generates.",
    cta: { label: "Run your first Brain analysis →", href: "/app/context-hub" },
    nudge: "Not quite right? Tune your brand voice in Brand Settings →"
  },
  {
    id: 'geo',
    icon: <IconGlobe />,
    title: "Find where you can actually win",
    body: "Once your Brain exists, run GEO Strategy. It maps your topical authority gaps, scores opportunities across ChatGPT, Perplexity, AI Overviews, and Gemini, and generates a structured brief. This tells you exactly what to write to get cited by AI engines — not just ranked by Google.",
    cta: { label: "Run GEO Strategy →", href: "/app/geo-strategist" }
  },
  {
    id: 'generate',
    icon: <IconZap />,
    title: "Content that sounds like you",
    body: "The Content Generator reads your Brain before writing a single word — your voice profile, patterns that have worked before, mistakes to avoid. Every section gets a confidence score. Green means your Brain is highly aligned. Yellow means SME input would strengthen it. Red means it needs your eyes before publishing.",
    cta: { label: "Generate your first article →", href: "/app/content-generator" }
  },
  {
    id: 'quick-copy',
    icon: <IconZap />,
    title: "One-offs without the pipeline",
    body: "Not every ask is an article. Quick Copy writes brand-voiced email replies, DMs, and posts from the same Brain — variant picker, copy-out, optional inline claim check. When a one-off needs to grow, hand it to Email Campaign or Social.",
    cta: { label: "Try Quick Copy →", href: "/app/quick-copy" }
  },
  {
    id: 'compliance',
    icon: <IconShield />,
    title: "Every edit trains your Brain",
    body: "The Compliance Gate is where AI critique meets human judgment. Review flagged sections, edit what needs changing, then approve. Here's the part that matters: every edit you make writes back to your Brain as a mistake to avoid in the future. The more you use the Gate, the less you need it.",
    cta: { label: "Open Compliance Gate →", href: "/app/compliance-gate" }
  },
  {
    id: 'publish',
    icon: <IconSend />,
    title: "Publish everywhere, track everything",
    body: "Connect your channels once in Integrations — LinkedIn, X, Facebook, Reddit, Medium, Ghost, WordPress, Webflow, plus My Website (publish to your own self-hosted site via authenticated webhook). Then publish from the Queue with one click. UTMs are injected automatically on every channel so you can trace every conversion back to the article that drove it.",
    cta: { label: "Connect your channels →", href: "/app/integrations" }
  },
  {
    id: 'performance',
    icon: <IconBarChart />,
    title: "Sync analytics, close the loop",
    body: "After you publish, hit Sync in the Performance Dashboard. Your analytics flow in — impressions, clicks, engagement, GEO citations. The Pattern Extractor then analyzes what performed and writes the winning patterns back to your Brain. Stage 8 runs automatically. Your Brain just got smarter.",
    cta: { label: "Open Performance Dashboard →", href: "/app/performance" }
  },
  {
    id: 'loop',
    icon: <IconRefresh />,
    title: "The compounding effect starts now",
    body: "By Month 3 you'll have 10–15 proven patterns. By Month 6 your Brain is self-correcting before human review. By Month 12 it's a proprietary asset — your competitors can't replicate what your Brain has learned. The longer you use Forge, the wider that gap gets. Let's get started.",
    cta: { label: "Run your Brain analysis →", href: "/app/context-hub" }
  }
];

const FAQ = [
  { q: "How do I re-run my brand analysis?", a: "Go to the Brand Profile view and click 'Re-analyze'. This updates your existing profile in place — all your content, analytics, and Brain data stay connected. No need to start over." },
  { q: "Where will my articles live?", a: "By default, Forge hosts articles at forgeintelligence.ai/articles/<brand>/<slug>. Two ways to host on your own domain instead: (1) set an Article Base URL in Brand Settings — Forge still hosts the HTML but every URL we publish points to your domain (you proxy or redirect to ours); or (2) connect the My Website integration — Forge POSTs the article payload directly to a receiver on your site, you host natively. See /docs/my-website for the My Website setup guide." },
  { q: "Why does my brand profile show an orange warning?", a: "Brand scans cascade Jina Reader → Bright Data Web Unlocker → Bright Data Scraping Browser, which handles most Cloudflare and bot-protection setups. An orange warning means even the rendering browser couldn't reach your site (rare — usually a custom WAF rule, geo-block, or rate limit). The profile was built from search + metadata only. Try re-analyzing in a few minutes, or reach out if it persists." },
  { q: "Why is my GEO score low?", a: "GEO scoring reflects your current AI citation presence — most brands start low. The opportunity score shows where AI platforms have gaps you can fill. A low score means high upside." },
  { q: "Where did my generated article go?", a: "Articles are saved automatically. If you navigate away and come back to the Content Generator, your last article will reload. You can also find all articles in the Content Library or Compliance Gate." },
  { q: "What's the Brain Match score?", a: "Brain Match measures how closely a generated article aligns with your brand's voice profile, personas, and strategic positioning. Higher scores mean the content sounds more like your brand, not generic AI." },
  { q: "How do I navigate the pipeline?", a: "Each stage has a 'Continue to...' button in the top-right that takes you to the next step. The full flow is: Context Hub → GEO Strategist → Authenticity Enricher → Content Generator → Compliance Gate → Publishing." },
  { q: "What's the Ideas feature?", a: "The Ideas button in the Content Generator header lets you save topic ideas for later. Park an idea, and when you're ready to write, you can pull it into the generator as a topic prompt." },
  { q: "What channels can I publish to?", a: "LinkedIn, X (Twitter), Facebook Pages, Reddit, Medium, Ghost CMS, WordPress, and Webflow are all live. Plus 'My Website' — a webhook publisher for any self-hosted site you control. Connect them in Settings → Integrations." },
  { q: "How does My Website work?", a: "It's a webhook publisher for any site you control. You add a POST endpoint on your site, Forge generates a one-time bearer token, choose payload format (HTML, Markdown, or both), then Forge sends each article whenever you publish. Your receiver decides storage and rendering. Full payload schema + copy-paste receivers for Node/Express + Postgres, Next.js, and filesystem rebuilds are at /docs/my-website." },
  { q: "How often should I sync analytics?", a: "Weekly is ideal. The Pattern Extractor runs after each sync and writes new learnings back to the Brain — so your next article is smarter than your last." },
  { q: "What's the Compliance Gate for?", a: "It reviews every article for factual claims, brand voice alignment, and citation opportunities before publishing. Sections are auto-approved or flagged for human review. You can also add reviewers who get an email link to approve or request changes." },
  { q: "How do I add a reviewer?", a: "Go to Settings → Brand Settings and scroll to the Reviewers section. Add them by name and email. When you send an article for review, they'll receive an email with a unique approval link." },
  { q: "Why am I seeing a Reconnect button instead of Reset & Retry?", a: "Your platform OAuth token expired (LinkedIn, X, Facebook all rotate tokens periodically and invalidate them on password change). Forge clears the dead credentials and shows a Reconnect link because retrying the same publish would fail again — you need to re-authorize the channel in Integrations first." },
  { q: "Can I use a promo code?", a: "Yes — when you hit a paid feature gate, enter your promo code in the modal. If it's a 100% discount code, access unlocks immediately with no expiration." },
  { q: "What is Pre-cog scoring?", a: "Pre-cog predicts how an article will perform relative to your historical average, using your Brain data and past analytics. It runs automatically before content generation to catch weak topics early." },
  { q: "How do I export my Strategy Brief?", a: "On the Strategy Brief view, click 'Export Brief' in the header. This downloads a JSON file with your full strategic analysis including personas, positioning, and content recommendations." },
];

const STORAGE_KEY = (userId: string) => `forge_onboarding_${userId}`;

export function OnboardingBot() {
  const { isSignedIn, userId } = useAuth();
  const { user, isLoaded: userLoaded } = useUser();
  const { isPaid } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'onboarding' | 'faq'>('onboarding');
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  const [faqQuery, setFaqQuery] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Wait until Clerk user is fully loaded — otherwise unsafeMetadata reads false-negative
    if (!isSignedIn || !userId || !isPaid || !userLoaded) return;
    if (hydrated) return;

    // Source of truth priority: Clerk unsafeMetadata (cross-device) > localStorage (local cache)
    const clerkState = (user?.unsafeMetadata as any)?.onboarding as
      | { completedAt?: string | null; stepReached?: number }
      | undefined;
    const stored = localStorage.getItem(STORAGE_KEY(userId));
    const localState = stored ? JSON.parse(stored) : null;

    // Clerk wins if it has completion; otherwise take whichever has data
    const state = clerkState?.completedAt
      ? clerkState
      : localState?.completedAt
        ? localState
        : (clerkState || localState);

    // If Clerk has completion but local doesn't, backfill local cache so trigger button shows immediately next load
    if (clerkState?.completedAt && !localState?.completedAt) {
      localStorage.setItem(STORAGE_KEY(userId), JSON.stringify(clerkState));
    }
    // If local has completion but Clerk doesn't, backfill Clerk (legacy users who onboarded pre-fix)
    if (localState?.completedAt && !clerkState?.completedAt && user) {
      user.update({
        unsafeMetadata: { ...(user.unsafeMetadata || {}), onboarding: localState }
      }).catch(() => {});
    }

    if (state?.completedAt) {
      setCompleted(true);
      setMode('faq');
      setHydrated(true);
      return; // never auto-open for users who have finished onboarding
    }
    if (state?.stepReached != null) {
      setStep(state.stepReached);
    }
    setHydrated(true);
    const timer = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(timer);
  }, [isSignedIn, userId, isPaid, userLoaded, user, hydrated]);

  // Scroll to top of body on step change
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  if (!isSignedIn || !isPaid) return null;

  const saveProgress = (s: number, done = false) => {
    if (!userId) return;
    const payload = {
      stepReached: s,
      completedAt: done ? new Date().toISOString() : null
    };
    // Fast local cache (prevents flash on next load)
    localStorage.setItem(STORAGE_KEY(userId), JSON.stringify(payload));
    // Durable cross-device source of truth — fire and forget
    if (user) {
      user.update({
        unsafeMetadata: { ...(user.unsafeMetadata || {}), onboarding: payload }
      }).catch(err => console.warn('[onboarding] clerk sync failed:', err));
    }
  };

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      const next = step + 1;
      setStep(next);
      saveProgress(next);
    } else {
      setCompleted(true);
      setMode('faq');
      saveProgress(step, true);
    }
  };

  const handleCta = (href: string) => {
    navigate(href);
    setMinimized(true);
  };

  const handleComplete = () => {
    setCompleted(true);
    setMode('faq');
    saveProgress(step, true);
  };

  const filteredFaq = faqQuery.trim()
    ? FAQ.filter(f => f.q.toLowerCase().includes(faqQuery.toLowerCase()) || f.a.toLowerCase().includes(faqQuery.toLowerCase()))
    : FAQ;

  const currentStep = STEPS[step];
  const progress = ((step) / (STEPS.length - 1)) * 100;

  return (
    <>
      {/* Floating trigger button */}
      {!open && (
        <button className="ob-trigger" onClick={() => { setOpen(true); setMinimized(false); }} title={completed ? "Help & FAQ" : "Onboarding"}>
          <IconForge />
          {!completed && <span className="ob-trigger-badge">{STEPS.length - step}</span>}
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className={`ob-panel ${minimized ? 'ob-minimized' : ''}`}>
          {/* Header */}
          <div className="ob-header">
            <div className="ob-header-left">
              <span className="ob-header-icon"><IconForge /></span>
              <div>
                <div className="ob-header-title">{completed ? 'Help & FAQ' : 'Getting Started'}</div>
                {!completed && <div className="ob-header-sub">Step {step + 1} of {STEPS.length}</div>}
              </div>
            </div>
            <div className="ob-header-actions">
              {!completed && (
                <button className="ob-header-btn" onClick={handleComplete} title="Skip onboarding">
                  Skip
                </button>
              )}
              {completed && (
                <button className="ob-header-btn" onClick={() => { setCompleted(false); setMode('onboarding'); setStep(0); saveProgress(0); }} title="Restart onboarding">
                  Restart
                </button>
              )}
              <button className="ob-header-btn ob-minimize" onClick={() => setMinimized(m => !m)} title="Minimize">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button className="ob-header-btn ob-close" onClick={() => setOpen(false)} title="Close">
                <IconX />
              </button>
            </div>
          </div>

          {!minimized && (
            <>
              {mode === 'onboarding' ? (
                <>
                  {/* Progress bar */}
                  <div className="ob-progress-track">
                    <div className="ob-progress-fill" style={{ width: `${progress}%` }} />
                  </div>

                  {/* Step content */}
                  <div className="ob-body" ref={bodyRef}>
                    <div className="ob-step-icon">{currentStep.icon}</div>
                    <h3 className="ob-step-title">{currentStep.title}</h3>
                    <p className="ob-step-body">{currentStep.body}</p>

                    {currentStep.cta && (
                      <button className="ob-cta-btn" onClick={() => handleCta(currentStep.cta!.href)}>
                        {currentStep.cta.label}
                      </button>
                    )}
                    {currentStep.nudge && (
                      <button className="ob-nudge-btn" onClick={() => handleCta('/app/brand-settings')}>
                        {currentStep.nudge}
                      </button>
                    )}
                  </div>

                  {/* Step dots */}
                  <div className="ob-dots">
                    {STEPS.map((_, i) => (
                      <button
                        key={i}
                        className={`ob-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                        onClick={() => { setStep(i); saveProgress(i); }}
                        title={STEPS[i].title}
                      />
                    ))}
                  </div>

                  {/* Footer nav */}
                  <div className="ob-footer">
                    <button
                      className="ob-btn-ghost"
                      onClick={() => { const p = Math.max(0, step - 1); setStep(p); saveProgress(p); }}
                      disabled={step === 0}
                    >
                      Back
                    </button>
                    <button className="ob-btn-primary" onClick={handleNext}>
                      {step === STEPS.length - 1 ? 'Finish →' : 'Next →'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* FAQ mode */}
                  <div className="ob-faq-search-wrap">
                    <input
                      className="ob-faq-search"
                      placeholder="Search for help..."
                      value={faqQuery}
                      onChange={e => setFaqQuery(e.target.value)}
                    />
                  </div>
                  <div className="ob-body ob-faq-body" ref={bodyRef}>
                    {filteredFaq.length === 0 ? (
                      <div className="ob-faq-empty">No results for "{faqQuery}"</div>
                    ) : filteredFaq.map((item, i) => (
                      <div key={i} className="ob-faq-item">
                        <button
                          className={`ob-faq-q ${faqOpen === i ? 'open' : ''}`}
                          onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                        >
                          <span>{item.q}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`ob-faq-chevron ${faqOpen === i ? 'open' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        {faqOpen === i && <div className="ob-faq-a">{item.a}</div>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
