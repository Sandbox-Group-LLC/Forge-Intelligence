// Deploy partner config — swap the vibe-coding partner via VITE_DEPLOY_PARTNER
// without touching component code. Each partner entry drives the display copy
// on the "Deploy This Brain" card and points the button at the partner's
// prompt-pack endpoint. Adding a new partner = adding an entry below + a
// matching server endpoint at /api/forge/prompt-pack/<key>.

export interface DeployPartner {
  key: string;
  name: string;
  endpoint: string;
  homepageUrl: string;
  tooltip: string;
  ctaLabel: string;
}

const partners: Record<string, DeployPartner> = {
  lovable: {
    key: 'lovable',
    name: 'Lovable',
    endpoint: '/api/forge/prompt-pack/lovable',
    homepageUrl: 'https://lovable.dev/',
    tooltip: 'Opens Lovable in a new tab with this Brand Brain pre-loaded. On first use, Lovable will ask you to sign in — your prompt is preserved and building starts automatically after auth.',
    ctaLabel: 'Build with Lovable',
  },
  bolt: {
    key: 'bolt',
    name: 'Bolt',
    endpoint: '/api/forge/prompt-pack/bolt',
    homepageUrl: 'https://bolt.new/',
    tooltip: 'Opens Bolt in a new tab with this Brand Brain pre-loaded. On first use, Bolt will ask you to sign in — your prompt is preserved and building starts automatically after auth.',
    ctaLabel: 'Build with Bolt',
  },
};

const partnerKey = (import.meta.env.VITE_DEPLOY_PARTNER as string | undefined) || 'lovable';
export const activePartner: DeployPartner = partners[partnerKey] || partners.lovable;
