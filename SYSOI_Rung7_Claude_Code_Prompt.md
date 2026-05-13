# SYSOI Rung 7: Project Signal Layer + Compound Synthesis
## Claude Code Implementation Prompt

---

## Context

Rungs 1–6 are complete and verified:
- Multi-tenant workspace isolation throughout
- Gmail, Google Calendar, Slack adapters
- HubSpot adapter + EntityGraph
- Stripe + QuickBooks adapters, `revenue_obligations`, `revenue_movements`, 8 revenue rules
- Contradiction Engine: `CLOSED_DEAL_NO_INVOICE`, `INVOICE_NO_CRM_CONTACT`, `PAID_DEAL_OPEN_INVOICE`, `STALE_DEAL_ACTIVE_BILLING`, `DEPOSIT_NO_INVOICE`, `INVOICE_NO_DEPOSIT`
- Plaid banking layer: 6 banking signal rules, `bank_accounts`, `banking_transactions`, `CashPosition`
- `weekly-synthesis.ts`: theme clustering, `themeScore` formula, LLM synthesis via `callLLM()`, `WeeklySynthesisPayload`

**Rung 7 adds two project management adapters (Linear + Asana) and upgrades the weekly synthesis engine to produce compound signals** — observations that cross the boundary between project execution, revenue state, and cash position. The daily brief gains `CALENDAR_NO_PREP` (stubbed in Rung 5, activated here). The weekly synthesis gains a `compoundSignals` array that the LLM uses as additional input context.

Read `PRINCIPLES.md` before touching anything.

---

## What Rung 7 Builds

1. **Linear adapter** — workspace issues, cycle/sprint velocity, overdue items, blocked items
2. **Asana adapter** — workspace tasks, project health, overdue tasks, milestone proximity
3. **`CALENDAR_NO_PREP` contradiction** — meeting on calendar with no prep materials found in Gmail/Notion/Slack within 24h window
4. **Compound signal engine** — cross-domain pattern detection that combines project + revenue + cash signals
5. **Weekly synthesis upgrade** — `compoundSignals` injected into LLM input; synthesis prompt updated to reason across domains

---

## DO NOT

- Do not build a full project management UI — no task browser, no board view, no project timeline
- Do not sync all historical issues — fetch the last 30 days only
- Do not store Asana task content or issue descriptions — store metadata only (status, assignee, due date, priority)
- Do not add Linear or Asana to the Contradiction Engine as primary sources — they are context enrichers only
- Do not make the compound signal engine call the LLM — it is purely algorithmic, no AI cost
- Do not block brief delivery if Linear or Asana sync fails
- Do not use `getCurrentUserId()` anywhere — `getCurrentWorkspaceId()` throughout
- Do not implement task creation, commenting, or status updates — read-only only

---

## Step 1: Schema (`shared/schema.ts`)

### `project_items` table

One table covers both Linear and Asana. The `sourceProvider` discriminates.

```typescript
export const projectItems = pgTable('project_items', {
  id:               uuid('id').primaryKey().defaultRandom(),
  workspaceId:      uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId:     uuid('connection_id').notNull().references(() => sourceConnections.id, { onDelete: 'cascade' }),
  sourceProvider:   text('source_provider').notNull(),   // 'linear' | 'asana'
  externalId:       text('external_id').notNull(),       // Linear issue ID or Asana task GID
  projectId:        text('project_id'),                  // Linear team ID or Asana project GID
  projectName:      text('project_name'),
  title:            text('title').notNull(),
  status:           text('status').notNull(),            // provider-native status string
  normalizedStatus: text('normalized_status').notNull(), // 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
  priority:         text('priority'),                    // 'urgent' | 'high' | 'medium' | 'low' | null
  assigneeName:     text('assignee_name'),
  dueDate:          timestamp('due_date', { withTimezone: true }),
  completedAt:      timestamp('completed_at', { withTimezone: true }),
  cycleId:          text('cycle_id'),                    // Linear cycle / Asana sprint
  cycleName:        text('cycle_name'),
  isBlocked:        boolean('is_blocked').notNull().default(false),
  blockedReason:    text('blocked_reason'),
  entityId:         uuid('entity_id').references(() => entities.id),  // if item resolves to a known entity
  externalUrl:      text('external_url'),
  syncedAt:         timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqWorkspaceProvider: unique().on(table.workspaceId, table.sourceProvider, table.externalId),
  idxWorkspace:          index().on(table.workspaceId),
  idxProvider:           index().on(table.workspaceId, table.sourceProvider),
  idxStatus:             index().on(table.workspaceId, table.normalizedStatus),
  idxDueDate:            index().on(table.workspaceId, table.dueDate),
  idxCycle:              index().on(table.workspaceId, table.cycleId),
}));
```

### `sprint_velocity` table

Computed after each sync. Drives the compound signal engine.

