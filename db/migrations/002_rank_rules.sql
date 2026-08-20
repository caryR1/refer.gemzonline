-- ---------------------------------------------------------------------------
-- 002 — rank rules
--
-- Three decisions made explicit in the schema:
--
--   1. The rank that pays is the rank the lead was REFERRED under, not the one
--      the agent happens to hold when an admin gets round to closing it. The
--      lead now carries a snapshot of its terms, taken at referral.
--
--   2. Editing a rank affects new work only. Because the terms live on the
--      lead, changing a rate or a deal value cannot reach backwards into leads
--      already in flight or recurring accounts already running.
--
--   3. A rank can declare what earns it, and the scheduler promotes agents who
--      qualify. Promotion only ever moves an agent up.
--
-- Plus one outright bug: a lead could be paid its initial commission twice.
--
-- Idempotent throughout. Applied in filename order by `npm run db:push`.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- The double-pay path
--
-- Uniqueness was (lead_id, kind, period). Closing a lead in August wrote an
-- initial commission for period 2026-08-01. Nothing stopped an admin moving the
-- status away and closing it again — and in September that is a different
-- period, a different key, and a SECOND initial commission on the same lead. If
-- the first had already been marked paid, the money was gone and the totals
-- agreed with themselves.
--
-- A lead is only closed once, so it only earns one initial commission, whatever
-- month it happens in. Voided rows are excluded so a genuine mistake can still
-- be voided and redone.
-- ---------------------------------------------------------------------------
do $$
declare
  v_dupes int;
begin
  -- Any duplicates already in the data would make the index creation fail.
  -- Void the later ones rather than deleting: the record of what happened is
  -- worth more than a tidy table.
  with ranked as (
    select id, row_number() over (partition by lead_id order by created_at, id) as n
      from commissions
     where kind = 'initial' and status <> 'void'
  )
  update commissions c
     set status = 'void',
         notes  = trim(both E'\n' from coalesce(c.notes, '')
                  || E'\n' || 'Voided by migration 002: a second initial commission '
                  || 'existed for this lead, which the old uniqueness rule allowed.')
    from ranked r
   where r.id = c.id and r.n > 1;

  get diagnostics v_dupes = row_count;
  if v_dupes > 0 then
    raise notice 'Voided % duplicate initial commission(s). Review them before paying anyone.', v_dupes;
  end if;
end $$;

create unique index if not exists commissions_one_initial_per_lead
  on commissions (lead_id)
  where kind = 'initial' and status <> 'void';

-- ---------------------------------------------------------------------------
-- Leads carry their own terms
--
-- `terms` is a snapshot of the rank as it stood at referral, in exactly the
-- shape src/lib/commission-math.js expects: initial_type, initial_value,
-- recurring_enabled, recurring_type, recurring_value, recurring_months,
-- payout_day, deal_value, currency. Same keys as a commission_profiles row, so
-- the maths does not care which one it is handed.
--
-- Nullable on purpose: a lead with no referring agent has no rank, and leads
-- created before this migration have no snapshot and fall back to the live
-- rank, exactly as they did before.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists commission_profile_id uuid
  references commission_profiles(id) on delete set null;
alter table leads add column if not exists terms             jsonb;
alter table leads add column if not exists terms_captured_at timestamptz;

comment on column leads.commission_profile_id is
  'The rank the agent held when this lead was referred. The rank that pays.';
comment on column leads.terms is
  'Snapshot of that rank''s terms at referral. Editing the rank afterwards does not change this.';

create index if not exists leads_commission_profile_idx
  on leads (commission_profile_id) where commission_profile_id is not null;

-- Existing leads keep behaving as they did: stamp the rank they would have
-- resolved to anyway. No terms snapshot — they fall back to the live rank, so
-- nothing changes underneath work already in progress.
update leads l
   set commission_profile_id = cm.commission_profile_id
  from campaign_members cm
 where cm.campaign_id = l.campaign_id
   and cm.agent_id = l.agent_id
   and l.agent_id is not null
   and l.commission_profile_id is null
   and cm.commission_profile_id is not null;

