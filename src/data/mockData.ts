import { BrandProfile, HistoryEntry, ProcessingStage } from '../types';

export const mockBrandProfile: BrandProfile = {
  id: 'bp_forge_001',
  brandUrl: 'https://forge-bysandbox.tech',
  brandName: 'Forge Intelligence',
  createdAt: '2024-01-15T10:30:00Z',
  updatedAt: '2024-01-15T14:45:00Z',
  version: 3,
  isActive: true,
  cacheStatus: 'fresh',
  voiceProfile: {
    summary: 'Forge Intelligence communicates with confident expertise, balancing technical depth with accessible clarity. The brand voice is strategic and forward-thinking, positioning itself as a trusted partner rather than a vendor. There is an emphasis on substance over hype, with measured confidence that avoids both corporate stiffness and startup casualness.',
    toneAttributes: [
      { attribute: 'Confidence', score: 85, description: 'Assertive without arrogance, grounded in demonstrated capability' },
      { attribute: 'Clarity', score: 92, description: 'Complex concepts made accessible without oversimplification' },
      { attribute: 'Strategic', score: 88, description: 'Focus on outcomes and business impact over features' },
      { attribute: 'Human', score: 78, description: 'Professional warmth, avoids robotic corporate-speak' },
      { attribute: 'Technical', score: 72, description: 'Demonstrates depth when relevant, never gratuitously complex' }
    ],
    writingStyle: 'Direct and purposeful. Favors active voice and concrete examples. Paragraphs are concise but not clipped. Uses strategic white space and clear hierarchies. Avoids jargon unless the audience expects it.',
    keyPhrases: [
      'Brand intelligence',
      'Context-aware',
      'Strategic clarity',
      'Market positioning',
      'Signal synthesis',
      'Actionable insights'
    ]
  },
  personas: [
    {
      id: 'persona_001',
      name: 'Strategic Sarah',
      role: 'VP of Marketing at a Series B SaaS',
      painPoints: [
        'Spending too much time on manual competitive research',
        'Struggling to maintain brand consistency across channels',
        'Difficulty articulating differentiation to the board'
      ],
      triggers: [
        'Competitor launches a new positioning',
        'Quarterly planning cycles',
        'New market entry discussions'
      ],
      skepticism: 'Has been burned by AI tools that promise automation but deliver noise. Needs to see structured, actionable output before trusting the system.',
      motivations: [
        'Wants to be seen as strategically valuable, not just tactical',
        'Needs to move faster without sacrificing quality',
        'Values tools that make her team look smart'
      ]
    },
    {
      id: 'persona_002',
      name: 'Founder Frank',
      role: 'CEO/Founder at an early-stage startup',
      painPoints: [
        'No dedicated marketing team yet',
        'Wearing too many hats to do deep brand work',
        'Inconsistent messaging across pitch deck, website, and sales'
      ],
      triggers: [
        'Preparing for fundraise',
        'Launching a new product',
        'Onboarding first marketing hire'
      ],
      skepticism: 'Skeptical of anything that feels like busywork or produces generic output. Wants something that feels like having a CMO on call.',
      motivations: [
        'Needs to punch above his weight class',
        'Values speed and decisive action',
        'Wants a competitive edge without enterprise budgets'
      ]
    },
    {
      id: 'persona_003',
      name: 'Agency Alex',
      role: 'Strategy Director at a boutique agency',
      painPoints: [
        'Research phase takes too long on new client engagements',
        'Difficulty scaling strategic work across multiple clients',
        'Junior team members lack context for quality output'
      ],
      triggers: [
        'New client onboarding',
        'Competitive pitch situations',
        'Annual brand audits'
      ],
      skepticism: 'Worried about AI tools that could commoditize strategic work. Needs to see it as an augmentation, not replacement.',
      motivations: [
        'Wants to deliver more value in less time',
        'Needs to differentiate from competitors using same tools',
        'Values depth and nuance over surface-level analysis'
      ]
    }
  ],
  thirdPartySignals: [
    { source: 'G2', signalType: 'Reviews', value: null, confidence: 0, lastChecked: '2024-01-15T14:00:00Z' },
    { source: 'LinkedIn', signalType: 'Company Size', value: '11-50 employees', confidence: 85, lastChecked: '2024-01-15T14:00:00Z' },
    { source: 'Crunchbase', signalType: 'Funding', value: null, confidence: 0, lastChecked: '2024-01-15T14:00:00Z' },
    { source: 'Twitter/X', signalType: 'Follower Count', value: '2,340', confidence: 90, lastChecked: '2024-01-15T14:00:00Z' },
    { source: 'SimilarWeb', signalType: 'Monthly Traffic', value: '~15K visits', confidence: 75, lastChecked: '2024-01-15T14:00:00Z' }
  ],
  competitiveGaps: [
    {
      topic: 'AI-powered brand voice analysis',
      ownedBy: null,
      whitespaceOpportunity: 'No competitor has a dedicated voice profiling feature. Most focus on content generation, not brand understanding.',
      priority: 'high'
    },
    {
      topic: 'Competitive intelligence automation',
      ownedBy: 'Crayon, Klue',
      whitespaceOpportunity: 'Existing players focus on sales enablement. Opportunity to own the marketing strategy angle.',
      priority: 'medium'
    },
    {
      topic: 'Persona development at scale',
      ownedBy: null,
      whitespaceOpportunity: 'Current tools are manual workshops or generic templates. AI-assisted persona synthesis is wide open.',
      priority: 'high'
    },
    {
      topic: 'Brand memory/context persistence',
      ownedBy: null,
      whitespaceOpportunity: 'Most AI tools are stateless. A persistent brand context layer is a significant differentiator.',
      priority: 'high'
    }
  ],
  strategicRecommendations: [
    {
      id: 'rec_001',
      category: 'Positioning',
      title: 'Lead with "Brand Intelligence" category creation',
      description: 'Rather than competing in crowded "AI marketing" or "content generation" categories, establish "Brand Intelligence" as a new category that Forge defines and owns.',
      impact: 'high',
      effort: 'medium'
    },
    {
      id: 'rec_002',
      category: 'Messaging',
      title: 'Emphasize "context" over "content"',
      description: 'Differentiate from AI writing tools by focusing on understanding and strategy rather than output generation. Position as the thinking layer that makes all content better.',
      impact: 'high',
      effort: 'low'
    },
    {
      id: 'rec_003',
      category: 'Content',
      title: 'Develop thought leadership on brand consistency at scale',
      description: 'Create a content series exploring how brands lose coherence as they scale, and how persistent brand context solves this. Target VP/Director level marketers.',
      impact: 'medium',
      effort: 'medium'
    },
    {
      id: 'rec_004',
      category: 'Product',
      title: 'Surface "Brain" as a visible product feature',
      description: 'Make the persistent memory layer a first-class feature rather than invisible infrastructure. Users should see and trust the context being retained.',
      impact: 'high',
      effort: 'high'
    }
  ]
};

