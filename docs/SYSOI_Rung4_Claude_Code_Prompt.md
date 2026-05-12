# SYSOI Rung 4: Revenue Proof
## Claude Code Implementation Prompt

---

## Context

You are building **Rung 4 of the SYSOI rung ladder**. SYSOI is a multi-tenant workspace intelligence platform for Series A revenue teams. It synthesizes signals from connected tools into a daily operational brief with standing issue tracking and confidence-tiered alerts.

**Rungs 1–3 are complete.** You have:
- Multi-tenant workspace isolation (`workspace_id NOT NULL` on every table)
- Auth context via `getCurrentWorkspaceId()` — throws on missing context, no fallback
- Daily brief engine producing `BriefItem[]` from `ExtractedInsight[]`
- Standing issue tracking with aging callouts
- Gmail, Google Calendar, Slack adapters (Rung 2)
- HubSpot adapter + EntityGraph with `entities` and `entity_relationships` tables (Rung 3)
- Nango OAuth for all provider connections via `source_connections` table
- `isTokenError()` utility for graceful provider degradation

**Existing integration pattern you must follow** (`server/integrations/base.ts`):
```typescript
export interface IIntegration {
  readonly provider: string;
  readonly readOnly: boolean; // Safety: ensure no write operations
  fetchRecent(): Promise<any[]>;
  isEnabled(): Promise<boolean>;
  testConnection(): Promise<boolean>;
}

export interface ExtractedInsight {
  type: 'insight' | 'alert' | 'action_item' | 'meeting_prep';
  title: string;
  description?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  needsReview: boolean;
  tags?: string[];
  source: IntegrationSource;
  action?: {
    label: string;
    type: 'draft_email' | 'open_link' | 'mark_done';
    payload?: string;
  };
}
```

Existing integration files follow a two-file pattern per provider:
- `server/integrations/{provider}-oauth.ts` — OAuth connection management
- `server/integrations/{provider}.ts` — data fetching and insight extraction

**Project stack:** TypeScript, Drizzle ORM, PostgreSQL (Neon), Express, Nango for OAuth, `p-map` for bounded concurrency.

---

## What Rung 4 Builds

Rung 4 adds **Revenue Proof** — provider-neutral billing-state truth from two adapters:

1. **Stripe** — structured invoice/subscription/charge/dispute data with `customer.email` for EntityGraph resolution
2. **QuickBooks Online** — invoice-level truth for the invoiced-ACH segment; customer email requires secondary enrichment

**Core principle: the signal engine is provider-agnostic.** Rule IDs contain zero provider names. `BriefItem` tags identify the provider for display. Adding Chargebee or Paddle later means writing a new adapter file — not touching any rule, any route, or any schema.

---

## DO NOT

- Do not add Stripe webhooks — polling is sufficient for MVP
- Do not build MRR/ARR dashboards or revenue analytics UI
- Do not implement the Contradiction Engine (Rung 5) — register `REVENUE_NO_INVOICE_POST_CLOSE` as a stub only
- Do not write to Stripe or QuickBooks — `readOnly: true` on both adapters
- Do not promote Plaid to billing-state truth — Plaid stays in its Rung 6 role
- Do not use `'anonymous'` or `'default'` as workspace fallback anywhere
- Do not import Stripe or QuickBooks types in rule evaluation logic
- Do not make rule IDs provider-specific (`STRIPE_PAYMENT_FAILED` is wrong; `REVENUE_PAYMENT_FAILED` is correct)

---

## File Structure to Create

```
server/
  integrations/
    stripe-oauth.ts          ← OAuth connection management for Stripe
    stripe.ts                ← Stripe data fetching + insight extraction
    quickbooks-oauth.ts      ← OAuth connection management for QuickBooks Online
    quickbooks.ts            ← QBO data fetching + insight extraction
  revenue/
    types.ts                 ← Provider-neutral types: RevenueObligation, RevenueMovement, etc.
    adapter.ts               ← RevenueAdapter interface
    rules.ts                 ← 8 provider-neutral revenue rules
    entity-resolver.ts       ← Resolve obligation customerDomain → EntityGraph entity
    brief-builder.ts         ← Build ExtractedInsight from RevenueObligation + rule
    sync.ts                  ← Sync pipeline: fetch → resolve → upsert → evaluate → emit
    adapters/
      stripe.ts              ← StripeAdapter implements RevenueAdapter
      quickbooks.ts          ← QuickBooksAdapter implements RevenueAdapter
shared/
  schema.ts                  ← ADD: revenue_obligations, revenue_movements tables
```