```typescript
export const sprintVelocity = pgTable('sprint_velocity', {
  id:               uuid('id').primaryKey().defaultRandom(),
  workspaceId:      uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceProvider:   text('source_provider').notNull(),
  cycleId:          text('cycle_id').notNull(),
  cycleName:        text('cycle_name'),
  cycleStartDate:   timestamp('cycle_start_date', { withTimezone: true }),
  cycleEndDate:     timestamp('cycle_end_date', { withTimezone: true }),
  totalItems:       integer('total_items').notNull().default(0),
  completedItems:   integer('completed_items').notNull().default(0),
  blockedItems:     integer('blocked_items').notNull().default(0),
  overdueItems:     integer('overdue_items').notNull().default(0),
  completionRate:   real('completion_rate'),              // 0.0–1.0
  prevCompletionRate: real('prev_completion_rate'),       // prior cycle for delta
  velocityDelta:    real('velocity_delta'),               // completionRate - prevCompletionRate
  computedAt:       timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqWorkspaceCycle: unique().on(table.workspaceId, table.sourceProvider, table.cycleId),
  idxWorkspace:       index().on(table.workspaceId),
}));
```

Run `npm run db:push` after adding both tables.

---

## Step 2: Types (`server/project/types.ts`)

```typescript
export type ProjectSignalClass =
  | 'SPRINT_VELOCITY_DROP'     // current cycle completion rate < prior by threshold
  | 'BLOCKED_ITEMS_SPIKE'      // blocked item count exceeds threshold
  | 'OVERDUE_MILESTONE'        // item marked high/urgent priority is past due date
  | 'CYCLE_AT_RISK'            // < 48h to cycle end, completion rate < 60%
  | 'NO_ACTIVE_SPRINT';        // no cycle/sprint found in connected workspace

export type NormalizedStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export interface ProjectSyncResult {
  itemCount: number;
  signalCount: number;
  velocity: SprintVelocity | null;
}

export interface SprintVelocity {
  cycleId: string;
  cycleName?: string;
  totalItems: number;
  completedItems: number;
  blockedItems: number;
  overdueItems: number;
  completionRate: number;
  prevCompletionRate?: number;
  velocityDelta?: number;
}

export interface ProjectSignalFinding {
  class: ProjectSignalClass;
  provider: 'linear' | 'asana';
  projectName?: string;
  cycleName?: string;
  description: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

// Status normalization maps
export const LINEAR_STATUS_MAP: Record<string, NormalizedStatus> = {
  'backlog':     'todo',
  'todo':        'todo',
  'in progress': 'in_progress',
  'in review':   'in_progress',
  'blocked':     'blocked',
  'done':        'done',
  'cancelled':   'cancelled',
  'canceled':    'cancelled',
};

export const ASANA_STATUS_MAP: Record<string, NormalizedStatus> = {
  'not started': 'todo',
  'in progress': 'in_progress',
  'blocked':     'blocked',
  'complete':    'done',
  'completed':   'done',
};
```

---

## Step 3: Linear Adapter (`server/integrations/linear.ts`)

Linear uses their GraphQL API. The `@linear/sdk` package may not be installed — use `fetch` with the GraphQL endpoint directly to avoid a new dependency.

**Authentication:** Linear uses personal API keys or OAuth. Store in `source_connections.credentials.accessToken`.

```typescript
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

async function linearQuery(accessToken: string, query: string, variables?: Record<string, unknown>) {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken,  // Linear accepts raw token without 'Bearer' prefix
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors?.length > 0) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}
```

**Queries needed:**

```graphql
# 1. Fetch teams (to know what workspace this is)
query Teams {
  teams {
    nodes { id name }
  }
}

# 2. Fetch active cycles
query ActiveCycles($teamId: String!) {
  cycles(filter: { team: { id: { eq: $teamId } }, isActive: { eq: true } }) {
    nodes {
      id
      name
      number
      startsAt
      endsAt
      completedAt
      issues {
        nodes {
          id title
          state { name type }
          priority
          assignee { name }
          dueDate
          completedAt
          url
        }
      }
    }
  }
}

# 3. Fetch recent issues (30 days) outside active cycles
query RecentIssues($since: DateTime!) {
  issues(filter: { updatedAt: { gt: $since } }, first: 100) {
    nodes {
      id title
      state { name type }
      priority
      assignee { name }
      dueDate
      completedAt
      cycle { id name }
      team { id name }
      url
    }
  }
}
```

**Status normalization:** Linear `state.type` maps cleanly:
- `type: 'backlog'` → `'todo'`
- `type: 'unstarted'` → `'todo'`
- `type: 'started'` → `'in_progress'`
- `type: 'completed'` → `'done'`
- `type: 'cancelled'` → `'cancelled'`

Use the `type` field, not the display name, for normalization — it's locale-independent and stable.

**Blocked detection:** Linear has no native "blocked" state type. Detect blocked items by:
1. Issues with label "Blocked" or "🚫" in the title
2. Issues in `started` state with `dueDate` in the past by > 3 days

---

## Step 4: Asana Adapter (`server/integrations/asana.ts`)

Asana uses a REST API. The `asana` npm package may not be installed — use `fetch` directly.

