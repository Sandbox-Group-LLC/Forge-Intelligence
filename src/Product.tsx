import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarketingShell, Section } from './marketing/MarketingShell';
import { Hero } from './ds/components/marketing/Hero';
import { SectionHeader } from './ds/components/marketing/SectionHeader';
import { Pipeline } from './ds/components/marketing/Pipeline';
import { BrainTimeline } from './ds/components/marketing/BrainTimeline';
import { CTABand } from './ds/components/marketing/CTABand';
import { ScreenFrame } from './ds/components/marketing/ScreenFrame';
import { Reveal } from './ds/components/marketing/Reveal';
import { Card } from './ds/components/cards/Card';
import { FeatureCard } from './ds/components/cards/FeatureCard';
import { PricingCard } from './ds/components/cards/PricingCard';
import { Button } from './ds/components/core/Button';
import { Badge } from './ds/components/core/Badge';
import { Icon } from './ds/components/brand/Icon';

// ── Content (copy is unchanged from the shipped page) ────────────────────────

const stages = [
  { num: 1, name: 'Context Hub', icon: 'radar', desc: 'Brand voice, personas, competitive gaps, extracted from your site and your competitors\' sites in minutes, not months' },
  { num: 2, name: 'GEO Strategy', icon: 'crosshair', desc: 'Citation gaps measured live against ChatGPT, Perplexity, Gemini, and Google AI Overviews: who AI cites today, and where you\'re invisible' },
  { num: 3, name: 'Authenticity', icon: 'shield', desc: 'E-E-A-T signals, SME hooks, first-person experience injection' },
  { num: 4, name: 'Generation', icon: 'pen-tool', desc: 'Brain-informed content with confidence scoring per section' },
  { num: 5, name: 'Compliance', icon: 'circle-check', desc: 'Human gate with auto-learning from every edit' },
  { num: 6, name: 'Publishing', icon: 'globe', desc: 'Multi-channel distribution with UTM intelligence' },
  { num: 7, name: 'Performance', icon: 'gauge', desc: 'Analytics sync, decay monitoring, citation tracking' },
  { num: 8, name: 'Feedback Loop', icon: 'repeat', desc: 'Patterns extracted, mistakes crystallized, brain compounds' },
];

const personas = [
  {
    name: 'Strategic Sarah',
    role: 'VP of Marketing',
    pain: 'Another AI tool promising magic. Will this actually understand our brand\'s specific positioning, or just create more cleanup work?',
    outcome: 'Scale content operations without proportional headcount growth. Own differentiated positioning before competitors claim key narratives.',
  },
  {
    name: 'Operations Owen',
    role: 'Head of Content',
    pain: 'Spending 40% of time on research and context-gathering before actual content creation.',
    outcome: 'Eliminate repetitive research. Build systematic competitive intelligence that compounds over time.',
  },
  {
    name: 'Performance Pete',
    role: 'Director of Demand Gen',
    pain: 'How does brand intelligence actually translate to demand gen performance? Need to see clear pipeline impact, not just content outputs.',
    outcome: 'Deploy persona-specific messaging at scale. Build defensible positioning competitors can\'t easily replicate.',
  },
];

const gaps = [
  {
    icon: 'layers',
    title: 'Pipeline Transparency',
    claim: 'Most AI content tools are black boxes.',
    ours: 'Forge\'s explicit 8-stage pipeline creates transparent, auditable intelligence generation that enterprises can trust.',
  },
  {
    icon: 'brain',
    title: 'Brand Context That Compounds',
    claim: 'Competitors require repeated context input or shallow brand profiles.',
    ours: 'Deep contextual memory that compounds over time, largely unclaimed territory in the market.',
  },
  {
    icon: 'network',
    title: 'Competitive Intelligence Integration',
    claim: 'CI tools and content tools exist separately.',
    ours: 'Competitor sites crawled, AI engines probed live. Measured signals feed topic discovery and content generation directly. A significant white space.',
  },
  {
    icon: 'gauge',
    title: 'Measured, Not Modeled',
    claim: 'Most GEO tools estimate your AI visibility from proxies.',
    ours: 'Forge asks the actual engines. Real buyer questions, probed against ChatGPT, Perplexity, Gemini, and AI Overviews. Your whitespace is observed, not imagined.',
  },
];