Do not modify `server/integrations/base.ts`. Extend it.

---

## Step 1: Schema (`shared/schema.ts`)

Add the following Drizzle table definitions. All tables require `workspace_id` with a foreign key reference. Apply `ON DELETE CASCADE`.

```typescript
// ADD to shared/schema.ts

export const revenueObligations = pgTable('revenue_obligations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  workspaceId:      uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  entityId:         uuid('entity_id').references(() => entities.id),
  sourceProvider:   text('source_provider').notNull(),         // 'stripe' | 'quickbooks'
  sourceRawId:      text('source_raw_id').notNull(),           // provider native ID
  status:           text('status').notNull(),                  // ObligationStatus
  amountCents:      integer('amount_cents').notNull(),
  currency:         text('currency').notNull().default('USD'),
  dueAt:            timestamp('due_at', { withTimezone: true }),
  issuedAt:         timestamp('issued_at', { withTimezone: true }),
  paidAt:           timestamp('paid_at', { withTimezone: true }),
  customerLabel:    text('customer_label').notNull(),
  customerEmail:    text('customer_email'),
  customerDomain:   text('customer_domain'),
  sourceDeepLink:   text('source_deep_link').notNull(),
  rawProviderData:  jsonb('raw_provider_data'),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqWorkspaceRawId: unique().on(table.workspaceId, table.sourceRawId),
  idxWorkspace:       index().on(table.workspaceId),
  idxEntity:          index().on(table.entityId),
  idxStatus:          index().on(table.workspaceId, table.status),
  idxDue:             index().on(table.workspaceId, table.dueAt),
}));

export const revenueMovements = pgTable('revenue_movements', {
  id:                uuid('id').primaryKey().defaultRandom(),
  workspaceId:       uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  obligationId:      uuid('obligation_id').references(() => revenueObligations.id),
  entityId:          uuid('entity_id').references(() => entities.id),
  sourceProvider:    text('source_provider').notNull(),
  sourceRawId:       text('source_raw_id').notNull(),
  movementType:      text('movement_type').notNull(),           // MovementType
  amountCents:       integer('amount_cents').notNull(),
  currency:          text('currency').notNull().default('USD'),
  occurredAt:        timestamp('occurred_at', { withTimezone: true }).notNull(),
  counterpartyLabel: text('counterparty_label'),
  rawDescription:    text('raw_description'),
  confidence:        text('confidence').notNull().default('HIGH'),
  sourceDeepLink:    text('source_deep_link').notNull(),
  rawProviderData:   jsonb('raw_provider_data'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqWorkspaceRawId: unique().on(table.workspaceId, table.sourceRawId),
  idxWorkspace:       index().on(table.workspaceId),
  idxObligation:      index().on(table.obligationId),
  idxOccurred:        index().on(table.workspaceId, table.occurredAt),
}));
```

After adding, run `npm run db:push` or the project's migration command.

---

## Step 2: Provider-Neutral Types (`server/revenue/types.ts`)

```typescript
export type RevenueProviderName = 'stripe' | 'quickbooks';

export type ObligationStatus =
  | 'open'           // issued, not yet due
  | 'paid'           // confirmed paid
  | 'failed'         // payment attempt failed
  | 'past_due'       // past due date, unpaid
  | 'canceled'       // subscription or invoice canceled
  | 'disputed'       // chargeback/dispute opened
  | 'uncollectible'  // written off after retries exhausted
  | 'unknown';       // provider returned ambiguous state

export type MovementType =
  | 'charge'         // successful payment collected
  | 'payout'         // funds sent to bank
  | 'refund'         // money returned to customer
  | 'dispute'        // chargeback withdrawal
  | 'fee'            // processor fee
  | 'adjustment';    // credit, proration, manual

export interface RevenueObligation {
  id: string;
  workspaceId: string;
  entityId?: string;
  sourceProvider: RevenueProviderName;
  sourceRawId: string;
  status: ObligationStatus;
  amountCents: number;
  currency: string;
  dueAt?: Date;
  issuedAt?: Date;
  paidAt?: Date;
  customerLabel: string;
  customerEmail?: string;
  customerDomain?: string;
  sourceDeepLink: string;
  rawProviderData: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RevenueMovement {
  id: string;
  workspaceId: string;
  obligationId?: string;
  entityId?: string;
  sourceProvider: RevenueProviderName;
  sourceRawId: string;
  movementType: MovementType;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  counterpartyLabel?: string;
  rawDescription?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  sourceDeepLink: string;
  rawProviderData: Record<string, unknown>;
  createdAt: Date;
}

export interface RevenueRuleConfig {
  largePaymentThresholdCents?: number; // default: 500000 ($5,000)
}
```