**Authentication:** OAuth or personal access token. Store in `source_connections.credentials.accessToken`. Token format: `Bearer {token}`.

**Base URL:** `https://app.asana.com/api/1.0`

**Requests needed:**

```typescript
// 1. Get workspaces
GET /workspaces
// Returns: { data: [{ gid, name }] }

// 2. Get projects in workspace
GET /projects?workspace={workspaceGid}&opt_fields=gid,name,current_status_update,color,due_date
// Limit to 50 most recently updated

// 3. Get tasks for project (modified in last 30 days)
GET /tasks?project={projectGid}&modified_since={iso8601}&opt_fields=gid,name,completed,due_on,assignee.name,memberships.section.name,tags.name,permalink_url&limit=100

// 4. Get sections for sprint detection
GET /sections?project={projectGid}&opt_fields=gid,name
```

**Sprint detection in Asana:** Asana has no native sprint concept. Treat sections named "Sprint N", "Current Sprint", "Active", or matching `/sprint/i` as the active sprint proxy. If no matching section exists, set `cycleId = null`.

**Status normalization:** Use `completed: true/false` + section name:
- `completed: true` → `'done'`
- Section matches `/blocked/i` → `'blocked'`
- Section matches `/in.?progress|active|current/i` → `'in_progress'`
- Default → `'todo'`

---

## Step 5: Project Rules (`server/project/rules.ts`)

Five rules, all in-memory. Follow the same pattern as `server/banking/rules.ts`.

```typescript
export const PROJECT_RULES: ProjectRule[] = [
  {
    class: 'SPRINT_VELOCITY_DROP',
    severity: 'HIGH',
    evaluate: (items, velocity) => {
      if (!velocity?.velocityDelta) return [];
      if (velocity.velocityDelta < -0.25 && velocity.totalItems >= 3) {
        return [{
          class: 'SPRINT_VELOCITY_DROP',
          description: `Sprint completion rate dropped ${Math.abs(Math.round(velocity.velocityDelta * 100))}% vs prior cycle (now ${Math.round(velocity.completionRate * 100)}%).`,
          confidence: velocity.velocityDelta < -0.40 ? 'HIGH' : 'MEDIUM',
          cycleName: velocity.cycleName,
          metadata: { completionRate: velocity.completionRate, delta: velocity.velocityDelta }
        }];
      }
      return [];
    }
  },
  {
    class: 'BLOCKED_ITEMS_SPIKE',
    severity: 'HIGH',
    evaluate: (items) => {
      const blocked = items.filter(i => i.normalizedStatus === 'blocked');
      if (blocked.length >= 3) {
        return [{
          class: 'BLOCKED_ITEMS_SPIKE',
          description: `${blocked.length} items currently blocked${blocked[0]?.projectName ? ' in ' + blocked[0].projectName : ''}.`,
          confidence: blocked.length >= 5 ? 'HIGH' : 'MEDIUM',
          metadata: { blockedCount: blocked.length, titles: blocked.slice(0, 3).map(i => i.title) }
        }];
      }
      return [];
    }
  },
  {
    class: 'OVERDUE_MILESTONE',
    severity: 'HIGH',
    evaluate: (items) => {
      const now = new Date();
      const overdue = items.filter(i =>
        i.dueDate &&
        i.dueDate < now &&
        i.normalizedStatus !== 'done' &&
        i.normalizedStatus !== 'cancelled' &&
        (i.priority === 'urgent' || i.priority === 'high')
      );
      return overdue.map(item => ({
        class: 'OVERDUE_MILESTONE' as ProjectSignalClass,
        description: `"${item.title}" (${item.priority} priority) is overdue since ${formatDate(item.dueDate!)}.`,
        confidence: item.priority === 'urgent' ? 'HIGH' : 'MEDIUM',
        externalUrl: item.externalUrl,
        metadata: { title: item.title, dueDate: item.dueDate, priority: item.priority }
      }));
    }
  },
  {
    class: 'CYCLE_AT_RISK',
    severity: 'HIGH',
    evaluate: (items, velocity, cycleEndDate) => {
      if (!cycleEndDate) return [];
      const hoursLeft = (cycleEndDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursLeft > 48 || hoursLeft < 0) return [];
      if ((velocity?.completionRate ?? 1) >= 0.60) return [];

      return [{
        class: 'CYCLE_AT_RISK',
        description: `Current sprint ends in ${Math.round(hoursLeft)}h with ${Math.round((velocity?.completionRate ?? 0) * 100)}% completion. ${velocity?.blockedItems ?? 0} items blocked.`,
        confidence: 'HIGH',
        cycleName: velocity?.cycleName,
        metadata: { hoursLeft, completionRate: velocity?.completionRate, blockedItems: velocity?.blockedItems }
      }];
    }
  },
  {
    class: 'NO_ACTIVE_SPRINT',
    severity: 'LOW',
    evaluate: (items, velocity) => {
      const inProgress = items.filter(i => i.normalizedStatus === 'in_progress');
      if (velocity?.cycleId || inProgress.length > 0) return [];
      return [{
        class: 'NO_ACTIVE_SPRINT',
        description: 'No active sprint or cycle found. Work may be unstructured.',
        confidence: 'LOW'
      }];
    }
  }
];
```