const intelDimensions = [
  { icon: 'crosshair', name: 'Gap Map', desc: 'Topical territory competitors own and you don\'t, ranked by how winnable it is.' },
  { icon: 'shield', name: 'Positioning Vulnerabilities', desc: 'Where your current positioning is exposed, and which competitor is positioned to exploit it.' },
  { icon: 'git-branch', name: 'Fault Lines', desc: 'The structural cracks in each competitor\'s story you can pry open.' },
  { icon: 'scan-line', name: 'Blind Spots', desc: 'What the whole category has stopped questioning, and you can.' },
  { icon: 'target', name: 'Whitespace', desc: 'Demand nobody is serving yet, measured against live competitor coverage.' },
  { icon: 'repeat', name: 'Pivot Scenarios', desc: 'Adjacent positions you could credibly take, pressure-tested before you commit.' },
];

const formats = [
  { icon: 'layers', tag: 'Stage 4.5', name: 'Campaign Generator', desc: 'An 8-article campaign, two a week for four weeks, built from one brain.' },
  { icon: 'message-square', tag: 'Stage 4.6', name: 'Email Sequences', desc: 'Brief-driven, voice-matched email sequences. Copy each one out HubSpot-ready.' },
  { icon: 'chart-column', tag: 'Stage 4.7', name: 'Google Ads Packs', desc: '15 headlines, 4 descriptions, sitelinks, callouts, and match-typed keywords. Paste into Google Ads or export CSV.' },
  { icon: 'sparkles', tag: 'Short-form', name: 'Social Generator', desc: 'Four posts at four angles for X and Instagram, each with a social-tuned image.' },
  { icon: 'pen-tool', tag: 'Video', name: 'Video Reels', desc: 'A brief becomes a branded product reel: storyboard, voiceover, and render, all automatic.' },
];

const timeline = [
  { when: 'Day 1', state: 'Brain empty. Agents start from brand context only.', depth: 8 },
  { when: 'Week 4', state: '10-15 patterns. Agents prefer proven structures.', depth: 28 },
  { when: 'Month 3', state: '50+ patterns. Human edit rate drops 30%.', depth: 55 },
  { when: 'Month 6', state: 'Agents self-correct before human review.', depth: 78 },
  { when: 'Month 12', state: 'Brain is a proprietary asset. Switching means starting over.', depth: 96 },
];

const included = [
  'Brand Intelligence Profile',
  'Persona Pain Point Mapping',
  'Competitor Site Crawl',
  'Live AI Citation Probe (4 engines)',
  'Competitive Gap Analysis',
  'Brand Intelligence (6 dimensions)',
  'GEO Strategy Brief',
  'E-E-A-T Enrichment',
  'AI Content Generation',
  'Campaign Generator',
  'Email Sequences',
  'Google Ads Packs',
  'Social Post Generator',
  'Video Reels',
  'Confidence Scoring',
  'Compliance Gate',
  'Multi-Channel Publishing',
  'Performance Dashboard',
  'Pattern Learning',
  'Decay Monitoring',
];

function Caption({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--text-caption)',
        textAlign: 'center',
        fontStyle: 'italic',
        marginTop: 'var(--space-3)',
      }}
    >
      {children}
    </p>
  );
}

