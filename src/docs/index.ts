// Doc registry — every entry here renders at /docs/<slug>. To add a new
// doc, drop a .md file into src/docs/ and append a new row below. The
// `?raw` Vite query inlines the file content at build time so docs ship
// with the bundle (no runtime fetch).
//
// `category` groups entries in the sidebar. Keep category names short.

import myWebsiteMd from './my-website.md?raw';

export type DocCategory = 'Integrations' | 'Concepts' | 'Reference';

export interface Doc {
  slug: string;
  title: string;
  description: string;
  category: DocCategory;
  content: string;
}

export const docs: Doc[] = [
  {
    slug: 'my-website',
    title: 'My Website',
    description: 'Publish Forge articles to your own self-hosted site via authenticated webhook.',
    category: 'Integrations',
    content: myWebsiteMd,
  },
];

export const docBySlug = (slug: string): Doc | undefined =>
  docs.find(d => d.slug === slug);

export const docsByCategory = (): Record<DocCategory, Doc[]> => {
  const out: Record<DocCategory, Doc[]> = { Integrations: [], Concepts: [], Reference: [] };
  for (const d of docs) out[d.category].push(d);
  return out;
};