export const mockHistoryEntries: HistoryEntry[] = [
  {
    id: 'bp_forge_001',
    brandUrl: 'https://forge-bysandbox.tech',
    brandName: 'Forge Intelligence',
    timestamp: '2024-01-15T14:45:00Z',
    version: 3,
    isActive: true,
    isCached: false
  },
  {
    id: 'bp_forge_002',
    brandUrl: 'https://forge-bysandbox.tech',
    brandName: 'Forge Intelligence',
    timestamp: '2024-01-14T09:30:00Z',
    version: 2,
    isActive: false,
    isCached: true
  },
  {
    id: 'bp_forge_003',
    brandUrl: 'https://forge-bysandbox.tech',
    brandName: 'Forge Intelligence',
    timestamp: '2024-01-10T16:20:00Z',
    version: 1,
    isActive: false,
    isCached: true
  }
];

export const initialProcessingStages: ProcessingStage[] = [
  { id: 'ingest', name: 'Ingesting signals', status: 'pending' },
  { id: 'brain', name: 'Checking Brain / cache', status: 'pending' },
  { id: 'scrape', name: 'Scraping site and competitors', status: 'pending' },
  { id: 'synthesize', name: 'Synthesizing profile', status: 'pending' },
  { id: 'save', name: 'Saving to Brain', status: 'pending' }
];

export const sampleAnalysisInput = {
  brandUrl: 'https://forge-bysandbox.tech',
  competitorUrls: ['https://jasper.ai', 'https://copy.ai', 'https://writer.com'],
  audienceNotes: 'Modern 360 marketers at mid-market SaaS companies. They juggle strategy and execution. They value efficiency but not at the cost of quality. They have been disappointed by generic AI tools.',
  strategicNotes: 'Focus on positioning as a strategic partner, not a content mill. Emphasize the intelligence and context layer over raw generation capabilities.',
  checkBrainFirst: true,
  saveToBrain: true
};
