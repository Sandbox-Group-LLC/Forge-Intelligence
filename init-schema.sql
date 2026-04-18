-- Forge Intelligence — Database Schema
-- Run against a fresh Neon project to initialize all tables

-- ── Core ──
CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_url TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  cache_status TEXT NOT NULL DEFAULT 'fresh',
  profile_data JSONB NOT NULL DEFAULT '{}',
  settings JSONB NOT NULL DEFAULT '{}',
  article_base_url TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  article_url_suffix TEXT DEFAULT '',
  clerk_user_id TEXT,
  expires_at TIMESTAMPTZ,
  is_paid BOOLEAN DEFAULT false,
  onboard_session_id TEXT,
  digest_unsubscribed BOOLEAN DEFAULT false,
  digest_unsubscribe_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bp_active_url ON brand_profiles (brand_url) WHERE is_active = true;

-- ── Brain ──
CREATE TABLE IF NOT EXISTS brain_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  pattern_type VARCHAR,
  description TEXT,
  confidence_score DOUBLE PRECISION DEFAULT 0,
  success_rate DOUBLE PRECISION DEFAULT 0,
  tags JSONB DEFAULT '[]',
  source_channel TEXT,
  example_titles JSONB DEFAULT '[]',
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS brain_mistakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  mistake_type VARCHAR,
  description TEXT,
  human_feedback TEXT,
  guardrail_created TEXT,
  severity VARCHAR DEFAULT 'low',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── GEO ──
CREATE TABLE IF NOT EXISTS geo_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  brand_profile_id TEXT,
  geo_opportunity_score VARCHAR,
  target_entities JSONB,
  schema_requirements JSONB,
  structured_brief JSONB,
  opportunity_score INTEGER DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  brand_url TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT '',
  brief_data JSONB NOT NULL DEFAULT '{}',
  brain_version INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geo_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  brain_version INTEGER NOT NULL DEFAULT 1,
  topic TEXT NOT NULL,
  platform_scores JSONB NOT NULL DEFAULT '{}',
  avg_score NUMERIC DEFAULT 0,
  quick_win BOOLEAN DEFAULT false,
  topical_authority_context TEXT DEFAULT '',
  intent_signals JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'discovered',
  discovery_session_id UUID,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geo_topic_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES geo_opportunities(id) ON DELETE CASCADE,
  brand_profile_id TEXT NOT NULL,
  brief_data JSONB NOT NULL DEFAULT '{}',
  brain_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'briefed',
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geo_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  query TEXT NOT NULL,
  is_cited BOOLEAN DEFAULT false,
  cited_url TEXT,
  cited_section TEXT,
  response_snippet TEXT,
  raw_citations JSONB DEFAULT '[]',
  checked_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Enrichment ──
CREATE TABLE IF NOT EXISTS enriched_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  geo_brief_id UUID,
  enriched_brief JSONB,
  e_e_a_t_injections JSONB,
  sme_quotes JSONB,
  human_flags JSONB,
  confidence_score DOUBLE PRECISION,
  status VARCHAR DEFAULT 'pending_review',
  brand_profile_id TEXT NOT NULL DEFAULT '',
  brand_url TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  enriched_data JSONB NOT NULL DEFAULT '{}',
  article_base_url TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}',
  article_url_suffix TEXT DEFAULT '',
  brain_version INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Competitive Intelligence ──
CREATE TABLE IF NOT EXISTS competitive_intelligence (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  competitor_url TEXT NOT NULL,
  competitor_name TEXT,
  pva_data JSONB DEFAULT '[]',
  fault_lines_data JSONB DEFAULT '[]',
  scraped_content_length INTEGER DEFAULT 0,
  raw_scrape_summary TEXT,
  version INTEGER DEFAULT 1,
  brain_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brand_profile_id, competitor_url)
);

