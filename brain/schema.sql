-- Forge by Sandbox: Client Brain Schema
-- Run against each per-client NeonDB instance on provisioning

CREATE EXTENSION IF NOT EXISTS vector;

-- Memories: vectorized content + performance outcomes
CREATE TABLE IF NOT EXISTS memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL,
  content_id  UUID,
  embedding   vector(1024),
  raw_content TEXT,
  metadata    JSONB,
  performance_outcome JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Patterns: what worked (promoted by Pattern Extractor Agent)
CREATE TABLE IF NOT EXISTS patterns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL,
  pattern_type     VARCHAR(100),
  success_rate     FLOAT,
  confidence_score FLOAT,
  example_content_id UUID,
  recency_weight   FLOAT DEFAULT 1.0,
  tags             JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Mistakes: what failed + auto-generated guardrails
CREATE TABLE IF NOT EXISTS mistakes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL,
  mistake_type        VARCHAR(100),
  content_id          UUID,
  human_feedback      TEXT,
  agent_fix_applied   TEXT,
  guardrail_created   TEXT,
  severity            VARCHAR(20) CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Coordination: shared decision log across all agents
CREATE TABLE IF NOT EXISTS agent_coordination (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL,
  agent_id         VARCHAR(100),
  stage            INTEGER,
  query_made       TEXT,
  memory_retrieved JSONB,
  decision_made    TEXT,
  outcome          TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Brand Intelligence Profiles (Stage 1 output)
CREATE TABLE IF NOT EXISTS brand_profiles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL UNIQUE,
  voice_profile  JSONB,
  personas       JSONB,
  third_party_signals JSONB,
  competitive_gaps    JSONB,
  last_scraped   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- GEO Briefs (Stage 2 output)
CREATE TABLE IF NOT EXISTS geo_briefs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID NOT NULL,
  brand_profile_id     UUID REFERENCES brand_profiles(id),
  geo_opportunity_score VARCHAR(10),
  target_entities      JSONB,
  schema_requirements  JSONB,
  structured_brief     JSONB,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Enriched Briefs (Stage 3 output — ready for generation)
CREATE TABLE IF NOT EXISTS enriched_briefs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL,
  geo_brief_id    UUID REFERENCES geo_briefs(id),
  enriched_brief  JSONB,
  e_e_a_t_injections JSONB,
  sme_quotes      JSONB,
  human_flags     JSONB,
  confidence_score FLOAT,
  status          VARCHAR(50) DEFAULT 'pending_review',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast vector similarity search on memories
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);
