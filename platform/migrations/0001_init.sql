-- Event Intelligence Orchestration Platform — initial schema
-- Tenant model: organization. Every domain row carries organization_id and is
-- filtered by it on every query (ported discipline from Forge's brand-scoping).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenancy & identity ──
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'trial',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member' | 'viewer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

-- ── Events & North-Star (Layer 1: pre-event intelligence) ──
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'planning',
  -- The single source of truth: goals, KPIs, target ICP, brand voice, themes.
  -- Everything downstream is measured against this. Port: Forge voice_profile
  -- + brand_profiles.settings.factualGround.
  north_star JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_org ON events (organization_id);

CREATE TABLE IF NOT EXISTS event_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  metric TEXT NOT NULL,           -- 'registrations' | 'pipeline_usd' | 'icp_match_rate' | ...
  target NUMERIC,
  current NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kpis_event ON event_kpis (event_id);

-- ── Connector Fabric (Layers 2/4/5/6: BYO tools) ──
-- Credentials live in Nango's vault; we persist only the connection reference.
CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,         -- registry id, e.g. 'sandbox-gtm','hubspot'
  nango_connection_id TEXT,       -- reference into Nango (no secrets stored here)
  direction TEXT NOT NULL DEFAULT 'inbound',
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'error' | 'revoked'
  config JSONB NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_connections_org ON connections (organization_id);

-- ── Unified Event Record / golden record (Layer 3 data) ──
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT,
  domain TEXT,
  icp_match NUMERIC,              -- 0..1 fit against North-Star ICP
  attributes JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts (organization_id);
CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts (organization_id, domain);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  identity_key TEXT,              -- deterministic resolution key ('email:'/'phone:')
  email TEXT,
  phone TEXT,
  full_name TEXT,
  title TEXT,
  -- lead → registered → checked_in → session_attended → lead_scanned → opportunity
  lifecycle_stage TEXT NOT NULL DEFAULT 'lead',
  attributes JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_identity
  ON contacts (organization_id, identity_key) WHERE identity_key IS NOT NULL;

-- Maps each raw source record to its resolved golden contact (merge audit).
CREATE TABLE IF NOT EXISTS identity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_provider TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'deterministic',  -- 'deterministic' | 'probabilistic' | 'manual'
  confidence NUMERIC DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source_provider, source_record_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  track TEXT,
  starts_at TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_event ON sessions (event_id);

CREATE TABLE IF NOT EXISTS session_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  attended BOOLEAN DEFAULT false,
  dwell_seconds INTEGER DEFAULT 0,
  UNIQUE (session_id, contact_id)
);

-- Normalized cross-tool activity stream — the spine of the record.
CREATE TABLE IF NOT EXISTS engagements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  source_provider TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'registered'|'checked_in'|'session_attended'|'lead_scanned'|'meeting'|'content_view'
  weight NUMERIC DEFAULT 1.0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_engagements_contact ON engagements (organization_id, contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagements_event ON engagements (event_id, kind);

-- ── Consistency Engine (the forensic AI) ──
CREATE TABLE IF NOT EXISTS consistency_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,        -- 'kpi'|'voice'|'audience'|'content'|'context'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info'|'warn'|'critical'
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',     -- 'open'|'acknowledged'|'resolved'|'dismissed'
  source_provider TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signals_event ON consistency_signals (event_id, status, severity);

-- ── Sales Readiness & Handoff (Layer 7) ──
CREATE TABLE IF NOT EXISTS readiness_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  score NUMERIC NOT NULL DEFAULT 0,
  tier TEXT,                      -- 'hot' | 'warm' | 'cold'
  rationale JSONB NOT NULL DEFAULT '{}',
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_readiness_event ON readiness_scores (event_id, score DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,      -- 'hubspot' | 'salesforce' | 'attio'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'error'
  external_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_handoffs_event ON handoffs (event_id, status);

-- ── Cross-event Brain (compounding intelligence) ──
-- Port: Forge brain_patterns / brain_mistakes + Brain-First Protocol.
CREATE TABLE IF NOT EXISTS playbook_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pattern_type TEXT,
  description TEXT,
  confidence NUMERIC DEFAULT 0,
  success_rate NUMERIC DEFAULT 0,
  tags JSONB DEFAULT '[]',
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playbook_mistakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mistake_type TEXT,
  description TEXT,
  human_feedback TEXT,
  guardrail TEXT,
  severity TEXT DEFAULT 'low',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Infosec & AI audit ──
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  model TEXT,
  tokens_used INTEGER,
  latency_ms INTEGER,
  status TEXT DEFAULT 'complete',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
