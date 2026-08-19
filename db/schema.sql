-- ===========================================================================
-- refer.GemzOnline — database schema
-- Target: PostgreSQL 15+ (Supabase)
--
-- Apply with:  npm run db:push
-- Idempotent — safe to run again after every deploy.
--
-- MULTI-TENANCY: every table carries tenant_id and every unique constraint is
-- scoped per tenant. The app runs as a single tenant today; selling it to
-- external clients later is product work, not a data migration.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin create type user_role         as enum ('admin', 'agent'); exception when duplicate_object then null; end $$;
do $$ begin create type lead_status       as enum ('new', 'contacted', 'appointment_set', 'closed_won', 'closed_lost'); exception when duplicate_object then null; end $$;
do $$ begin create type commission_kind   as enum ('initial', 'recurring'); exception when duplicate_object then null; end $$;
do $$ begin create type commission_status as enum ('pending', 'approved', 'paid', 'void'); exception when duplicate_object then null; end $$;
do $$ begin create type rate_type         as enum ('percentage', 'fixed'); exception when duplicate_object then null; end $$;
do $$ begin create type note_kind         as enum ('note', 'status_change', 'email', 'whatsapp', 'system', 'call', 'meeting', 'prospect'); exception when duplicate_object then null; end $$;
do $$ begin create type send_status       as enum ('sent', 'failed', 'skipped'); exception when duplicate_object then null; end $$;
do $$ begin create type channel           as enum ('email', 'whatsapp'); exception when duplicate_object then null; end $$;
do $$ begin create type offset_unit       as enum ('hours', 'days'); exception when duplicate_object then null; end $$;
do $$ begin create type appointment_slot  as enum ('primary', 'backup'); exception when duplicate_object then null; end $$;
do $$ begin create type actor_type        as enum ('admin', 'agent', 'prospect', 'system'); exception when duplicate_object then null; end $$;
do $$ begin create type recipient_type    as enum ('lead', 'agent', 'admin'); exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
create table if not exists tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  status     text not null default 'active',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles — one row per Supabase auth user (admins and agents)
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id               uuid primary key,                       -- = auth.users.id
  tenant_id        uuid not null references tenants(id) on delete cascade,
  email            text not null,
  full_name        text not null default '',
  role             user_role not null default 'agent',
  phone            text,
  whatsapp_number  text,
  timezone         text not null default 'America/Jamaica',
  company          text,
  country          text,
  avatar_url       text,
  auth_provider    text not null default 'password',       -- password | google
  payout_method    text,
  payout_details   text,
  status           text not null default 'active',         -- active | suspended
  notes            text,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists profiles_tenant_email_idx on profiles(tenant_id, lower(email));
create index if not exists profiles_role_idx   on profiles(tenant_id, role);
create index if not exists profiles_status_idx on profiles(tenant_id, status);