---

## Step 6: Compound Signal Engine (`server/compound/engine.ts`)

This is the crown jewel of Rung 7. **Purely algorithmic — no LLM calls, no database writes per signal.** Runs after all individual adapters sync. Takes a snapshot of current state across all domains and returns `CompoundSignal[]`.

```typescript
// server/compound/types.ts

export type CompoundSignalClass =
  | 'VELOCITY_DROP_CASH_RISK'        // sprint velocity down + available cash below threshold
  | 'REVENUE_GAP_SPRINT_BLOCKED'     // open invoices aging + sprint blocked items spike
  | 'DEAL_CLOSING_NO_CAPACITY'       // HubSpot deals in final stage + no sprint capacity
  | 'OVERDUE_WORK_UNPAID_INVOICE'    // overdue project items + unpaid invoices for same entity
  | 'CASH_LOW_BURN_ACCELERATING';    // cash below threshold + large recent withdrawals

export interface CompoundSignal {
  class: CompoundSignalClass;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  headline: string;           // max 12 words — appears in brief header
  narrative: string;          // max 50 words — appears in weekly synthesis
  sourceClasses: string[];    // which signal classes contributed
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  metadata?: Record<string, unknown>;
}

export interface CompoundSignalInput {
  workspaceId: string;
  cashPosition?: CashPosition;
  velocity?: SprintVelocity;
  projectSignals: ProjectSignalFinding[];
  bankingSignals: BankingSignalFinding[];
  contradictions: ContradictionSignal[];
  openInvoiceAgingDays?: number;    // oldest unpaid invoice age in days
  openInvoicesTotalCents?: number;  // sum of all unpaid invoices
  dealsInFinalStageCents?: number;  // HubSpot deals in 'Proposal Sent' or 'Contract Sent'
}
```

```typescript
// server/compound/engine.ts

export function detectCompoundSignals(input: CompoundSignalInput): CompoundSignal[] {
  const signals: CompoundSignal[] = [];

  // ── VELOCITY_DROP_CASH_RISK ──────────────────────────────────────────────
  // Conditions: velocity delta < -25% AND available cash < $50k
  if (
    input.velocity?.velocityDelta != null &&
    input.velocity.velocityDelta < -0.25 &&
    input.cashPosition?.totalAvailableCents != null &&
    input.cashPosition.totalAvailableCents < 5_000_000  // $50k
  ) {
    signals.push({
      class: 'VELOCITY_DROP_CASH_RISK',
      severity: 'CRITICAL',
      headline: 'Sprint slipping while cash runway tightens',
      narrative: `Sprint completion is down ${Math.abs(Math.round(input.velocity.velocityDelta * 100))}% from last cycle while available cash is ${formatCurrency(input.cashPosition.totalAvailableCents, 'USD')}. Execution risk and financial pressure are converging.`,
      sourceClasses: ['SPRINT_VELOCITY_DROP', 'LOW_BALANCE_WARNING'],
      confidence: 'HIGH',
      metadata: {
        velocityDelta: input.velocity.velocityDelta,
        availableCashCents: input.cashPosition.totalAvailableCents
      }
    });
  }

  // ── REVENUE_GAP_SPRINT_BLOCKED ───────────────────────────────────────────
  // Conditions: overdue invoices > 14 days AND blocked items >= 3
  const blockedSignal = input.projectSignals.find(s => s.class === 'BLOCKED_ITEMS_SPIKE');
  if (
    input.openInvoiceAgingDays != null &&
    input.openInvoiceAgingDays > 14 &&
    blockedSignal &&
    (blockedSignal.metadata?.blockedCount as number ?? 0) >= 3
  ) {
    signals.push({
      class: 'REVENUE_GAP_SPRINT_BLOCKED',
      severity: 'HIGH',
      headline: 'Blocked sprint alongside aging unpaid invoices',
      narrative: `${blockedSignal.metadata?.blockedCount} items blocked in sprint while ${input.openInvoicesTotalCents ? formatCurrency(input.openInvoicesTotalCents, 'USD') + ' in invoices remain unpaid' : 'invoices are aging past 14 days'}. Delivery risk and revenue collection risk are simultaneous.`,
      sourceClasses: ['BLOCKED_ITEMS_SPIKE', 'CLOSED_DEAL_NO_INVOICE', 'PAID_DEAL_OPEN_INVOICE'],
      confidence: 'MEDIUM',
      metadata: {
        agingDays: input.openInvoiceAgingDays,
        blockedCount: blockedSignal.metadata?.blockedCount
      }
    });
  }

  // ── DEAL_CLOSING_NO_CAPACITY ─────────────────────────────────────────────
  // Conditions: deals in final HubSpot stage AND sprint at-risk or velocity drop
  const atRisk = input.projectSignals.find(s =>
    s.class === 'CYCLE_AT_RISK' || s.class === 'SPRINT_VELOCITY_DROP'
  );
  if (
    input.dealsInFinalStageCents != null &&
    input.dealsInFinalStageCents > 0 &&
    atRisk
  ) {
    signals.push({
      class: 'DEAL_CLOSING_NO_CAPACITY',
      severity: 'HIGH',
      headline: 'Deals closing while delivery capacity is constrained',
      narrative: `${formatCurrency(input.dealsInFinalStageCents, 'USD')} in deals are in final stage while the current sprint is ${atRisk.class === 'CYCLE_AT_RISK' ? 'at risk of missing its deadline' : 'trending below prior velocity'}. Promising to deliver while the team is already stretched.`,
      sourceClasses: ['DEAL_CLOSING_NO_CAPACITY', atRisk.class],
      confidence: 'MEDIUM',
      metadata: {
        dealsCents: input.dealsInFinalStageCents,
        sprintSignal: atRisk.class
      }
    });
  }

  // ── CASH_LOW_BURN_ACCELERATING ───────────────────────────────────────────
  // Conditions: available cash < $50k AND large withdrawals in last 7 days
  const largeWithdrawals = input.bankingSignals.filter(s =>
    s.class === 'LARGE_WITHDRAWAL' ||
    s.class === 'RECURRING_CHARGE_SPIKE'
  );
  if (
    input.cashPosition?.totalAvailableCents != null &&
    input.cashPosition.totalAvailableCents < 5_000_000 &&
    largeWithdrawals.length >= 2
  ) {
    const burnTotal = largeWithdrawals
      .reduce((sum, s) => sum + (s.amountCents ?? 0), 0);
    signals.push({
      class: 'CASH_LOW_BURN_ACCELERATING',
      severity: 'CRITICAL',
      headline: 'Low cash balance with accelerating outflows',
      narrative: `Available cash is ${formatCurrency(input.cashPosition.totalAvailableCents, 'USD')} while ${largeWithdrawals.length} significant outflows totaling ${formatCurrency(burnTotal, 'USD')} posted this week. Runway may be shorter than your model shows.`,
      sourceClasses: ['LOW_BALANCE_WARNING', 'LARGE_WITHDRAWAL', 'RECURRING_CHARGE_SPIKE'],
      confidence: 'HIGH',
      metadata: {
        availableCashCents: input.cashPosition.totalAvailableCents,
        burnCents: burnTotal,
        withdrawalCount: largeWithdrawals.length
      }
    });
  }

  // Return sorted by severity
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  return signals.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}
```

