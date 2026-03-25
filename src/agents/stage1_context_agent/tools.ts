import Anthropic from '@anthropic-ai/sdk';

/**
 * Tool definitions for Context Agent (Claude tool_use format)
 * These are passed to the Anthropic API as available tools.
 */
export const contextAgentTools: Anthropic.Tool[] = [
  {
    name: 'scrape_domain',
    description: 'Crawls the brand website to extract implicit voice signals, vocabulary, tone patterns, value props, and structural content signals. Do NOT summarize what the brand says about itself — extract HOW they actually write.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The full URL to scrape.' },
        depth: { type: 'number', description: 'Crawl depth. Default: 1.' }
      },
      required: ['url']
    }
  },
  {
    name: 'scrape_reviews',
    description: 'Fetches third-party voice signals from G2, Glassdoor, Reddit, and Trustpilot for a brand. Returns customer power phrases, objection patterns, and friction points.',
    input_schema: {
      type: 'object' as const,
      properties: {
        brand_name: { type: 'string', description: 'The brand name to search reviews for.' }
      },
      required: ['brand_name']
    }
  },
  {
    name: 'scrape_competitors',
    description: 'Analyzes competitor websites to map topical coverage and identify content gaps the client can own.',
    input_schema: {
      type: 'object' as const,
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
    description: 'MANDATORY FIRST CALL. Reads the Client Brain before any external scraping. Queries Patterns and Mistakes tables to understand what has worked and failed in this industry.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_id: { type: 'string', description: 'The unique client identifier.' },
        table: {
          type: 'string',
          enum: ['memories', 'patterns', 'mistakes', 'agent_coordination'],
          description: 'Which Brain table to query.'
        }
      },
      required: ['client_id', 'table']
    }
  },
  {
    name: 'write_to_brain',
    description: 'Commits the completed Brand Intelligence Profile to the Client Brain (brand_profiles table) and writes new patterns observed during extraction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_id: { type: 'string' },
        data_payload: {
          type: 'object',
          description: 'The structured JSON payload to write. Must include voice_profile, personas, third_party_signals, competitive_gaps.'
        }
      },
      required: ['client_id', 'data_payload']
    }
  }
];