export default function Product() {
  const navigate = useNavigate();
  const [stage, setStage] = useState(0);

  return (
    <MarketingShell activeHref="/product">
      {/* Hero */}
      <Hero
        align="center"
        eyebrow="Brand Intelligence Infrastructure"
        title={
          <>
            The only member of your content team who will tell you <em>when the strategy is wrong.</em>
          </>
        }
        subtitle="Not opinion. Pattern recognition from your own data. No feelings, no politics, no 47-slide deck to justify it."
        actions={
          <Button variant="primary" trailingIcon="arrow-right" onClick={() => navigate('/')}>
            Analyze my brand free
          </Button>
        }
      />

      {/* Product Shot: Brand Profile */}
      <Section size="sm">
        <Reveal>
          <ScreenFrame url="forgeintelligence.ai" label="Brand Profile">
            <img
              src="/1.png"
              alt="Forge Intelligence Brand Profile with voice analysis and tone attributes"
              style={{ width: '100%', display: 'block' }}
            />
          </ScreenFrame>
          <Caption>Your brand's voice, personas, and competitive position, extracted from your actual website in minutes.</Caption>
        </Reveal>
      </Section>

      {/* The Problem */}
      <Section>
        <SectionHeader align="center" eyebrow="The gap" title="The Gap Nobody's Filling" />
        <Reveal>
          <Card variant="gradient" padding="lg" glow>
            <p style={{ fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-relaxed)', color: 'var(--text-body)', marginBottom: 'var(--space-4)' }}>
              Every AI content tool today solves for <strong style={{ color: 'var(--text-primary)' }}>production volume</strong>.
            </p>
            <p style={{ fontSize: 'var(--text-lg)', lineHeight: 'var(--leading-relaxed)', color: 'var(--text-body)', marginBottom: 'var(--space-4)' }}>
              None solve for <strong style={{ color: 'var(--color-accent-text)' }}>compounding content intelligence</strong>, where the system gets measurably smarter and more commercially effective with every publish cycle.
            </p>
            <p style={{ fontSize: 'var(--text-h4)', fontWeight: 600, color: 'var(--color-positive-text)', margin: 0 }}>
              That's the gap. That's the product.
            </p>
          </Card>
        </Reveal>
      </Section>

      {/* Competitive Whitespace */}
      <Section>
        <SectionHeader align="center" eyebrow="Territory" title="What We Own" description={'Territory that\'s ours, not another "AI writing tool."'} />
        <div className="fi-grid-cards">
          {gaps.map((g, i) => (
            <Reveal key={g.title} delay={i * 60}>
              <FeatureCard icon={g.icon} title={g.title}>
                <p style={{ fontStyle: 'italic', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>{g.claim}</p>
                <p style={{ color: 'var(--text-body)' }}>{g.ours}</p>
              </FeatureCard>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Product Shot: Publishing */}
      <Section size="sm">
        <Reveal>
          <ScreenFrame url="forgeintelligence.ai/app/publishing" label="Publishing Queue">
            <img
              src="/2.png"
              alt="Publishing Queue content preview with hero image and multi-channel distribution"
              style={{ width: '100%', display: 'block' }}
            />
          </ScreenFrame>
          <Caption>Preview, edit post copy, and publish to LinkedIn, X, Facebook, WordPress, Webflow, or Ghost, with UTM intelligence built in.</Caption>
        </Reveal>
      </Section>

      {/* Who This Is For */}
      <Section>
        <SectionHeader align="center" eyebrow="Skeptics welcome" title="Built For Skeptics" description="We know what you're thinking. We thought it too." />
        <div className="fi-grid-cards">
          {personas.map((p, i) => (
            <Reveal key={p.name} delay={i * 60}>
              <Card padding="lg" interactive style={{ height: '100%' }}>
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{p.role}</div>
                </div>
                <p style={{ fontStyle: 'italic', color: 'var(--color-warn-text)', marginBottom: 'var(--space-3)', lineHeight: 'var(--leading-relaxed)' }}>"{p.pain}"</p>
                <p style={{ color: 'var(--color-positive-text)', lineHeight: 'var(--leading-relaxed)' }}>{p.outcome}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* 8-Stage Pipeline */}
      <Section id="pipeline">
        <SectionHeader align="center" eyebrow="The system" title="The 8-Stage Pipeline" description="From URL to revenue attribution in one connected system." />
        <Reveal>
          <Pipeline
            stages={stages.map((s) => ({ name: s.name, note: s.desc, icon: s.icon }))}
            activeIndex={stage}
            completedThrough={stage - 1}
            onSelect={setStage}
          />
        </Reveal>
      </Section>

      {/* Brand Intelligence */}
      <Section>
        <SectionHeader
          align="center"
          eyebrow="Board-ready"
          title="Brand Intelligence"
          description="Board-ready competitive intelligence across six dimensions, read from your competitors' live sites, not a survey."
        />
        <div className="fi-grid-cards">
          {intelDimensions.map((d, i) => (
            <Reveal key={d.name} delay={i * 60}>
              <FeatureCard icon={d.icon} title={d.name}>
                <p style={{ color: 'var(--text-body)' }}>{d.desc}</p>
              </FeatureCard>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', maxWidth: '60ch', margin: 'var(--space-6) auto 0', lineHeight: 'var(--leading-relaxed)' }}>
            Every read exports as a token-gated brief you can hand to your board, and runs through the same compliance gate as everything else Forge ships.
          </p>
        </Reveal>
      </Section>

      {/* One Brain, Every Format */}
      <Section>
        <SectionHeader
          align="center"
          eyebrow="One brain"
          title="One Brain, Every Format"
          description="The same intelligence layer that writes articles also builds campaigns, emails, ads, social, and video."
        />
        <div className="fi-grid-cards">
          {formats.map((f, i) => (
            <Reveal key={f.name} delay={i * 60}>
              <FeatureCard icon={f.icon} title={f.name} badge={<Badge tone="accent">{f.tag}</Badge>}>
                <p style={{ color: 'var(--text-body)' }}>{f.desc}</p>
              </FeatureCard>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* The Brain */}
      <Section id="method">
        <SectionHeader
          align="center"
          eyebrow="Compounding"
          title="The Brain: Your Unfair Advantage"
          description="Every publish teaches the system. Every edit sharpens the guardrails. Every pattern compounds."
        />
        <Reveal>
          <BrainTimeline
            animate
            entries={timeline.map((t) => ({ when: t.when, title: t.state, depth: t.depth }))}
          />
        </Reveal>
        <Reveal>
          <Card variant="quiet" padding="lg" style={{ textAlign: 'center', marginTop: 'var(--space-6)' }}>
            <p style={{ fontSize: 'var(--text-lg)', fontWeight: 500, fontStyle: 'italic', color: 'var(--text-primary)', margin: 0 }}>
              "After 90 days, your Client Brain is your biggest unfair advantage."
            </p>
          </Card>
        </Reveal>
      </Section>

      {/* What's Included */}
      <Section>
        <SectionHeader align="center" eyebrow="Included" title="What You Get" />
        <div className="fi-grid-checks">
          {included.map((f) => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', color: 'var(--text-body)', fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--color-positive-text)', display: 'flex', flexShrink: 0 }}>
                <Icon name="check" size={16} />
              </span>
              {f}
            </div>
          ))}
        </div>
      </Section>

      {/* Product Shot: GEO Opportunity Scores */}
      <Section size="sm">
        <Reveal>
          <ScreenFrame url="forgeintelligence.ai/app/geo-strategist" label="GEO Strategy">
            <img
              src="/3.png"
              alt="GEO Opportunity Scores: ChatGPT, Perplexity, AI Overviews, Gemini citation probability"
              style={{ width: '100%', display: 'block' }}
            />
          </ScreenFrame>
          <Caption>The Brain checks topic alignment before you spend a single token. 89% match, and it knows what mistakes to avoid.</Caption>
        </Reveal>
      </Section>

      {/* Pricing */}
      <Section>
        <SectionHeader align="center" eyebrow="Pricing" title="Pricing" />
        <div style={{ maxWidth: '380px', margin: '0 auto' }}>
          <PricingCard
            featured
            ribbon=""
            tier="SMB"
            price="$99"
            cadence="one-time · lifetime access"
            pitch="Full 8-stage pipeline plus every generator. One brand, forever."
            ctaLabel="Analyze my brand free"
            onCta={() => navigate('/')}
          />
        </div>
      </Section>

      {/* CTA */}
      <Section size="sm">
        <CTABand
          eyebrow="Free analysis"
          title="See your brand understood in 7 minutes."
          subtitle="No account needed. Free analysis. Then decide."
          actions={
            <Button variant="primary" size="lg" trailingIcon="arrow-right" onClick={() => navigate('/')}>
              Analyze my brand free
            </Button>
          }
        />
      </Section>
    </MarketingShell>
  );
}