---

## Step 7: `CALENDAR_NO_PREP` Contradiction

This was stubbed in Rung 5. Activate it now.

**Logic:** For every calendar event in the next 24 hours with ≥ 2 attendees, check whether any of the following exist in the last 48 hours:
- Gmail threads with subject matching the meeting title (fuzzy, >60% word overlap)
- Slack messages containing the meeting title or attendee names in relevant channels
- Brief items tagged with any attendee's name or the meeting title

If none found, emit `CALENDAR_NO_PREP`.

```typescript
// In server/contradiction/rules.ts — add to CONTRADICTION_RULES array

{
  class: 'CALENDAR_NO_PREP',
  severity: 'MEDIUM',
  label: 'Upcoming meeting with no prep materials',
  detect: async (workspaceId, db) => {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const past48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Fetch calendar events in next 24h with >= 2 attendees
    // from brief_items where source_provider = 'google_calendar'
    // and item metadata includes attendee_count >= 2
    // Join against brief_items in last 48h for Gmail/Slack matches

    const results = await db.execute(sql`
      SELECT
        cal.id            AS event_id,
        cal.title         AS event_title,
        cal.description   AS event_metadata,
        (cal.metadata->>'startTime')::timestamptz AS start_time,
        (cal.metadata->>'attendeeCount')::int AS attendee_count
      FROM brief_items cal
      LEFT JOIN brief_items prep
        ON prep.workspace_id = ${workspaceId}
        AND prep.source_provider IN ('gmail', 'slack')
        AND prep.created_at > ${past48h}
        AND (
          similarity(prep.title, cal.title) > 0.4
          OR prep.title ILIKE '%' || split_part(cal.title, ' ', 1) || '%'
        )
      WHERE cal.workspace_id = ${workspaceId}
        AND cal.source_provider = 'google_calendar'
        AND (cal.metadata->>'startTime')::timestamptz BETWEEN ${now} AND ${in24h}
        AND (cal.metadata->>'attendeeCount')::int >= 2
        AND prep.id IS NULL
    `);

    return results.rows.map(row => ({
      entityLabel: row.event_title,
      description: `"${row.event_title}" starts in ${formatHoursUntil(row.start_time)} with ${row.attendee_count} attendees. No prep materials found in Gmail or Slack.`,
      sourceA: 'google_calendar',
      sourceB: 'gmail',
      sourceARecordId: row.event_id,
      metadata: { startTime: row.start_time, attendeeCount: row.attendee_count }
    }));
  }
}
```