-- ---------------------------------------------------------------------------
-- The campaign owns what a deal is worth, and what currency it is in
--
-- Deal value described the product, not the agent, but it lived on the rank —
-- so every rank had to repeat it, they drifted apart, and "make her senior"
-- invited changing what the deal was worth rather than her rate.
--
-- Currency was worse. Two ranks on one campaign could be in different
-- currencies, and the totals sum amounts with no grouping — so a mixed-currency
-- campaign produced a number that was simply wrong and looked fine.
--
-- Now: the campaign holds both. A rank may still override the value (null means
-- inherit), and the campaign's currency is the only currency.
-- ---------------------------------------------------------------------------
alter table campaigns add column if not exists deal_value numeric(12,2) not null default 0;

comment on column campaigns.deal_value is
  'What one deal on this campaign is worth. Ranks inherit it unless they set their own.';

alter table commission_profiles alter column deal_value drop not null;
alter table commission_profiles alter column deal_value drop default;

comment on column commission_profiles.deal_value is
  'Overrides the campaign deal value for this rank. Null means inherit.';
comment on column commission_profiles.currency is
  'DEPRECATED — kept in step with the campaign. The campaign currency is authoritative.';

-- Give each campaign a deal value before ranks start inheriting one, so nothing
-- silently starts calculating from zero.
update campaigns c
   set deal_value = sub.value
  from (
    select campaign_id, max(deal_value) as value
      from commission_profiles
     where deal_value is not null and deal_value > 0
     group by campaign_id
  ) sub
 where sub.campaign_id = c.id and c.deal_value = 0;

-- Bring every rank's currency into line with its campaign, so the two can never
-- be read as disagreeing during the changeover.
update commission_profiles cp
   set currency = c.currency
  from campaigns c
 where c.id = cp.campaign_id
   and cp.currency is distinct from c.currency;

-- ---------------------------------------------------------------------------
-- What earns a rank
--
-- Thresholds are declared on the rank being earned, not the one being left, so
-- reading a rank tells you how to get it. Both are optional; an agent must meet
-- every threshold that IS set, which makes adding a second one a tightening
-- rather than a surprise widening.
-- ---------------------------------------------------------------------------
alter table commission_profiles add column if not exists auto_promote boolean not null default false;
alter table commission_profiles add column if not exists promote_after_deals  integer;
alter table commission_profiles add column if not exists promote_after_amount numeric(12,2);

comment on column commission_profiles.auto_promote is
  'Promote agents who meet every threshold below. Promotion only ever moves an agent up.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'commission_profiles_promote_deals_ck') then
    alter table commission_profiles add constraint commission_profiles_promote_deals_ck
      check (promote_after_deals is null or promote_after_deals > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'commission_profiles_promote_amount_ck') then
    alter table commission_profiles add constraint commission_profiles_promote_amount_ck
      check (promote_after_amount is null or promote_after_amount > 0);
  end if;

  -- A rank that promotes automatically but names no threshold would promote
  -- everybody the first time the job ran.
  if not exists (select 1 from pg_constraint where conname = 'commission_profiles_promote_needs_rule_ck') then
    alter table commission_profiles add constraint commission_profiles_promote_needs_rule_ck
      check (
        auto_promote is false
        or promote_after_deals is not null
        or promote_after_amount is not null
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- When a rank took effect, and who set it
--
-- The audit log records when someone clicked. That is not the same as when a
-- promotion was meant to start, and "senior as of 1 August" is a normal thing
-- to want to say.
-- ---------------------------------------------------------------------------
alter table campaign_members add column if not exists rank_effective_from date;
alter table campaign_members add column if not exists rank_set_by text not null default 'join';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaign_members_rank_set_by_ck') then
    alter table campaign_members add constraint campaign_members_rank_set_by_ck
      check (rank_set_by in ('join', 'admin', 'auto'));
  end if;
end $$;

update campaign_members
   set rank_effective_from = joined_at::date
 where rank_effective_from is null and commission_profile_id is not null;

-- Finding who is due a promotion is the query the scheduler runs every night.
create index if not exists campaign_members_active_idx
  on campaign_members (campaign_id, agent_id) where status = 'active';

commit;
