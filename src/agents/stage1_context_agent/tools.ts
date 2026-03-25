/**
 * Context Agent tool definitions.
 * Plain objects — no Anthropic SDK type imports needed.
 * Compatible with all @anthropic-ai/sdk versions.
 */

export const contextAgentTools = [
  {
    name: 'scrape_domain',
    description: 'Crawls the brand website to extract implicit voice signals, vocabulary, tone patterns, value props, and structural content signals.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to scrape.' },
        depth: { type: 'number', description: 'Crawl depth. Default: 1.' }
      },
      required: ['url']
    }
  },
  {
    name: 'scrape_reviews',
    description: 'Fetches third-party voice signals from G2, Glassdoor, Reddit, and Trustpilot.',
    input_schema: {
      type: 'object',
      properties: {
        brand_name: { type: 'string', description: 'The brand name to search reviews for.' }
      },
      required: ['brand_name']
    }
  },
  {
    name: 'scrape_competitors',
    description: 'Analyzes competitor websites to map topical coverage and identify content gaps.',
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of competitor URLs to analyze.'
        }
      },
      required: ['urls']
    }
  },
  {
    name: 'query_brain',
    description: 'MANDATORY FIRST CALL. Reads the Client Brain Patterns and Mistakes tables.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        table: {
          type: 'string',
          enum: ['memories', 'patterns', 'mistakes', 'agent_coordination']
        }
      },
      required: ['client_id', 'table']
    }
  },
  {
    name: 'write_to_brain',
    description: 'Commits the completed Brand Intelligence Profile to NeonDB.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        data_payload: { type: 'object' }
      },
      required: ['client_id', 'data_payload']
    }
  }
] as const;
