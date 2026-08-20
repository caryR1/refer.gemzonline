-- ---------------------------------------------------------------------------
-- 001 — the prospect's full address, and agents' payout details
--
-- Every statement is idempotent, so this file is safe to run on a brand new
-- database and on one that already has it. `db/schema.sql` stays the baseline;
-- everything after it lives here, applied in filename order by `npm run db:push`.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Leads: a full postal address
--
-- `address`, `city`, `region` and `country` already existed but only `city` was
-- ever collected. These two complete the set, and `address` is now used as the
-- first street line.
-- ---------------------------------------------------------------------------
alter table leads add column if not exists address_line2 text;
alter table leads add column if not exists postal_code   text;

comment on column leads.address       is 'Street address, first line';
comment on column leads.address_line2 is 'Apartment, suite, building — second line';
comment on column leads.region        is 'State, province or parish';
comment on column leads.postal_code   is 'Postal or ZIP code';

-- Finding every prospect in a parish or postcode is a real query for a call
-- team, and these stay small.
create index if not exists leads_city_idx        on leads (tenant_id, lower(city));
create index if not exists leads_postal_code_idx on leads (tenant_id, postal_code);

-- ---------------------------------------------------------------------------
-- Profiles: payout details in the shape international providers ask for
--
-- `payout_method` already existed as free text and now holds a scheme code
-- (iban, aba, sort_code, canada, swift, wise, paypal, other). `payout_details`
-- also already existed as a free-text note; it is no longer written to, but is
-- left in place so nothing an agent typed before is lost.
--
-- The account identifiers themselves are NOT stored here in the clear. They go
-- into `payout_secrets` as a single AES-256-GCM ciphertext (see src/lib/crypto).
-- `payout_last4` is the only fragment kept readable, so a list or a payment run
-- can show "•••• 6819" without a decryption key.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists payout_holder_name      text;
alter table profiles add column if not exists payout_holder_type      text
  not null default 'personal';
alter table profiles add column if not exists payout_bank_country     text;
alter table profiles add column if not exists payout_currency         text;

alter table profiles add column if not exists payout_addr_line1       text;
alter table profiles add column if not exists payout_addr_line2       text;
alter table profiles add column if not exists payout_addr_city        text;
alter table profiles add column if not exists payout_addr_region      text;
alter table profiles add column if not exists payout_addr_postal_code text;
alter table profiles add column if not exists payout_addr_country     text;

alter table profiles add column if not exists payout_secrets          text;
alter table profiles add column if not exists payout_last4            text;
alter table profiles add column if not exists payout_updated_at       timestamptz;

comment on column profiles.payout_secrets is
  'AES-256-GCM envelope (v1.iv.tag.ciphertext) holding the account identifiers as JSON. Never log or export this.';
comment on column profiles.payout_last4 is
  'Last four characters of the primary identifier, for masked display. Not sensitive on its own.';
comment on column profiles.payout_details is
  'DEPRECATED free-text payout note from before structured details existed. Read-only.';

-- Old free-text payout methods ("Bank transfer", "PayPal please") do not match
-- the new scheme codes and would fail the check constraint added below. Move
-- anything unrecognised into the deprecated note rather than dropping it.
--
-- This must run BEFORE the constraint is added: Postgres validates existing
-- rows when a check constraint is created, so the cleanup has to come first.
update profiles
   set payout_details = trim(both E'\n' from
         coalesce(payout_details, '') || E'\n' || 'Previous method: ' || payout_method),
       payout_method  = null
 where payout_method is not null
   and payout_method <> ''
   and payout_method not in ('iban', 'aba', 'sort_code', 'canada', 'swift', 'wise', 'paypal', 'other');

-- Guard the two values the application relies on being well formed. A row that
-- fails these would render as a broken payout method rather than an error, so
-- catching it at write time is worth the constraint.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_payout_holder_type_ck') then
    alter table profiles add constraint profiles_payout_holder_type_ck
      check (payout_holder_type in ('personal', 'business'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_payout_method_ck') then
    alter table profiles add constraint profiles_payout_method_ck
      check (
        payout_method is null
        or payout_method = ''
        or payout_method in ('iban', 'aba', 'sort_code', 'canada', 'swift', 'wise', 'paypal', 'other')
      );
  end if;

  -- A ciphertext without a method, or a method with no ciphertext, is a
  -- half-saved record that looks payable and is not.
  if not exists (select 1 from pg_constraint where conname = 'profiles_payout_pairing_ck') then
    alter table profiles add constraint profiles_payout_pairing_ck
      check (
        payout_secrets is null
        or (payout_method is not null and payout_method <> '')
      );
  end if;
end $$;

-- Finding who still needs to give us payout details is the question an admin
-- actually asks, so index the answer.
create index if not exists profiles_payout_pending_idx
  on profiles (tenant_id)
  where payout_secrets is null;

commit;
