-- ---------------------------------------------------------------------------
-- 003 — several products per campaign, and undoing a close
--
-- Products: a campaign rarely sells one thing at one price. What a deal is
-- worth belongs to the product that was sold, not to the campaign and not to
-- the agent's rank. So the layering becomes:
--
--     the RANK sets the rate.  the PRODUCT sets the value.
--
-- Nobody types a number anywhere — a product is picked from a list you defined,
-- which keeps the original rule that profiles, not people, decide what a deal
-- is worth.
--
-- Reopening: closing a lead creates money, and until now undoing it was a
-- dropdown that left the commission behind. A paid commission can now be
-- reversed rather than erased.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- What a campaign sells
-- ---------------------------------------------------------------------------
create table if not exists campaign_products (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name        text not null,
  code        text,
  description text,
  value       numeric(12,2) not null default 0,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table campaign_products is
  'What a campaign sells. The value here is the basis a rank''s percentage calculates from.';

-- Two products with the same name on one campaign would be indistinguishable in
-- the dropdown an admin picks from at close.
create unique index if not exists campaign_products_name_idx
  on campaign_products (campaign_id, lower(name));

create index if not exists campaign_products_campaign_idx
  on campaign_products (campaign_id, sort_order) where active;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaign_products_value_ck') then
    alter table campaign_products add constraint campaign_products_value_ck
      check (value >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Which product a lead is about
--
-- Two fields, because interest and purchase are different things and conflating
-- them is how an agent ends up paid on what somebody idly ticked.
--
--   product_interest_id — what the prospect said on the form. Useful on the
--                         call. Never decides money.
--   product_id          — what the admin confirmed at close. This decides money.
--
-- The name and value are copied alongside the id at the moment of closing, so a
-- later price change cannot re-price a deal that is already done — the same
-- rule the rank snapshot follows.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists product_interest_id uuid
  references campaign_products(id) on delete set null;
alter table leads add column if not exists product_id uuid
  references campaign_products(id) on delete set null;
alter table leads add column if not exists product_name  text;
alter table leads add column if not exists product_value numeric(12,2);

comment on column leads.product_interest_id is
  'What the prospect said they were interested in on the form. Never used to calculate a commission.';
comment on column leads.product_id is
  'What was actually sold, confirmed by an admin at close. Sets the commission basis.';
comment on column leads.product_value is
  'The product''s value at the moment of closing. Editing the product later does not reach back here.';

create index if not exists leads_product_idx on leads (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- Reversals
--
-- When a lead is reopened after its commission was already PAID, the payment is
-- not erased — the money genuinely left the account and a record saying
-- otherwise is a lie that surfaces at the worst possible moment. Instead a
-- matching negative entry is posted beside it. The two net to zero, the totals
-- come back to correct, and a statement reads honestly: paid, then reversed.
--
-- A reversal is an ordinary commission row with a negative amount and a pointer
-- to what it reverses.
-- ---------------------------------------------------------------------------
alter table commissions add column if not exists reverses_id uuid
  references commissions(id) on delete set null;
alter table commissions add column if not exists reversal_reason text;

comment on column commissions.reverses_id is
  'Set on a negative entry that cancels an earlier paid commission. The original is left untouched.';

-- The uniqueness rules must not fire on a reversal: it deliberately shares its
-- original's lead, kind and period. Both are re-created excluding reversals.
do $$
declare
  v_conname text;
begin
  select conname into v_conname
    from pg_constraint
   where conrelid = 'commissions'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) like '%lead_id%kind%period%';

  if v_conname is not null then
    execute format('alter table commissions drop constraint %I', v_conname);
  end if;
end $$;

create unique index if not exists commissions_one_per_lead_kind_period
  on commissions (lead_id, kind, period)
  where reverses_id is null;

drop index if exists commissions_one_initial_per_lead;
create unique index if not exists commissions_one_initial_per_lead
  on commissions (lead_id)
  where kind = 'initial' and status <> 'void' and reverses_id is null;

create index if not exists commissions_reverses_idx
  on commissions (reverses_id) where reverses_id is not null;

-- A reversal is negative and an ordinary commission is not. Getting this the
-- wrong way round would quietly double a payment instead of cancelling it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'commissions_reversal_sign_ck') then
    alter table commissions add constraint commissions_reversal_sign_ck
      check (
        (reverses_id is null and amount >= 0)
        or (reverses_id is not null and amount <= 0)
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reopening, recorded
--
-- Closing wiped account_active and account_started_on on any move away from
-- won, so an accidental click lost the account's start date for good. Keep the
-- previous values so a reopen can put them back.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists reopened_at     timestamptz;
alter table leads add column if not exists reopened_reason text;
alter table leads add column if not exists prior_account_started_on date;

commit;