---

## Step 3: Adapter Interface (`server/revenue/adapter.ts`)

```typescript
import type { RevenueObligation, RevenueMovement, RevenueProviderName } from './types';

export interface RevenueAdapter {
  readonly provider: RevenueProviderName;

  fetchObligations(
    workspaceId: string,
    nangoConnId: string,
    since?: Date
  ): Promise<RevenueObligation[]>;

  fetchMovements(
    workspaceId: string,
    nangoConnId: string,
    since?: Date
  ): Promise<RevenueMovement[]>;

  // Extract email + domain for EntityGraph resolution
  resolveCustomerIdentity(rawCustomerData: unknown): {
    email?: string;
    domain?: string;
    label: string;
  };
}
```

---

## Step 4: Stripe Adapter (`server/revenue/adapters/stripe.ts`)

Implement `RevenueAdapter` for Stripe. Fetch via Nango proxy — **no direct Stripe SDK import**.

**Data to fetch:**
- `GET /v1/invoices` — paginate with `starting_after`, filter by `created[gte]` from `since`
- `GET /v1/subscriptions` — for subscription state (canceled, past_due)
- `GET /v1/charges` — for movement records (successful charges, refunds)
- `GET /v1/disputes` — for dispute/chargeback movements

**Status mapping:**
```
stripe invoice status → ObligationStatus
  'draft'           → 'open'
  'open'            → 'open'  (check due_date for past_due upgrade)
  'paid'            → 'paid'
  'uncollectible'   → 'uncollectible'
  'void'            → 'canceled'

stripe subscription status → ObligationStatus
  'active'          → 'paid'
  'past_due'        → 'past_due'
  'canceled'        → 'canceled'
  'unpaid'          → 'failed'
  'trialing'        → 'open'
```

**Past due detection:** if `invoice.status === 'open'` AND `invoice.due_date < Date.now() / 1000`, override status to `'past_due'`.

**Customer identity:**
```typescript
resolveCustomerIdentity(rawCustomer: any) {
  return {
    email: rawCustomer.email ?? undefined,
    domain: rawCustomer.email ? rawCustomer.email.split('@')[1] : undefined,
    label: rawCustomer.name || rawCustomer.email || rawCustomer.id
  };
}
```

**Deep links:**
- Invoice: `https://dashboard.stripe.com/invoices/{inv.id}`
- Subscription: `https://dashboard.stripe.com/subscriptions/{sub.id}`
- Dispute: `https://dashboard.stripe.com/disputes/{dispute.id}`

**Source raw ID format:** use the Stripe native ID as-is (`in_123`, `sub_456`, `ch_789`, `dp_012`).

---

## Step 5: QuickBooks Adapter (`server/revenue/adapters/quickbooks.ts`)

Implement `RevenueAdapter` for QuickBooks Online. Fetch via Nango proxy using the IDS Query API.

**Data to fetch:**
- Invoices via IDS Query: `SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '{sinceDate}' MAXRESULTS 500`
- Payments via IDS Query: `SELECT * FROM Payment WHERE MetaData.LastUpdatedTime > '{sinceDate}' MAXRESULTS 500`
- Customers via IDS Query (background enrichment only — see note below)

**Nango endpoint pattern for QBO:**
```
GET /v3/company/{realmId}/query?query=SELECT * FROM Invoice WHERE ...
```
The `realmId` is the QBO company ID stored in the Nango connection metadata. Retrieve it from `nango.getConnection('quickbooks', nangoConnId)`.

**Status mapping:**
```
QBO invoice → ObligationStatus
  Balance === 0                          → 'paid'
  Balance > 0 AND DueDate < today        → 'past_due'
  Balance > 0 AND DueDate >= today       → 'open'
  Balance > 0 AND no DueDate             → 'open'
```

**Amount mapping:** `invoice.TotalAmt * 100` (round to integer for cents). Currency from `invoice.CurrencyRef.value ?? 'USD'`.

**Customer email — background enrichment note:**  
QBO invoices carry `CustomerRef.name` and `CustomerRef.value` (the customer ID) but **do not embed email**. Email requires a secondary fetch: `SELECT * FROM Customer WHERE Id = '{customerId}'`. This must NOT block the main sync. Implement as a post-sync enrichment job:

