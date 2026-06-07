// LLM client + prompt helpers, extracted from server.js during the decomposition.
// `anthropic` is the shared Claude client (20-minute timeout for long-form
// generations). dateContext anchors prompts to "today" so models don't drift to
// their training-cutoff year.
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 1200000 }); // 20min

export function dateContext() {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
  const isoDate = now.toISOString().slice(0, 10);
  const year = now.getFullYear();
  return `TODAY IS ${formatted} (ISO: ${isoDate}). The current year is ${year}. ` +
    `When you reference dates, time periods, or 'recent' events, anchor them to this date — ` +
    `do not assume an earlier year. If you write phrases like 'in ${year - 1}' or 'this year', ` +
    `they must be accurate against ${year}, not your training cutoff.`;
}