-- ---------------------------------------------------------------------------
-- campaigns (programs)
-- ---------------------------------------------------------------------------
create table if not exists campaigns (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  name                text not null,
  slug                text not null,
  client_name         text,
  description         text,
  status              text not null default 'active',       -- active | paused | archived
  currency            text not null default 'USD',

  -- Public page content
  headline            text,
  hero_subtext        text,
  cta_label           text not null default 'Get Started',
  hero_illustration   text not null default 'default',
  thank_you_message   text,

  -- "Click here for more information" — external, opens in a new tab
  landing_page_url    text,
  landing_link_label  text not null default 'Click here for more information',

  -- Funnel behaviour
  requires_appointment boolean not null default true,
  requires_consent     boolean not null default true,
  consent_text         text,
  terms_url            text,

  -- Extra questions on the lead form:
  -- [{"key":"budget","label":"Monthly budget","type":"text|textarea|select|number",
  --   "required":true,"options":["A","B"],"help":"..."}]
  custom_fields       jsonb not null default '[]'::jsonb,

  notify_emails       text,          -- comma separated internal recipients
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists campaigns_tenant_slug_idx on campaigns(tenant_id, slug);
create index if not exists campaigns_status_idx on campaigns(tenant_id, status);

-- ---------------------------------------------------------------------------
-- commission_profiles — named RANKS belonging to a campaign.
-- The profile's deal_value is authoritative: there is no per-lead override.
-- ---------------------------------------------------------------------------
create table if not exists commission_profiles (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  name              text not null,                    -- "Standard", "Senior", "Partner"
  description       text,
  is_default        boolean not null default false,
  rank_order        integer not null default 0,

  initial_type      rate_type not null default 'percentage',
  initial_value     numeric(12,2) not null default 0,

  recurring_enabled boolean not null default false,
  recurring_type    rate_type not null default 'percentage',
  recurring_value   numeric(12,2) not null default 0,
  recurring_months  integer,                          -- null = while account active
  payout_day        integer not null default 15 check (payout_day between 1 and 28),

  -- The basis percentage commissions calculate from. Not editable per lead.
  deal_value        numeric(12,2) not null default 0,
  currency          text not null default 'USD',
  status            text not null default 'active',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists commission_profiles_name_idx
  on commission_profiles(tenant_id, campaign_id, lower(name));
-- exactly one default per campaign
create unique index if not exists commission_profiles_default_idx
  on commission_profiles(campaign_id) where is_default;

-- ---------------------------------------------------------------------------
-- campaign_members — an agent's membership of a campaign.
-- The unique constraint enforces ONE commission profile per agent per campaign.
-- ---------------------------------------------------------------------------
create table if not exists campaign_members (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  campaign_id           uuid not null references campaigns(id) on delete cascade,
  agent_id              uuid not null references profiles(id) on delete cascade,
  commission_profile_id uuid references commission_profiles(id) on delete set null,
  status                text not null default 'active',   -- active | left | removed
  joined_at             timestamptz not null default now(),
  left_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (campaign_id, agent_id)
);

create index if not exists campaign_members_agent_idx on campaign_members(tenant_id, agent_id);

-- ---------------------------------------------------------------------------
-- referral_links
-- ---------------------------------------------------------------------------
create table if not exists referral_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  member_id     uuid not null references campaign_members(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  agent_id      uuid not null references profiles(id) on delete cascade,
  slug          text not null,
  label         text,
  active        boolean not null default true,
  clicks        integer not null default 0,
  last_click_at timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists referral_links_slug_idx on referral_links(tenant_id, slug);
create index if not exists referral_links_agent_idx on referral_links(tenant_id, agent_id);

-- ---------------------------------------------------------------------------
-- relation_options — admin-editable "how does the agent know this prospect"
-- ---------------------------------------------------------------------------
create table if not exists relation_options (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  code       text not null,
  label      text not null,
  sort_order integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists relation_options_code_idx on relation_options(tenant_id, code);

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  reference         text not null,
  access_token      text not null,                   -- prospect self-service link
  campaign_id       uuid not null references campaigns(id) on delete restrict,
  agent_id          uuid references profiles(id) on delete set null,
  member_id         uuid references campaign_members(id) on delete set null,
  referral_link_id  uuid references referral_links(id) on delete set null,

  first_name        text not null default '',
  last_name         text not null default '',
  email             text not null,
  phone             text,
  whatsapp_number   text,
  whatsapp_opt_in   boolean not null default false,
  company           text,
  address           text,
  city              text,
  region            text,
  country           text,
  timezone          text not null default 'America/Jamaica',
  custom            jsonb not null default '{}'::jsonb,

  status            lead_status not null default 'new',

  -- Agent-set relation to the prospect, used to add credibility on the call
  relation_code     text,
  relation_note     text,

  -- Consent
  consent_given     boolean not null default false,
  consent_at        timestamptz,
  consent_ip        text,
  consent_name      text,

  -- Appointments (UTC; `timezone` is how the prospect entered them)
  appointment_primary_at timestamptz,
  appointment_backup_at  timestamptz,
  confirmed_slot         appointment_slot,          -- null = primary assumed

  -- Recurring revenue
  account_active     boolean not null default false,
  account_started_on date,
  account_dropped_at timestamptz,

  cancelled_by_prospect boolean not null default false,
  cancel_reason      text,
  suppress_email     boolean not null default false,

  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  landing_url       text,
  user_agent        text,
  ip_address        text,

  closed_at         timestamptz,
  last_contacted_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists leads_reference_idx on leads(tenant_id, reference);
create unique index if not exists leads_token_idx     on leads(access_token);
create index if not exists leads_campaign_idx on leads(tenant_id, campaign_id);
create index if not exists leads_agent_idx    on leads(tenant_id, agent_id);
create index if not exists leads_status_idx   on leads(tenant_id, status);
create index if not exists leads_created_idx  on leads(tenant_id, created_at desc);
create index if not exists leads_email_idx    on leads(tenant_id, lower(email));
create index if not exists leads_appt_idx     on leads(appointment_primary_at)
  where status not in ('closed_won', 'closed_lost');
create index if not exists leads_account_idx  on leads(tenant_id) where account_active;

-- ---------------------------------------------------------------------------
-- lead_notes — timestamped interaction log
-- ---------------------------------------------------------------------------
create table if not exists lead_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  author_name text,
  kind        note_kind not null default 'note',
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists lead_notes_lead_idx on lead_notes(lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- commissions
-- ---------------------------------------------------------------------------
create table if not exists commissions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  lead_id               uuid references leads(id) on delete cascade,
  agent_id              uuid not null references profiles(id) on delete cascade,
  campaign_id           uuid not null references campaigns(id) on delete cascade,
  commission_profile_id uuid references commission_profiles(id) on delete set null,
  kind                  commission_kind not null default 'initial',
  amount                numeric(12,2) not null default 0,
  currency              text not null default 'USD',
  basis_amount          numeric(12,2) not null default 0,
  rate_label            text,
  period                date not null default date_trunc('month', now())::date,
  status                commission_status not null default 'pending',
  payout_date           date,
  paid_at               timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (lead_id, kind, period)
);

create index if not exists commissions_agent_idx  on commissions(tenant_id, agent_id, period desc);
create index if not exists commissions_status_idx on commissions(tenant_id, status);

-- ---------------------------------------------------------------------------
-- notification_templates — email (freely editable) and WhatsApp (references a
-- Meta-approved template by name; wording cannot be changed here)
-- ---------------------------------------------------------------------------
create table if not exists notification_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  channel       channel not null default 'email',
  name          text not null,
  slug          text not null,
  campaign_id   uuid references campaigns(id) on delete cascade,
  trigger_event text,                       -- null = manual only
  send_to       recipient_type not null default 'lead',
  active        boolean not null default true,

  -- Email
  subject       text not null default '',
  body_html     text not null default '',
  design_json   jsonb,

  -- WhatsApp: the Meta-approved template name plus ordered variable mapping,
  -- e.g. {"body":["lead.first_name","program.name"],"button":["lead.manage_url"]}
  wa_template_name text,
  wa_language      text default 'en_US',
  wa_variable_map  jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists notification_templates_slug_idx on notification_templates(tenant_id, slug);
create index if not exists notification_templates_trigger_idx
  on notification_templates(tenant_id, trigger_event) where active;

-- ---------------------------------------------------------------------------
-- notification_log — every dispatch on every channel
-- ---------------------------------------------------------------------------
create table if not exists notification_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  channel       channel not null default 'email',
  template_id   uuid references notification_templates(id) on delete set null,
  lead_id       uuid references leads(id) on delete set null,
  agent_id      uuid references profiles(id) on delete set null,
  to_address    text not null,
  recipient     recipient_type,
  subject       text not null default '',
  body          text,
  trigger_event text,
  reminder_slot smallint,
  status        send_status not null default 'sent',
  error         text,
  provider_message_id text,
  sent_by       uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists notification_log_created_idx on notification_log(tenant_id, created_at desc);
create index if not exists notification_log_lead_idx    on notification_log(lead_id);

-- ---------------------------------------------------------------------------
-- notification_prefs — per user, per event, per channel.
--
-- Resolution is asymmetric and deliberate:
--   admin_enabled = false  -> HARD BLOCK, the user cannot re-enable it
--   admin_enabled = true   -> a default; user_enabled = false mutes it
-- Effective = admin_enabled AND user_enabled.
-- ---------------------------------------------------------------------------
create table if not exists notification_prefs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  event_key     text not null,
  channel       channel not null,
  user_enabled  boolean not null default true,
  admin_enabled boolean not null default true,
  updated_at    timestamptz not null default now(),
  unique (user_id, event_key, channel)
);

create index if not exists notification_prefs_user_idx on notification_prefs(tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- campaign_reminders — three slots per campaign, all default off
-- ---------------------------------------------------------------------------
create table if not exists campaign_reminders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  slot             smallint not null check (slot between 1 and 3),
  active           boolean not null default false,
  offset_value     integer not null default 1,
  offset_unit      offset_unit not null default 'days',
  channel_email    boolean not null default false,
  channel_whatsapp boolean not null default false,
  to_prospect      boolean not null default true,
  to_agent         boolean not null default false,
  to_admin         boolean not null default false,
  template_id      uuid references notification_templates(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (campaign_id, slot)
);

-- ---------------------------------------------------------------------------
-- reminder_sends — idempotency guard so a reminder never fires twice
-- ---------------------------------------------------------------------------
create table if not exists reminder_sends (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  lead_id        uuid not null references leads(id) on delete cascade,
  slot           smallint not null,
  channel        channel not null,
  recipient      recipient_type not null,
  appointment_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (lead_id, slot, channel, recipient, appointment_at)
);

-- ---------------------------------------------------------------------------
-- audit_log — append-only
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  actor_name  text,
  actor_type  actor_type not null default 'system',
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  summary     text,
  before      jsonb,
  after       jsonb,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log(tenant_id, created_at desc);
create index if not exists audit_log_entity_idx  on audit_log(entity_type, entity_id);
create index if not exists audit_log_actor_idx   on audit_log(tenant_id, actor_id);

-- ---------------------------------------------------------------------------
-- job_runs — scheduler audit
-- ---------------------------------------------------------------------------
create table if not exists job_runs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete cascade,
  job        text not null,
  status     text not null default 'ok',
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists job_runs_created_idx on job_runs(job, created_at desc);

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
create table if not exists settings (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'tenants','profiles','campaigns','commission_profiles','campaign_members',
    'leads','commissions','notification_templates','campaign_reminders'
  ]
  loop
    execute format('drop trigger if exists trg_%1$s_updated on %1$I', t);
    execute format('create trigger trg_%1$s_updated before update on %1$I
                    for each row execute function set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security lives in db/policies.sql (Supabase only — it depends on
-- the `auth` schema). `npm run db:push` applies it automatically when the
-- target database has Supabase Auth installed.
-- ---------------------------------------------------------------------------