```typescript
// After obligations are upserted, queue enrichment for obligations missing customerEmail
export async function enrichQBOCustomerEmails(
  workspaceId: string,
  nangoConnId: string,
  db: Database
): Promise<void> {
  const unenriched = await db.query.revenueObligations.findMany({
    where: and(
      eq(revenueObligations.workspaceId, workspaceId),
      eq(revenueObligations.sourceProvider, 'quickbooks'),
      isNull(revenueObligations.customerEmail)
    ),
    limit: 50
  });

  for (const obligation of unenriched) {
    // fetch customer by ID from rawProviderData.CustomerRef.value
    // backfill customerEmail and customerDomain
    // re-run resolveRevenueEntity
  }
}
```

**Source raw ID format:** `QBO-{invoice.Id}` (prefix prevents collision with Stripe IDs in workspace scope).

**Deep links:** `https://app.qbo.intuit.com/app/invoice?txnId={invoice.Id}`

**Customer identity (best-effort):**
```typescript
resolveCustomerIdentity(rawCustomer: any) {
  return {
    email: rawCustomer.PrimaryEmailAddr?.Address ?? undefined,
    domain: rawCustomer.PrimaryEmailAddr?.Address
      ? rawCustomer.PrimaryEmailAddr.Address.split('@')[1]
      : undefined,
    label: rawCustomer.DisplayName || rawCustomer.CompanyName || rawCustomer.Id
  };
}
```

---

## Step 6: Entity Resolver (`server/revenue/entity-resolver.ts`)

Resolve a `RevenueObligation` to an existing EntityGraph entity, or create a stub entity if none found.

```typescript
export async function resolveRevenueEntity(
  obligation: RevenueObligation,
  workspaceId: string,
  db: Database
): Promise<string | undefined> {
  if (!obligation.customerEmail && !obligation.customerDomain) return undefined;

  // 1. Exact email match
  if (obligation.customerEmail) {
    const match = await db.query.entities.findFirst({
      where: and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.primaryEmail, obligation.customerEmail)
      )
    });
    if (match) return match.id;
  }

  // 2. Domain match (company-level resolution — merges with HubSpot entity)
  if (obligation.customerDomain) {
    const match = await db.query.entities.findFirst({
      where: and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.domain, obligation.customerDomain)
      )
    });
    if (match) return match.id;
  }

  // 3. Create stub entity — will merge with HubSpot entity on next HubSpot sync
  //    if domain matches an existing HubSpot company
  const [newEntity] = await db.insert(entities).values({
    id: crypto.randomUUID(),
    workspaceId,
    type: 'company',
    domain: obligation.customerDomain ?? null,
    primaryEmail: obligation.customerEmail ?? null,
    label: obligation.customerLabel,
    sourceProviders: [obligation.sourceProvider],
    createdAt: new Date(),
    updatedAt: new Date()
  }).returning();

  return newEntity.id;
}
```

**Important:** Domain matching is intentional. A Stripe customer with email `cfo@acme.com` and a HubSpot contact for `sales@acme.com` should resolve to the same `acme.com` entity. If your `entities` table uses a different field name for domain, use that — do not rename the table column.

---

## Step 7: Revenue Rules (`server/revenue/rules.ts`)

Define all 8 rules. Rules are evaluated against `RevenueObligation[]`. Rule IDs must be all-caps, underscore-separated, and begin with `REVENUE_`. **No provider name in the ID.**