**Note on `similarity()`:** This requires the `pg_trgm` extension. Add to schema migration:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```
If the extension is not available on the Neon tier, fall back to `ILIKE` matching on the first two words of the meeting title.

Add `'CALENDAR_NO_PREP'` to `ContradictionClass` type.

---

## Step 8: Weekly Synthesis Upgrade (`server/services/weekly-synthesis.ts`)

This is a targeted upgrade to the existing file — do not rewrite it. The current file is production-validated. Three additions only:

### 8a. Add `compoundSignals` to `WeeklySynthesisInput`

```typescript
interface WeeklySynthesisInput {
  // ... existing fields unchanged ...
  compoundSignals?: {
    class: string;
    severity: string;
    headline: string;
    narrative: string;
    sourceClasses: string[];
  }[];
  cashPosition?: {
    totalAvailableCents: number;
    currency: string;
    accountCount: number;
  };
}
```

### 8b. Add `compoundSignals` to `WeeklySynthesisPayload`

In `@shared/types.ts` (or wherever `WeeklySynthesisPayload` is defined):

```typescript
export interface WeeklySynthesisPayload {
  // ... existing fields unchanged ...
  compoundSignals?: Array<{
    class: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
    headline: string;
    narrative: string;
  }>;
}
```

### 8c. Update `buildUserPrompt()` to include compound signals

Add a new section to the existing prompt — do not replace it:

```typescript
// In buildUserPrompt(), add after the existing INPUT_JSON section:

${input.compoundSignals && input.compoundSignals.length > 0 ? `
COMPOUND SIGNALS (cross-domain patterns detected algorithmically):
${input.compoundSignals.map(s => `- [${s.severity}] ${s.headline}: ${s.narrative}`).join('
')}

When compound signals are present:
- Elevate the most severe into risks or opportunities as appropriate
- CRITICAL compound signals must appear in risks
- Reference them in focusDirectives only if they require founder attention this week
- Do not echo the headline verbatim — synthesize the implication
` : ''}
```

### 8d. Add `compoundSignals` to the LLM output schema

In `buildUserPrompt()`, add to the JSON structure example:
```json
"compoundSignals": [
  {
    "class": "string",
    "severity": "CRITICAL|HIGH|MEDIUM",
    "headline": "string",
    "narrative": "string"
  }
]
```

### 8e. Update `validatePayload()`

```typescript
// Add to validatePayload():
if (data.compoundSignals !== undefined && !Array.isArray(data.compoundSignals)) return false;
```

### 8f. Wire compound signals into `generateWeeklySynthesis()`

After computing `candidates` and before calling `buildLLMInput()`:

```typescript
// Detect compound signals if all data is available
let compoundSignals: CompoundSignal[] = [];
try {
  const compoundInput = await buildCompoundSignalInput(workspaceId, db);
  compoundSignals = detectCompoundSignals(compoundInput);
  if (compoundSignals.length > 0) {
    console.log(`[WeeklySynthesis] ${compoundSignals.length} compound signals detected for workspace ${workspaceId}`);
  }
} catch (err) {
  console.error('[WeeklySynthesis] Compound signal detection failed:', err);
  // Non-fatal — continue without compound signals
}

const llmInput = buildLLMInput(
  weekStart, weekEnd, signals, candidates, prevClusters, currentClusters,
  compoundSignals  // new param
);
```

**Note:** `generateWeeklySynthesis()` currently takes `userId` as its first parameter. This is the old singleton pattern — it should be `workspaceId`. If Rungs 1-6 already migrated this, use `workspaceId`. If not, migrate it now. Do not add `workspaceId` as a second parameter alongside `userId` — replace.

---

## Step 9: `buildCompoundSignalInput()` (`server/compound/input-builder.ts`)

This function assembles the snapshot that `detectCompoundSignals()` needs. It reads from the database — the engine itself is pure.

```typescript
export async function buildCompoundSignalInput(
  workspaceId: string,
  db: Database
): Promise<CompoundSignalInput> {
  const [
    cashPosition,
    velocity,
    projectSignals,
    bankingSignals,
    contradictions,
    invoiceAging,
    dealsInFinalStage
  ] = await Promise.allSettled([
    getCashPosition(workspaceId, db),
    getLatestVelocity(workspaceId, db),
    getRecentProjectSignals(workspaceId, db),
    getRecentBankingSignals(workspaceId, db),
    getOpenContradictions(workspaceId, db),
    getOldestOpenInvoiceAgeDays(workspaceId, db),
    getDealsInFinalStageCents(workspaceId, db),
  ]);

  return {
    workspaceId,
    cashPosition:              cashPosition.status === 'fulfilled' ? cashPosition.value : undefined,
    velocity:                  velocity.status === 'fulfilled' ? velocity.value : undefined,
    projectSignals:            projectSignals.status === 'fulfilled' ? projectSignals.value : [],
    bankingSignals:            bankingSignals.status === 'fulfilled' ? bankingSignals.value : [],
    contradictions:            contradictions.status === 'fulfilled' ? contradictions.value : [],
    openInvoiceAgingDays:      invoiceAging.status === 'fulfilled' ? invoiceAging.value : undefined,
    dealsInFinalStageCents:    dealsInFinalStage.status === 'fulfilled' ? dealsInFinalStage.value : undefined,
  };
}
```

Use `Promise.allSettled` — no single domain failure should block compound signal detection. If Plaid is not connected, `cashPosition` is `undefined` and the engine skips cash-related compounds.

---

## Step 10: Brief Builder (`server/project/brief-builder.ts`)

Follow the exact pattern of `server/banking/brief-builder.ts`.

```typescript
export function buildInsightFromProjectSignal(
  finding: ProjectSignalFinding
): ExtractedInsight {
  return {
    type: ['SPRINT_VELOCITY_DROP', 'CYCLE_AT_RISK', 'BLOCKED_ITEMS_SPIKE'].includes(finding.class)
      ? 'alert'
      : 'insight',
    title: PROJECT_SIGNAL_LABELS[finding.class],
    description: finding.description,
    confidence: finding.confidence,
    needsReview: finding.confidence === 'HIGH',
    tags: [
      finding.provider,
      'project',
      finding.class.toLowerCase().replace(/_/g, '-')
    ],
    source: {
      provider: finding.provider,
      label: finding.provider === 'linear' ? 'Linear' : 'Asana',
      timestamp: new Date(),
      deepLink: finding.externalUrl
    }
  };
}

