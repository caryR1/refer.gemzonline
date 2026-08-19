-- ===========================================================================
-- refer.GemzOnline — Row Level Security policies (Supabase only)
--
-- The app server connects with direct Postgres credentials and bypasses RLS.
-- These policies are a second line of defence: if the Supabase REST or realtime
-- API is ever hit with the anon key, agents reach only their own data and
-- anonymous callers reach nothing.
-- ===========================================================================

alter table tenants                enable row level security;
alter table profiles               enable row level security;
alter table campaigns              enable row level security;
alter table commission_profiles    enable row level security;
alter table campaign_members       enable row level security;
alter table referral_links         enable row level security;
alter table relation_options       enable row level security;
alter table leads                  enable row level security;
alter table lead_notes             enable row level security;
alter table commissions            enable row level security;
alter table notification_templates enable row level security;
alter table notification_log       enable row level security;
alter table notification_prefs     enable row level security;
alter table campaign_reminders     enable row level security;
alter table reminder_sends         enable row level security;
alter table audit_log              enable row level security;
alter table job_runs               enable row level security;
alter table settings               enable row level security;

-- Helper: is the caller an active admin?
create or replace function is_admin() returns boolean as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.status = 'active'
  );
$$ language sql stable security definer;

-- Helper: the caller's tenant. Every policy is additionally scoped by this so
-- a future second tenant can never read the first one's rows.
create or replace function my_tenant() returns uuid as $$
  select p.tenant_id from profiles p where p.id = auth.uid();
$$ language sql stable security definer;

-- --- tenants ---------------------------------------------------------------
drop policy if exists tenants_read on tenants;
create policy tenants_read on tenants for select using (id = my_tenant());

-- --- profiles --------------------------------------------------------------
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select
  using (id = auth.uid() or (tenant_id = my_tenant() and is_admin()));

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_admin_all on profiles;
create policy profiles_admin_all on profiles for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- campaigns: any signed-in staff member reads, admins write -------------
drop policy if exists campaigns_read on campaigns;
create policy campaigns_read on campaigns for select using (tenant_id = my_tenant());

drop policy if exists campaigns_admin on campaigns;
create policy campaigns_admin on campaigns for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- commission profiles ---------------------------------------------------
drop policy if exists commission_profiles_read on commission_profiles;
create policy commission_profiles_read on commission_profiles for select
  using (tenant_id = my_tenant());

drop policy if exists commission_profiles_admin on commission_profiles;
create policy commission_profiles_admin on commission_profiles for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- campaign membership: agents manage their own, admins manage all -------
drop policy if exists campaign_members_own on campaign_members;
create policy campaign_members_own on campaign_members for all
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()))
  with check (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

drop policy if exists referral_links_own on referral_links;
create policy referral_links_own on referral_links for all
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()))
  with check (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

-- --- relation options: staff read, admin writes ---------------------------
drop policy if exists relation_options_read on relation_options;
create policy relation_options_read on relation_options for select using (tenant_id = my_tenant());

drop policy if exists relation_options_admin on relation_options;
create policy relation_options_admin on relation_options for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- leads -----------------------------------------------------------------
drop policy if exists leads_read on leads;
create policy leads_read on leads for select
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

drop policy if exists leads_agent_update on leads;
create policy leads_agent_update on leads for update
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()))
  with check (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

drop policy if exists leads_admin_all on leads;
create policy leads_admin_all on leads for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- lead notes ------------------------------------------------------------
drop policy if exists lead_notes_scope on lead_notes;
create policy lead_notes_scope on lead_notes for all
  using (
    tenant_id = my_tenant() and (
      is_admin() or exists (select 1 from leads l where l.id = lead_id and l.agent_id = auth.uid())
    )
  )
  with check (
    tenant_id = my_tenant() and (
      is_admin() or exists (select 1 from leads l where l.id = lead_id and l.agent_id = auth.uid())
    )
  );

-- --- commissions -----------------------------------------------------------
drop policy if exists commissions_read on commissions;
create policy commissions_read on commissions for select
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

drop policy if exists commissions_admin on commissions;
create policy commissions_admin on commissions for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- notification preferences ----------------------------------------------
drop policy if exists notification_prefs_own on notification_prefs;
create policy notification_prefs_own on notification_prefs for select
  using (tenant_id = my_tenant() and (user_id = auth.uid() or is_admin()));

-- A user may change only their own row; the app layer refuses to let a
-- non-admin touch admin_enabled, which is what makes an admin "off" a hard block.
drop policy if exists notification_prefs_self_update on notification_prefs;
create policy notification_prefs_self_update on notification_prefs for update
  using (tenant_id = my_tenant() and user_id = auth.uid())
  with check (tenant_id = my_tenant() and user_id = auth.uid());

drop policy if exists notification_prefs_admin on notification_prefs;
create policy notification_prefs_admin on notification_prefs for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- --- admin-only tables -----------------------------------------------------
drop policy if exists notification_templates_admin on notification_templates;
create policy notification_templates_admin on notification_templates for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

drop policy if exists notification_log_read on notification_log;
create policy notification_log_read on notification_log for select
  using (tenant_id = my_tenant() and (agent_id = auth.uid() or is_admin()));

drop policy if exists notification_log_admin on notification_log;
create policy notification_log_admin on notification_log for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

drop policy if exists campaign_reminders_read on campaign_reminders;
create policy campaign_reminders_read on campaign_reminders for select using (tenant_id = my_tenant());

drop policy if exists campaign_reminders_admin on campaign_reminders;
create policy campaign_reminders_admin on campaign_reminders for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

drop policy if exists reminder_sends_admin on reminder_sends;
create policy reminder_sends_admin on reminder_sends for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

-- Audit log is admin-readable and strictly append-only: no update or delete
-- policy exists, so neither is ever permitted through the API.
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select
  using (tenant_id = my_tenant() and is_admin());

drop policy if exists job_runs_admin on job_runs;
create policy job_runs_admin on job_runs for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());

drop policy if exists settings_admin on settings;
create policy settings_admin on settings for all
  using (tenant_id = my_tenant() and is_admin())
  with check (tenant_id = my_tenant() and is_admin());