```typescript
export interface RevenueRule {
  id: string;
  label: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  itemType: 'insight' | 'alert' | 'action_item' | 'meeting_prep';
  evaluate: (
    obligations: RevenueObligation[],
    config?: RevenueRuleConfig
  ) => RevenueObligation[];
}

export const REVENUE_RULES: RevenueRule[] = [
  {
    id: 'REVENUE_PAYMENT_FAILED',
    label: 'Payment failed',
    severity: 'HIGH',
    itemType: 'alert',
    evaluate: (obligations) =>
      obligations.filter(o =>
        o.status === 'failed' &&
        o.updatedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)
      )
  },
  {
    id: 'REVENUE_INVOICE_PAST_DUE',
    label: 'Invoice past due',
    severity: 'HIGH',
    itemType: 'alert',
    evaluate: (obligations) =>
      obligations.filter(o => o.status === 'past_due')
  },
  {
    id: 'REVENUE_DISPUTE_OPENED',
    label: 'Payment disputed',
    severity: 'HIGH',
    itemType: 'alert',
    evaluate: (obligations) =>
      obligations.filter(o =>
        o.status === 'disputed' &&
        o.updatedAt > new Date(Date.now() - 48 * 60 * 60 * 1000)
      )
  },
  {
    id: 'REVENUE_SUBSCRIPTION_CANCELED',
    label: 'Subscription canceled',
    severity: 'HIGH',
    itemType: 'alert',
    evaluate: (obligations) =>
      obligations.filter(o =>
        o.status === 'canceled' &&
        o.updatedAt > new Date(Date.now() - 48 * 60 * 60 * 1000)
      )
  },
  {
    id: 'REVENUE_PAYMENT_RETRY_EXHAUSTED',
    label: 'Payment retries exhausted',
    severity: 'HIGH',
    itemType: 'alert',
    evaluate: (obligations) =>
      obligations.filter(o => o.status === 'uncollectible')
  },
  {
    id: 'REVENUE_LARGE_PAYMENT_RECEIVED',
    label: 'Large payment received',
    severity: 'MEDIUM',
    itemType: 'insight',
    evaluate: (obligations, config) => {
      const threshold = config?.largePaymentThresholdCents ?? 500000;
      return obligations.filter(o =>
        o.status === 'paid' &&
        o.amountCents >= threshold &&
        o.paidAt != null &&
        o.paidAt > new Date(Date.now() - 24 * 60 * 60 * 1000)
      );
    }
  },
  {
    id: 'REVENUE_INVOICE_DUE_SOON',
    label: 'Invoice due within 48 hours',
    severity: 'LOW',
    itemType: 'insight',
    evaluate: (obligations, config) => {
      const threshold = config?.largePaymentThresholdCents ?? 500000;
      const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
      return obligations.filter(o =>
        o.status === 'open' &&
        o.dueAt != null &&
        o.dueAt <= in48h &&
        o.dueAt >= new Date() &&
        o.amountCents >= threshold
      );
    }
  },
  {
    id: 'REVENUE_NO_INVOICE_POST_CLOSE',
    label: 'Closed deal missing invoice',
    severity: 'MEDIUM',
    itemType: 'action_item',
    // STUB — Rung 5 Contradiction Engine implements cross-source logic.
    // Registered here to keep the rule catalog complete.
    evaluate: () => []
  }
];
```

---

## Step 8: Brief Builder (`server/revenue/brief-builder.ts`)

Convert a fired `RevenueObligation` + `RevenueRule` into an `ExtractedInsight` matching the existing `base.ts` interface.

```typescript
import type { ExtractedInsight } from '../integrations/base';
import type { RevenueObligation } from './types';
import type { RevenueRule } from './rules';

const PROVIDER_LABELS: Record<string, string> = {
  stripe:      'Stripe',
  quickbooks:  'QuickBooks'
};

export function buildInsightFromObligation(
  obligation: RevenueObligation,
  rule: RevenueRule
): ExtractedInsight {
  const providerLabel = PROVIDER_LABELS[obligation.sourceProvider] ?? obligation.sourceProvider;
  const amount = formatCurrency(obligation.amountCents, obligation.currency);

  return {
    type: rule.itemType,
    title: rule.label,
    description: buildDescription(obligation, rule, providerLabel, amount),
    confidence: 'HIGH',  // all revenue rules are deterministic
    needsReview: rule.severity === 'HIGH',
    tags: [
      obligation.sourceProvider,
      'revenue',
      rule.id.toLowerCase().replace(/_/g, '-')
    ],
    source: {
      provider: obligation.sourceProvider,
      label: providerLabel,
      deepLink: obligation.sourceDeepLink,
      timestamp: obligation.updatedAt
    },
    action: obligation.sourceDeepLink ? {
      label: `View in ${providerLabel}`,
      type: 'open_link',
      payload: obligation.sourceDeepLink
    } : undefined
  };
}

function buildDescription(
  o: RevenueObligation,
  rule: RevenueRule,
  providerLabel: string,
  amount: string
): string {
  const c = o.customerLabel;
  switch (rule.id) {
    case 'REVENUE_PAYMENT_FAILED':
      return `${c}'s ${amount} payment failed. Source: ${providerLabel}.`;
    case 'REVENUE_INVOICE_PAST_DUE':
      return `${c} has an unpaid ${amount} invoice past due. Source: ${providerLabel}.`;
    case 'REVENUE_DISPUTE_OPENED':
      return `${c} opened a dispute on a ${amount} payment. Source: ${providerLabel}.`;
    case 'REVENUE_SUBSCRIPTION_CANCELED':
      return `${c} canceled their subscription. Source: ${providerLabel}.`;
    case 'REVENUE_PAYMENT_RETRY_EXHAUSTED':
      return `${c}'s ${amount} invoice is now uncollectible after retries exhausted. Source: ${providerLabel}.`;
    case 'REVENUE_LARGE_PAYMENT_RECEIVED':
      return `${amount} payment received from ${c}. Source: ${providerLabel}.`;
    case 'REVENUE_INVOICE_DUE_SOON':
      return `${c} has a ${amount} invoice due within 48 hours. Source: ${providerLabel}.`;
    default:
      return `Revenue signal for ${c}. Source: ${providerLabel}.`;
  }
}