export function buildInsightFromCompoundSignal(
  signal: CompoundSignal
): ExtractedInsight {
  return {
    type: 'alert',
    title: signal.headline,
    description: signal.narrative,
    confidence: signal.confidence,
    needsReview: signal.severity === 'CRITICAL',
    tags: ['compound', signal.class.toLowerCase().replace(/_/g, '-')],
    source: {
      provider: 'system',
      label: 'SYSOI Compound Signal',
      timestamp: new Date()
    }
  };
}
```

---

## Step 11: Routes

### New routes:

```typescript
// POST /api/integrations/linear/connect
// Body: { accessToken: string }
// Store in source_connections, trigger initial sync
// Returns: { connected: boolean, teamCount: number }

// DELETE /api/integrations/linear/disconnect
// Soft-delete source_connections row
// Returns: { success: boolean }

// GET /api/integrations/linear/status
// Returns: { connected: boolean, lastSyncedAt, velocitySummary }

// POST /api/integrations/linear/sync
// Manual sync trigger
// Returns: { itemCount, signalCount, velocity }

// POST /api/integrations/asana/connect
// Body: { accessToken: string }
// Store + initial sync
// Returns: { connected: boolean, projectCount: number }

// DELETE /api/integrations/asana/disconnect
// Returns: { success: boolean }

// GET /api/integrations/asana/status
// Returns: { connected: boolean, lastSyncedAt, velocitySummary }

// POST /api/integrations/asana/sync
// Returns: { itemCount, signalCount, velocity }