-- ── Publishing ──
CREATE TABLE IF NOT EXISTS publishing_queue (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  title TEXT,
  channels JSONB NOT NULL DEFAULT '[]',
  status VARCHAR DEFAULT 'staged',
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  publish_results JSONB DEFAULT '{}',
  campaign_id UUID,
  hero_image_url TEXT,
  review_token TEXT,
  review_status TEXT,
  review_comment TEXT,
  review_requested_at TIMESTAMPTZ,
  review_actioned_at TIMESTAMPTZ,
  reviewer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS publishing_channels (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  channel VARCHAR NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  utm_template JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  last_tested_at TIMESTAMPTZ,
  test_status VARCHAR DEFAULT 'untested',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brand_profile_id, channel)
);

CREATE TABLE IF NOT EXISTS publish_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  queue_item_id TEXT NOT NULL,
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  channel VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  response_data JSONB,
  utm_params JSONB,
  published_url TEXT,
  error_message TEXT,
  live_status VARCHAR DEFAULT 'published',
  last_synced_at TIMESTAMPTZ,
  synced_count INTEGER DEFAULT 0,
  published_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Analytics ──
CREATE TABLE IF NOT EXISTS content_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  post_id TEXT,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  reactions INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  ctr DOUBLE PRECISION DEFAULT 0,
  engagement_rate DOUBLE PRECISION DEFAULT 0,
  raw_data JSONB DEFAULT '{}',
  published_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  campaign_id UUID,
  reading_time INTEGER DEFAULT 0,
  positive_feedback INTEGER DEFAULT 0,
  negative_feedback INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS precog_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  predicted_score INTEGER NOT NULL,
  predicted_tier TEXT NOT NULL,
  predicted_impressions_low INTEGER,
  predicted_impressions_high INTEGER,
  predicted_signal TEXT NOT NULL,
  avg_impressions_at_prediction DOUBLE PRECISION,
  scored_at TIMESTAMPTZ DEFAULT NOW(),
  actual_impressions INTEGER,
  actual_clicks INTEGER,
  direction_correct BOOLEAN,
  in_range BOOLEAN,
  measured_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS decay_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT,
  peak_impressions INTEGER DEFAULT 0,
  peak_clicks INTEGER DEFAULT 0,
  current_impressions INTEGER DEFAULT 0,
  current_clicks INTEGER DEFAULT 0,
  decay_score DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'active',
  recommended_action TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ── Campaigns ──
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  topic_cluster TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  plan JSONB NOT NULL,
  hubspot_synced_at TIMESTAMPTZ,
  hubspot_campaign_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  brand_profile_id TEXT NOT NULL,
  article_index INTEGER NOT NULL,
  angle_profile JSONB NOT NULL,
  week_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  generated_content JSONB,
  image_url TEXT,
  image_prompt TEXT,
  brand_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Email ──
CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  brief JSONB NOT NULL,
  status VARCHAR DEFAULT 'pending',
  sequence_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_campaign_emails (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id TEXT NOT NULL,
  email_index INTEGER NOT NULL,
  job TEXT,
  send_day INTEGER DEFAULT 0,
  subject_lines JSONB,
  preview_text TEXT,
  body TEXT,
  cta_text TEXT,
  cta_url_placeholder TEXT,
  ps TEXT,
  confidence_score INTEGER,
  confidence_reason TEXT,
  flags JSONB DEFAULT '[]',
  status VARCHAR DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_brief_templates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brief JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Infrastructure ──
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  brand_profile_id UUID,
  agent_name TEXT,
  stage INTEGER,
  input_summary JSONB,
  output_summary JSONB,
  tokens_used INTEGER,
  latency_ms INTEGER,
  status TEXT DEFAULT 'complete',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_coordination (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  agent_id VARCHAR,
  stage INTEGER,
  query_made TEXT,
  memory_retrieved JSONB,
  decision_made TEXT,
  outcome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviewers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topic_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id UUID NOT NULL,
  topic TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'idea',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_profile_id TEXT NOT NULL,
  order_id TEXT,
  amount NUMERIC DEFAULT 99.00,
  currency VARCHAR DEFAULT 'USD',
  source VARCHAR DEFAULT 'paypal',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  brand_profile_id TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hubspot_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id TEXT NOT NULL,
  hubspot_campaign_id TEXT,
  content_id TEXT,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT NOT NULL,
  company TEXT,
  title TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  email TEXT NOT NULL,
  subject TEXT,
  resend_id TEXT,
  status TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