function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(cents / 100);
}
```

---

## Step 9: Sync Pipeline (`server/revenue/sync.ts`)

The sync pipeline is the orchestrator. It is called by the existing scheduled brief generation job — **do not create a new cron or scheduler**.

```typescript
import pMap from 'p-map';
import { subHours, subDays } from 'date-fns';
import { isTokenError } from '../utils/token-errors'; // existing utility
import { getAdapter } from './adapters/registry';
import { resolveRevenueEntity } from './entity-resolver';
import { REVENUE_RULES } from './rules';
import { buildInsightFromObligation } from './brief-builder';
import { enrichQBOCustomerEmails } from './adapters/quickbooks';

export async function syncRevenueProvider(
  workspaceId: string,
  connection: SourceConnection, // existing type from source_connections
  db: Database
): Promise<{ obligationCount: number; signalCount: number }> {
  const adapter = getAdapter(connection.provider);

  const since = connection.lastSyncedAt
    ? subHours(connection.lastSyncedAt, 1)   // 1h overlap to catch missed events
    : subDays(new Date(), 90);               // 90-day initial backfill

  let obligations: RevenueObligation[] = [];

  try {
    obligations = await adapter.fetchObligations(workspaceId, connection.nangoConnId, since);
  } catch (err) {
    if (isTokenError(err)) {
      await db.update(sourceConnections)
        .set({
          status: 'error',
          errorMessage: 'Token invalid or expired. Reconnect required.'
        })
        .where(eq(sourceConnections.id, connection.id));
      return { obligationCount: 0, signalCount: 0 };
    }
    throw err;
  }

  // Entity resolution — bounded concurrency, non-blocking on individual failures
  const resolved = await pMap(
    obligations,
    async (o) => {
      try {
        const entityId = await resolveRevenueEntity(o, workspaceId, db);
        return { ...o, entityId };
      } catch {
        return o; // entity resolution failure is non-fatal
      }
    },
    { concurrency: 5 }
  );

  // Upsert obligations — conflict on (workspace_id, source_raw_id)
  if (resolved.length > 0) {
    await db.insert(revenueObligations)
      .values(resolved.map(toDbRow))
      .onConflictDoUpdate({
        target: [revenueObligations.workspaceId, revenueObligations.sourceRawId],
        set: {
          status:           sql`EXCLUDED.status`,
          paidAt:           sql`EXCLUDED.paid_at`,
          entityId:         sql`EXCLUDED.entity_id`,
          updatedAt:        sql`NOW()`
        }
      });
  }

  // Run enrichment for QBO obligations missing customer email (fire-and-forget)
  if (connection.provider === 'quickbooks') {
    enrichQBOCustomerEmails(workspaceId, connection.nangoConnId, db).catch(console.error);
  }

  // Evaluate all rules against fresh obligations
  const insights: ExtractedInsight[] = [];
  for (const rule of REVENUE_RULES) {
    const fired = rule.evaluate(resolved);
    for (const obligation of fired) {
      insights.push(buildInsightFromObligation(obligation, rule));
    }
  }

  // Mark connection healthy
  await db.update(sourceConnections)
    .set({ lastSyncedAt: new Date(), status: 'active', errorMessage: null })
    .where(eq(sourceConnections.id, connection.id));

  return { obligationCount: resolved.length, signalCount: insights.length };
}
```

**Adapter registry** (`server/revenue/adapters/registry.ts`):
```typescript
import { StripeAdapter } from './stripe';
import { QuickBooksAdapter } from './quickbooks';
import type { RevenueAdapter } from '../adapter';

const adapters: Record<string, RevenueAdapter> = {
  stripe:      new StripeAdapter(),
  quickbooks:  new QuickBooksAdapter()
};