// GET /api/compound/signals
// Returns current CompoundSignal[] for workspace
// Used by daily brief to show compound signals at top
```

**Linear uses API key auth** (settings page has an API key input field). Asana supports both PAT and OAuth — support PAT for now, OAuth in a future rung.

---

## Step 12: Settings UI

### Linear card:
- **Name:** `Linear`
- **Description:** `Sprint velocity, blocked items, and overdue milestones.`
- **Connect flow:** API key input → `POST /api/integrations/linear/connect` → show team name + velocity summary
- **Connected state:** show team name, active cycle name, completion rate, last sync time, "Sync now"
- **No OAuth — Linear API keys only**

### Asana card:
- **Name:** `Asana`
- **Description:** `Project health, task overruns, and milestone tracking.`
- **Connect flow:** Personal Access Token input → `POST /api/integrations/asana/connect` → show workspace name + project count
- **Connected state:** show workspace name, active sprint section (if detected), last sync time, "Sync now"

---

## Step 13: Daily Brief — Compound Signal Header

When `compoundSignals` are present, inject them above the regular brief items as a "Compound Signals" section. These are rendered differently — not as individual signal cards but as a banner list with severity color coding.

```
┌─────────────────────────────────────────────────────┐
│ ⚡ COMPOUND SIGNALS                                  │
│                                                     │
│ 🔴 CRITICAL — Sprint slipping while cash tightens   │
│    Sprint down 35% while $28k available.            │
│                                                     │
│ 🟠 HIGH — Deals closing with no delivery capacity   │
│    $180k in final stage, sprint at 42% completion.  │
└─────────────────────────────────────────────────────┘
```

If no compound signals: do not show the section. Not "No compound signals today." Just hide it.

---

## Acceptance Checklist

**Schema**
- [ ] `project_items` table with `UNIQUE(workspace_id, source_provider, external_id)`
- [ ] `sprint_velocity` table with `UNIQUE(workspace_id, source_provider, cycle_id)`
- [ ] `pg_trgm` extension enabled (or ILIKE fallback for `CALENDAR_NO_PREP`)

**Linear Adapter**
- [ ] `linearQuery()` uses `fetch` directly — no `@linear/sdk` dependency added
- [ ] Status normalization uses `state.type` not `state.name`
- [ ] Blocked detection: label OR overdue-in-started heuristic
- [ ] Velocity computed from active cycle issues
- [ ] `project_items` upserted with `onConflictDoUpdate`
- [ ] `sprint_velocity` upserted after each sync

**Asana Adapter**
- [ ] Uses `fetch` directly — no `asana` npm package added
- [ ] Sprint detection via section name regex `/sprint/i`
- [ ] Status normalization from `completed` + section name
- [ ] `project_items` upserted correctly
- [ ] `sprint_velocity` upserted after each sync

**Project Rules**
- [ ] All 5 `ProjectSignalClass` values defined
- [ ] `SPRINT_VELOCITY_DROP` threshold: -25% velocity delta, minimum 3 items in cycle
- [ ] `BLOCKED_ITEMS_SPIKE` threshold: ≥ 3 blocked items
- [ ] `OVERDUE_MILESTONE` only fires on `urgent` or `high` priority items
- [ ] `CYCLE_AT_RISK` window: < 48h remaining, < 60% completion rate
- [ ] `NO_ACTIVE_SPRINT` is LOW severity — never appears in daily brief as an alert

**Compound Signal Engine**
- [ ] All 4 `CompoundSignalClass` values defined
- [ ] `detectCompoundSignals()` is pure — no async, no DB calls
- [ ] `VELOCITY_DROP_CASH_RISK` threshold: velocity < -25% AND cash < $50k
- [ ] `REVENUE_GAP_SPRINT_BLOCKED` threshold: invoices > 14 days AND ≥ 3 blocked items
- [ ] `DEAL_CLOSING_NO_CAPACITY` fires on any final-stage deal amount > $0
- [ ] `CASH_LOW_BURN_ACCELERATING` threshold: cash < $50k AND ≥ 2 large withdrawal signals
- [ ] `Promise.allSettled` used in `buildCompoundSignalInput()` — no domain failure blocks output
- [ ] Returns `[]` (not error) when insufficient data from any domain

**`CALENDAR_NO_PREP`**
- [ ] Added to `ContradictionClass` type
- [ ] 24h lookahead window for upcoming meetings
- [ ] 48h lookback window for prep materials
- [ ] Minimum 2 attendees before firing
- [ ] Fuzzy match on meeting title (similarity > 0.4 or ILIKE fallback)

**Weekly Synthesis**
- [ ] `compoundSignals` field in `WeeklySynthesisInput`
- [ ] `compoundSignals` field in `WeeklySynthesisPayload`
- [ ] `validatePayload()` updated
- [ ] LLM prompt updated — CRITICAL compound signals elevated to risks
- [ ] `buildLLMInput()` accepts `compoundSignals` as new parameter
- [ ] `generateWeeklySynthesis()` uses `workspaceId`, not `userId`
- [ ] Compound signal detection failure is non-fatal

**Routes**
- [ ] `POST /api/integrations/linear/connect` stores token + triggers sync
- [ ] `POST /api/integrations/asana/connect` stores token + triggers sync
- [ ] `GET /api/compound/signals` returns current signals for workspace
- [ ] All new routes scoped by `workspaceId`

**Brief Integration**
- [ ] Compound signals appear above regular brief items
- [ ] Compound signal section hidden when empty (no empty state message)
- [ ] CRITICAL signals use red accent, HIGH use orange, MEDIUM use yellow

**Demo Readiness**
```sql
-- Verify project items synced
SELECT source_provider, normalized_status, COUNT(*)
FROM project_items
WHERE workspace_id = $1
GROUP BY source_provider, normalized_status;

-- Verify velocity computed
SELECT cycle_name, completion_rate, velocity_delta, blocked_items
FROM sprint_velocity
WHERE workspace_id = $1
ORDER BY computed_at DESC LIMIT 5;

-- Verify compound signals available
SELECT class, severity, headline
FROM (
  -- compound signals are computed in-memory, not stored
  -- verify via API: GET /api/compound/signals
) q;

-- Verify CALENDAR_NO_PREP firing
SELECT entity_label, description
FROM contradiction_signals
WHERE workspace_id = $1
  AND contradiction_class = 'CALENDAR_NO_PREP'
  AND resolved_at IS NULL;
```

---

## Rung 8 Preview

Rung 8 is **Delivery + Polish** — the last rung before private beta.

- Resend email delivery for daily brief (scheduled 6am workspace timezone)
- Mobile push notifications for CRITICAL compound signals
- `?demo=true` mode that loads `seed-demo.ts` data — solves the Google OAuth reviewer problem
- Production observability: structured logging replacing `console.log`, error alerting
- Rate limit hardening on all sync endpoints
- The private beta onboarding flow: workspace creation → source connection wizard → first brief

After Rung 8, SYSOI is ready for its first five paying users.

---

*SYSOI Rung 7 — Project Signal Layer + Compound Synthesis*
*Claude Code Implementation Prompt*
*Sandbox Group LLC — May 13, 2026*
