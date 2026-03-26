import { v4 as uuidv4 } from 'uuid';

/**
 * Brand Seeding Script — Top 20 Highest Content Distribution Brands 2026
 * Run: npx ts-node scripts/seed-brand-brains.ts
 * Builds brand brains proactively before clients sign up.
 */

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:10000';

const TARGET_BRANDS = [
  {
    url: 'https://hubspot.com',
    competitors: ['salesforce.com', 'marketo.com', 'activecampaign.com']
  },
  {
    url: 'https://canva.com',
    competitors: ['adobe.com', 'figma.com', 'visme.co']
  },
  {
    url: 'https://shopify.com',
    competitors: ['bigcommerce.com', 'woocommerce.com', 'squarespace.com']
  },
  {
    url: 'https://notion.so',
    competitors: ['confluence.atlassian.com', 'coda.io', 'airtable.com']
  },
  {
    url: 'https://zapier.com',
    competitors: ['make.com', 'n8n.io', 'workato.com']
  },
  {
    url: 'https://semrush.com',
    competitors: ['ahrefs.com', 'moz.com', 'similarweb.com']
  },
  {
    url: 'https://gong.io',
    competitors: ['chorus.ai', 'salesloft.com', 'outreach.io']
  },
  {
    url: 'https://drift.com',
    competitors: ['intercom.com', 'hubspot.com', 'qualified.com']
  },
  {
    url: 'https://apollo.io',
    competitors: ['zoominfo.com', 'outreach.io', 'salesloft.com']
  },
  {
    url: 'https://clickup.com',
    competitors: ['asana.com', 'monday.com', 'linear.app']
  },
  {
    url: 'https://webflow.com',
    competitors: ['framer.com', 'squarespace.com', 'wix.com']
  },
  {
    url: 'https://loom.com',
    competitors: ['vidyard.com', 'wistia.com', 'screencastify.com']
  },
  {
    url: 'https://figma.com',
    competitors: ['sketch.com', 'adobe.com', 'invisionapp.com']
  },
  {
    url: 'https://stripe.com',
    competitors: ['braintreepayments.com', 'square.com', 'adyen.com']
  },
  {
    url: 'https://linear.app',
    competitors: ['jira.atlassian.com', 'asana.com', 'height.app']
  },
  {
    url: 'https://intercom.com',
    competitors: ['zendesk.com', 'freshdesk.com', 'drift.com']
  },
  {
    url: 'https://ahrefs.com',
    competitors: ['semrush.com', 'moz.com', 'surfer-seo.com']
  },
  {
    url: 'https://clearbit.com',
    competitors: ['zoominfo.com', 'apollo.io', 'lusha.com']
  },
  {
    url: 'https://lattice.com',
    competitors: ['15five.com', 'culture-amp.com', 'workday.com']
  },
  {
    url: 'https://lottiefiles.com',
    competitors: ['rive.app', 'haiku.ai', 'airbnb.io']
  }
];

async function seedBrand(url: string, competitors: string[], index: number) {
  const clientId = uuidv4();
  console.log(`[${index + 1}/20] Seeding: ${url} → clientId: ${clientId}`);

  try {
    const res = await fetch(`${BASE_URL}/api/v1/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, url, competitors })
    });

    const data = await res.json();

    if (data.brandProfileId && data.brandProfileId !== 'unknown') {
      console.log(`  ✅ ${url} — brandProfileId: ${data.brandProfileId} | cached: ${data.cached}`);
    } else {
      console.warn(`  ⚠️  ${url} — no profileId returned:`, JSON.stringify(data).slice(0, 120));
    }
  } catch (err: any) {
    console.error(`  ❌ ${url} — failed: ${err.message}`);
  }

  // Throttle: 3 second delay between calls to avoid rate limits
  await new Promise(r => setTimeout(r, 3000));
}

async function main() {
  console.log('🧠 Forge Brain Seeder — Top 20 Content Brands 2026');
  console.log(`📡 Targeting: ${BASE_URL}\n`);

  for (let i = 0; i < TARGET_BRANDS.length; i++) {
    const { url, competitors } = TARGET_BRANDS[i];
    await seedBrand(url, competitors, i);
  }

  console.log('\n✅ Seeding complete. All brand brains queued in Neon.');
}

main().catch(console.error);