export function getAdapter(provider: string): RevenueAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`No revenue adapter registered for provider: ${provider}`);
  return adapter;
}
```

---

## Step 10: OAuth Integration Files

Follow the exact pattern of existing files like `server/integrations/gmail-oauth.ts` and `server/integrations/plaid-oauth.ts`.

### `server/integrations/stripe-oauth.ts`

- Nango integration key: `stripe`
- Scopes: `read_only`
- Connection stored in `source_connections` with `provider: 'stripe'`
- On successful connection, trigger initial sync immediately (90-day backfill)
- On disconnect, soft-delete the `source_connections` row and archive `revenue_obligations` rows (set `status: 'unknown'` rather than deleting, for Rung 5 historical access)

### `server/integrations/quickbooks-oauth.ts`

- Nango integration key: `quickbooks`
- Scopes: `com.intuit.quickbooks.accounting`
- Store `realmId` (QBO company ID) in connection metadata — it is required for every IDS Query API call
- On successful connection, trigger initial sync immediately (90-day backfill)
- Same soft-delete behavior as Stripe on disconnect

### `server/integrations/stripe.ts` and `server/integrations/quickbooks.ts`

These are the `IIntegration` wrappers that the existing brief generation pipeline calls. Implement:

```typescript
export class StripeIntegration implements IIntegration {
  readonly provider = 'stripe';
  readonly readOnly = true;

  async fetchRecent(): Promise<ExtractedInsight[]> {
    // Delegate to syncRevenueProvider for the workspace's Stripe connection
    // Return [] if no Stripe connection exists for workspace
    // This method is called by the existing brief generation job
  }

  async isEnabled(): Promise<boolean> {
    // Check source_connections for active Stripe connection in workspace
  }

  async testConnection(): Promise<boolean> {
    // Attempt a minimal Nango proxy request (e.g., GET /v1/balance)
  }
}
```

Mirror this for `QuickBooksIntegration`.

---

## Step 11: Register in Brief Generation Pipeline

Find where the existing brief generation job calls integrations (likely `server/services/` or `server/routes.ts`) and add:

```typescript
import { StripeIntegration } from '../integrations/stripe';
import { QuickBooksIntegration } from '../integrations/quickbooks';

// In the integrations array alongside Gmail, Slack, HubSpot, etc.:
const integrations = [
  // ... existing integrations ...
  new StripeIntegration(workspaceId, db),
  new QuickBooksIntegration(workspaceId, db),
];
```

Revenue insights from both adapters flow into the same `ExtractedInsight[]` array and are processed identically to email/calendar/HubSpot signals. No special casing.

---

## Step 12: Standing Issues for Revenue Signals

Revenue signals that remain unresolved must surface as standing issues with aging callouts. The following rule IDs must create/update standing issues (not just brief items) when they fire:

- `REVENUE_INVOICE_PAST_DUE` — persist until `status` changes to `paid` or `uncollectible`
- `REVENUE_PAYMENT_RETRY_EXHAUSTED` — persist until manually resolved
- `REVENUE_SUBSCRIPTION_CANCELED` — persist for 7 days post-cancellation

Follow the existing standing issue pattern for aging. The brief should display: `"14 days since flagged"` when a standing issue has been open for 14 days. This pattern is already implemented — connect revenue signals to it.

---

## Step 13: Routes

Add two new route groups to `server/routes.ts`. Follow the existing route pattern with workspace context middleware.

### `POST /api/integrations/stripe/connect`
Initiate Nango OAuth flow for Stripe. Returns the Nango connect URL.

### `DELETE /api/integrations/stripe/disconnect`
Revoke connection. Soft-delete `source_connections` row.

### `GET /api/integrations/stripe/status`
Returns `{ connected: boolean, lastSyncedAt: string | null, status: string, errorMessage: string | null }`.

### `POST /api/integrations/stripe/sync`
Manual sync trigger (for settings UI "Sync now" button). Calls `syncRevenueProvider`.

Mirror all four routes for QuickBooks (`/api/integrations/quickbooks/...`).

---

## Step 14: Settings UI Provider Cards

The settings page already renders provider cards for Gmail, Slack, HubSpot, Plaid. Add cards for Stripe and QuickBooks following the exact same component pattern.

**Stripe card copy:**
- Name: `Stripe`
- Description: `Billing state — invoices, subscriptions, failed payments, and disputes.`
- Color: `#635BFF`
- Connected state: show `lastSyncedAt`, "Sync now" button, disconnect button
- Error state: show `errorMessage` with "Reconnect" CTA

**QuickBooks card copy:**
- Name: `QuickBooks`
- Description: `Invoice state — accounts receivable, open invoices, and payment status.`
- Color: `#2CA01C`
- Connected state: same as Stripe
- Error state: same as Stripe

**Do not** use copy like "Connect Stripe to verify revenue" — the product is provider-neutral. Use "Connect a billing system" or "Revenue proof" as the section heading.

---

## Acceptance Checklist

