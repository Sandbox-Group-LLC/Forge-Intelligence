import { useEffect } from 'react';

const DiamondIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 22 12 12 22 2 12" />
  </svg>
);

const ArrowLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </svg>
);

type Faq = { q: string; a: string };
type Section = { title: string; eyebrow: string; faqs: Faq[] };

const SECTIONS: Section[] = [
  {
    eyebrow: 'Define the category',
    title: 'What it is',
    faqs: [
      {
        q: "What's the difference between AI content generation and AI content intelligence?",
        a: "AI content generation produces output. AI content intelligence builds the strategic worldview that makes the output worth producing. Generation tools take a prompt and write an article. Intelligence systems extract competitive gaps, audience blind spots, and topical whitespace first — then condition every word against that worldview. Forge inverts the order: intelligence is upstream of generation."
      },
      {
        q: "What is a Context Agent Architecture?",
        a: "A Context Agent Architecture is a sequenced system of specialized AI agents where each stage conditions the next. Forge's pipeline runs eight: Context Hub, GEO Strategist, Authenticity Enricher, Content Generator, Compliance Gate, Publishing Queue, Performance Dashboard, and Brain Memory. By stage four, the model isn't writing from a prompt. It's writing from a fully constructed competitive worldview."
      },
      {
        q: "What is Generative Engine Optimization (GEO) and how is it different from SEO?",
        a: "GEO optimizes content to be cited by AI engines like ChatGPT, Perplexity, and Gemini. SEO optimizes content to rank in search results. Different inputs, different ranking signals, different success metrics. SEO rewards keyword authority and backlinks. GEO rewards distinctive concepts, named frameworks, and citeable definitions that AI engines can attribute back to you. Same goal — visibility — different game."
      },
      {
        q: "What is Voice of Market and how is it different from Share of Voice?",
        a: "Share of Voice measures how often your brand shows up versus competitors. It's a backward-looking scoreboard. Voice of Market measures the unspoken market tension no competitor has named yet — the strategic angle that hasn't been claimed. Share of voice tells you where you stand. Voice of market tells you where to attack. One is a metric. The other is an advantage."
      },
      {
        q: "What does \"compounding\" mean in B2B content operations?",
        a: "Compounding content operations get smarter every cycle. Performance data writes back into strategy. Patterns that worked become reusable templates. Mistakes get flagged and avoided. The system never starts from scratch. The brand brain grows. Every published article makes the next one easier to brief, faster to write, and more likely to convert. Most teams never achieve this loop."
      },
      {
        q: "What does it mean for an AI content tool to be stateful?",
        a: "A stateful AI content tool remembers everything across sessions: brand voice rules, founder facts, competitive positioning, what content converted, what failed. That memory conditions every new generation. Most AI tools are stateless — each session is a fresh prompt with no history. Stateful systems compound. Stateless ones repeat themselves. The difference shows up at month three."
      },
      {
        q: "What is brand brain memory in an AI content system?",
        a: "Brand brain memory is the persistent intelligence layer that stores everything an AI content system has ever learned about a brand: voice rules, founder facts, positioning claims, performance patterns, competitive context. It's loaded into every generation as conditioning. Without it, the system restarts from zero each session. With it, every cycle compounds. The brain is the moat — not the model."
      },
      {
        q: "What is a citation heat map?",
        a: "A citation heat map is a per-section, per-FAQ view of where AI engines actually pull from in your content corpus. It distinguishes prose authority — when engines cite specific paragraphs — from domain authority, when they cite the URL without quoting. It also surfaces FAQ ROI: which questions actually get picked up as AI answers and which ones engines ignore."
      }
    ]
  },
  {
    eyebrow: 'Reframe the incumbents',
    title: "What it isn't",
    faqs: [
      {
        q: "Why do AI content tools get worse the longer you use them?",
        a: "Most don't get worse — they stay exactly the same. Every AI content tool is stateless. Each session starts from zero, with no memory of what worked, what failed, or what your competitive position looked like last quarter. Output gets repetitive because there's no compounding learning. Forge inverts that entirely with a persistent brand brain that writes back after every cycle."
      },
      {
        q: "Why does AI content sound generic even when the brief is good?",
        a: "Briefs describe topics. They don't capture the competitive worldview required to write content that differentiates. A brief tells the model what to write about. It doesn't tell the model what your competitors are weak on, where you have right-to-win, or which angles only you can defend. Without that context, even the best models produce content that any competitor could have written."
      },
      {
        q: "Why isn't faster content faster ROI?",
        a: "Content velocity only compounds when each piece adds intelligence to the next. Volume without intelligence produces faster mediocrity, not faster results. Ten articles that don't differentiate your positioning cost more than two that do — they consume editorial bandwidth, fragment topical authority, and train your audience to ignore you. Speed is a feature only after intelligence is solved."
      },
      {
        q: "What's the difference between AI content tools and AI content infrastructure?",
        a: "A tool executes prompts. Infrastructure compounds intelligence across cycles. Tools are bought to solve a specific task: write a blog post, summarize a transcript, draft a social caption. Infrastructure is bought to build a long-term capability: persistent brand memory, competitive intelligence, performance feedback, and topical authority that grows every quarter. Different purchase decision. Different outcomes. Different commercial relationship."
      },
      {
        q: "What's the limit of agentic AI in content marketing?",
        a: "Agents fail without state. Most agentic AI in content marketing chains together prompts but loses everything between sessions — every agent restarts the conversation. That's not autonomy, that's amnesia. Real agentic content systems require persistent memory: brand context, competitive intelligence, performance history. Without that scaffolding, agents produce coordinated mediocrity faster than humans can review it."
      },
      {
        q: "What's the difference between content marketing and content intelligence operations?",
        a: "Content marketing executes the plan. Content intelligence operations decides the plan. Marketing teams produce calendars, ship articles, and measure traffic. Intelligence operations runs upstream: scoping competitive gaps, identifying audience blind spots, mapping topical authority whitespace, deciding what content to ship and what to skip. Most companies have content marketing. Almost none have content intelligence. That gap is where the moat sits."
      },
      {
        q: "Why does most AI-generated B2B content get ignored by AI engines?",
        a: "AI engines cite content with distinctive concepts, named frameworks, and original definitions — content the engine can attribute back to a specific source. Most AI-generated B2B content has none of that. It paraphrases the same topics every competitor covers, with no original framework worth quoting. The fix isn't better prompts. It's a competitive worldview before generation, so the output contains things only your brand could have said."
      }
    ]
  },
  {
    eyebrow: 'How to think about it',
    title: 'How it works',
    faqs: [
      {
        q: "Why is the brief more important than the model in B2B content?",
        a: "Models converge. Briefs differentiate. Claude, GPT-4, and Gemini all produce competent prose from a strong brief. None of them can compensate for a brief that lacks competitive context, audience specificity, or strategic angle. The intelligence is upstream of generation. A weak brief with the best model in the world still produces forgettable content. A strong brief makes any modern model look brilliant."
      },
      {
        q: "How do you measure ROI of AI content beyond cost-per-article?",
        a: "Cost-per-article is the wrong unit. The right metrics: AI citation rate (how often engines cite your content), cited section breakdown (which sections get pulled), pipeline contribution per article, and competitive gap closure. A $200 article that gets cited weekly by ChatGPT for a high-intent query is worth more than 50 articles that fade into the volume noise. Measure outcomes, not output."
      },
      {
        q: "When should you NOT use AI content generation?",
        a: "When you don't have a competitive worldview to write from. AI content generation amplifies whatever you feed it — including the absence of strategy. Without competitive intelligence, audience clarity, and a defensible positioning angle, generated content sounds exactly like every competitor's generated content. The right move is to invest in intelligence first. Faster mediocrity isn't a win."
      },
      {
        q: "Why don't AI content tools learn from the content that converted?",
        a: "Most don't have a feedback loop. They generate content, hand it off, and forget. Performance data lives in analytics tools that the content system never reads. So the same patterns that failed get tried again. The same titles that flopped get rewritten. Forge closes that loop: engagement and citation data write back into the brain, conditioning every future generation."
      },
      {
        q: "How should mid-market B2B teams structure briefs for AI content generation?",
        a: "The order matters. Competitive intelligence first — what gaps exist, where you have right-to-win. Topical territory second — what conversations you can claim that competitors can't. Voice rules third — how your brand sounds, what it never says. Topic and angle last. Most teams flip this: they start with the topic and bolt on context. The result is generic content with brand paint."
      }
    ]
  }
];