Before marking Rung 4 complete, verify every item:

**Schema**
- [ ] `revenue_obligations` table exists with all fields and indexes
- [ ] `revenue_movements` table exists with all fields and indexes
- [ ] Both tables have `workspace_id NOT NULL` with cascade delete
- [ ] `UNIQUE(workspace_id, source_raw_id)` constraint on both tables

**Adapters**
- [ ] `StripeAdapter` implements `RevenueAdapter` interface
- [ ] `QuickBooksAdapter` implements `RevenueAdapter` interface
- [ ] Neither adapter is imported in `rules.ts` or `brief-builder.ts`
- [ ] Both adapters use Nango proxy — no direct Stripe or QBO SDK dependency
- [ ] `StripeIntegration` and `QuickBooksIntegration` implement `IIntegration`
- [ ] Both have `readOnly: true`

**Rules**
- [ ] All 8 rule IDs defined in `REVENUE_RULES`
- [ ] Zero rule IDs contain a provider name
- [ ] `REVENUE_NO_INVOICE_POST_CLOSE` returns `[]` (stub — not broken)
- [ ] All deterministic rules emit `confidence: 'HIGH'`

**EntityGraph**
- [ ] Stripe customer email → domain → entity resolution works end-to-end
- [ ] QBO customer resolution works after enrichment job runs
- [ ] Revenue entity stubs merge with HubSpot entities on domain match
- [ ] No duplicate entities created for the same domain

**Sync**
- [ ] `isTokenError()` handling marks connection `error` and continues (does not throw to job runner)
- [ ] 90-day initial backfill on first connection
- [ ] Incremental sync uses `lastSyncedAt - 1h` overlap
- [ ] QBO enrichment job is fire-and-forget (does not block sync result)
- [ ] Upsert uses `onConflictDoUpdate` — no duplicate obligations on re-sync

**Brief Integration**
- [ ] Revenue insights appear in the daily brief alongside other provider signals
- [ ] `source.provider` is `'stripe'` or `'quickbooks'` (lowercase)
- [ ] `source.label` is `'Stripe'` or `'QuickBooks'` (display casing)
- [ ] `tags` array always includes provider name, `'revenue'`, and kebab-case rule ID
- [ ] `REVENUE_INVOICE_PAST_DUE`, `REVENUE_PAYMENT_RETRY_EXHAUSTED`, `REVENUE_SUBSCRIPTION_CANCELED` create standing issues

**Workspace Isolation**
- [ ] Every DB query in sync pipeline includes `where workspaceId = ...`
- [ ] Route handlers resolve workspaceId from session, never from request body
- [ ] Workspace A cannot read workspace B's `revenue_obligations`

**UI**
- [ ] Stripe provider card renders in settings
- [ ] QuickBooks provider card renders in settings
- [ ] Both cards show connected/error/disconnected states correctly
- [ ] No copy says "Connect Stripe to verify revenue" anywhere

**Rung 5 Readiness**
- [ ] `revenue_obligations.entity_id` is populated for obligations with resolvable customers
- [ ] `REVENUE_NO_INVOICE_POST_CLOSE` rule is registered (even as stub)
- [ ] The following query executes cleanly against production data:
  ```sql
  SELECT e.label, o.status, o.source_provider
  FROM entities e
  LEFT JOIN revenue_obligations o ON o.entity_id = e.id
  WHERE e.workspace_id = $1
  LIMIT 10;
  ```

---

## What Rung 5 Will Use From This Rung

The Contradiction Engine (Rung 5) will query `revenue_obligations` directly. It does not import any Stripe or QuickBooks code. When you build Rung 5, it should work identically whether the workspace has Stripe, QuickBooks, or both connected.

Specifically, Rung 5 will run cross-source queries like:

```sql
-- Closed HubSpot deals with no invoice in revenue_obligations
SELECT h.deal_name, h.amount, h.closed_at, e.label
FROM hubspot_deals h
JOIN entities e ON e.id = h.entity_id
LEFT JOIN revenue_obligations o
  ON o.entity_id = e.id
  AND o.issued_at > h.closed_at
WHERE h.workspace_id = $workspaceId
  AND h.stage = 'closed_won'
  AND h.closed_at > NOW() - INTERVAL '30 days'
  AND o.id IS NULL;
```

**This query must work before Rung 4 is marked done.** Run it against your test workspace with at least one connected billing provider and verify it returns meaningful results.

---

*SYSOI Rung 4 — Revenue Proof*  
*Claude Code Implementation Prompt*  
*Sandbox Group LLC — May 12, 2026*