export default function Faq() {
  // Smooth-scroll if URL has a hash
  useEffect(() => {
    if (window.location.hash) {
      const el = document.getElementById(window.location.hash.slice(1));
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, []);

  // Slugify question for anchor IDs
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  return (
    <div style={styles.root}>
      <div style={styles.gridOverlay} />
      <div style={styles.container}>
        <a href="/" style={styles.wordmarkLink}>
          <div style={styles.wordmark}>
            <div style={styles.diamondWrap}><DiamondIcon /></div>
            <span style={styles.wordmarkText}>Forge Intelligence</span>
          </div>
        </a>

        <header style={styles.header}>
          <p style={styles.eyebrow}>FAQ</p>
          <h1 style={styles.headline}>Questions about AI content. Answered with conviction.</h1>
          <p style={styles.subline}>
            Most AI content tools are stateless. Most AI content writing sounds the same. Most measurement
            metrics miss what AI engines actually reward. Twenty answers to the questions content leaders
            should be asking.
          </p>
        </header>

        {SECTIONS.map((section, idx) => (
          <section key={idx} style={styles.section}>
            <div style={styles.sectionHeader}>
              <p style={styles.sectionEyebrow}>{section.eyebrow}</p>
              <h2 style={styles.sectionTitle}>{section.title}</h2>
            </div>
            <div style={styles.faqList}>
              {section.faqs.map((faq, fi) => {
                const id = slugify(faq.q);
                return (
                  <article key={fi} id={id} style={styles.faqItem}>
                    <h3 style={styles.question}>
                      <a href={`#${id}`} style={styles.questionAnchor}>{faq.q}</a>
                    </h3>
                    <p style={styles.answer}>{faq.a}</p>
                  </article>
                );
              })}
            </div>
          </section>
        ))}

        <footer style={styles.footer}>
          <a href="/" style={styles.footerBack}>
            <ArrowLeftIcon />
            <span>Back to Forge Intelligence</span>
          </a>
          <div style={styles.footerLinks}>
            <a href="/product" style={styles.footerLink}>Product</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/articles/forgeintelligence-ai" style={styles.footerLink}>Articles</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/privacy" style={styles.footerLink}>Privacy</a>
            <span style={styles.footerDivider}>·</span>
            <a href="/terms" style={styles.footerLink}>Terms</a>
          </div>
        </footer>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    backgroundColor: '#0B0F1A',
    backgroundImage: 'radial-gradient(circle at top left, rgba(53,99,255,0.22), transparent 55%), radial-gradient(circle at bottom right, rgba(20,184,166,0.12), transparent 55%)',
    backgroundSize: '100% 100%, 100% 100%',
    backgroundAttachment: 'fixed',
    color: '#F8FAFC',
    fontFamily: "Inter, 'Geist', system-ui, -apple-system, sans-serif",
    position: 'relative',
    overflow: 'hidden',
  },
  gridOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
    backgroundSize: '48px 48px',
    pointerEvents: 'none',
    zIndex: 0,
  },
  container: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: '760px',
    margin: '0 auto',
    padding: '48px 24px 96px',
    display: 'flex',
    flexDirection: 'column',
    gap: '64px',
  },
  wordmarkLink: { textDecoration: 'none' },
  wordmark: { display: 'flex', alignItems: 'center', gap: '10px', color: '#F8FAFC' },
  diamondWrap: { display: 'flex', alignItems: 'center', color: '#3563FF' },
  wordmarkText: { fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em' },
  header: { display: 'flex', flexDirection: 'column', gap: '16px' },
  eyebrow: { fontSize: '11px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#3563FF', margin: 0 },
  headline: { fontSize: 'clamp(28px, 5vw, 42px)', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em', color: '#F8FAFC', margin: 0 },
  subline: { fontSize: '16px', lineHeight: 1.7, color: '#94A3B8', margin: 0, maxWidth: '620px' },
  section: { display: 'flex', flexDirection: 'column', gap: '24px' },
  sectionHeader: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    paddingBottom: '16px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  sectionEyebrow: { fontSize: '11px', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#14B8A6', margin: 0 },
  sectionTitle: { fontSize: '22px', fontWeight: 600, color: '#F8FAFC', margin: 0, letterSpacing: '-0.01em' },
  faqList: { display: 'flex', flexDirection: 'column', gap: '32px' },
  faqItem: { display: 'flex', flexDirection: 'column', gap: '10px', scrollMarginTop: '24px' },
  question: { fontSize: '18px', fontWeight: 600, color: '#F8FAFC', margin: 0, lineHeight: 1.4, letterSpacing: '-0.005em' },
  questionAnchor: { color: 'inherit', textDecoration: 'none' },
  answer: { fontSize: '15px', lineHeight: 1.75, color: '#CBD5E1', margin: 0 },
  footer: {
    display: 'flex', flexDirection: 'column', gap: '20px',
    paddingTop: '32px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  footerBack: {
    display: 'inline-flex', alignItems: 'center', gap: '8px',
    color: '#3563FF', textDecoration: 'none', fontSize: '14px', fontWeight: 500,
    width: 'fit-content',
  },
  footerLinks: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '12px', color: '#475569' },
  footerDivider: { color: '#334155' },
  footerLink: { color: '#475569', textDecoration: 'none' },
};
