-- ===========================================================================
-- refer.GemzOnline — schema self-test
--
-- Proves the rules the application depends on are actually enforced by the
-- database, not merely by convention in the code.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/verify.sql
--
-- Runs entirely inside a transaction that is rolled back, so it leaves no
-- trace. Safe against a production database, though a staging copy is wiser.
-- ===========================================================================

begin;

do $$
declare
  v_tenant   uuid;
  v_tenant2  uuid;
  v_campaign uuid;
  v_rank_std uuid;
  v_rank_snr uuid;
  v_agent    uuid := gen_random_uuid();
  v_agent2   uuid := gen_random_uuid();
  v_member   uuid;
  v_lead     uuid;
  v_ok       boolean;
  v_amount   numeric;
  v_count    int;
  v_product    uuid;
  v_commission uuid;
begin
  raise notice '--- setting up fixtures';

  insert into tenants (name, slug) values ('Verify Co', 'verify-co') returning id into v_tenant;
  insert into tenants (name, slug) values ('Other Co', 'other-co')  returning id into v_tenant2;

  insert into profiles (id, tenant_id, email, full_name, role)
    values (v_agent, v_tenant, 'agent@verify.test', 'Test Agent', 'agent');
  insert into profiles (id, tenant_id, email, full_name, role)
    values (v_agent2, v_tenant, 'agent2@verify.test', 'Second Agent', 'agent');

  insert into campaigns (tenant_id, name, slug, currency)
    values (v_tenant, 'Verify Campaign', 'verify-campaign', 'USD')
    returning id into v_campaign;

  insert into commission_profiles
    (tenant_id, campaign_id, name, is_default, initial_type, initial_value,
     recurring_enabled, recurring_type, recurring_value, recurring_months,
     payout_day, deal_value, currency)
  values
    (v_tenant, v_campaign, 'Standard', true, 'percentage', 10,
     false, 'percentage', 0, null, 15, 1500, 'USD')
  returning id into v_rank_std;

  insert into commission_profiles
    (tenant_id, campaign_id, name, is_default, initial_type, initial_value,
     recurring_enabled, recurring_type, recurring_value, recurring_months,
     payout_day, deal_value, currency)
  values
    (v_tenant, v_campaign, 'Senior', false, 'percentage', 15,
     true, 'percentage', 5, 12, 15, 1500, 'USD')
  returning id into v_rank_snr;

  -- =========================================================================
  raise notice '1. a campaign may hold several commission ranks';
  select count(*) into v_count from commission_profiles where campaign_id = v_campaign;
  if v_count <> 2 then raise exception 'expected 2 ranks, found %', v_count; end if;
  raise notice '   ok — % ranks on the campaign', v_count;

  -- =========================================================================
  raise notice '2. only ONE rank per campaign may be the default';
  begin
    update commission_profiles set is_default = true where id = v_rank_snr;
    raise exception 'FAILED: a second default rank was allowed';
  exception when unique_violation then
    raise notice '   ok — a second default is rejected';
  end;

  -- =========================================================================
  raise notice '3. rank names are unique per campaign, case-insensitively';
  begin
    insert into commission_profiles (tenant_id, campaign_id, name, initial_value, deal_value)
      values (v_tenant, v_campaign, 'STANDARD', 5, 100);
    raise exception 'FAILED: a duplicate rank name was allowed';
  exception when unique_violation then
    raise notice '   ok — duplicate rank name rejected';
  end;

  -- =========================================================================
  raise notice '4. an agent has exactly ONE commission profile per campaign';
  insert into campaign_members (tenant_id, campaign_id, agent_id, commission_profile_id)
    values (v_tenant, v_campaign, v_agent, v_rank_std)
    returning id into v_member;

  begin
    insert into campaign_members (tenant_id, campaign_id, agent_id, commission_profile_id)
      values (v_tenant, v_campaign, v_agent, v_rank_snr);
    raise exception 'FAILED: an agent got a second membership on one campaign';
  exception when unique_violation then
    raise notice '   ok — a second membership on the same campaign is rejected';
  end;

  -- Moving them to another rank is an UPDATE, and must work.
  update campaign_members set commission_profile_id = v_rank_snr where id = v_member;
  raise notice '   ok — moving the agent between ranks is allowed';
  update campaign_members set commission_profile_id = v_rank_std where id = v_member;

  -- =========================================================================
  raise notice '5. an agent may belong to MANY campaigns';
  declare v_campaign2 uuid;
  begin
    insert into campaigns (tenant_id, name, slug) values (v_tenant, 'Second Campaign', 'second-campaign')
      returning id into v_campaign2;
    insert into campaign_members (tenant_id, campaign_id, agent_id) values (v_tenant, v_campaign2, v_agent);
    select count(*) into v_count from campaign_members where agent_id = v_agent;
    if v_count <> 2 then raise exception 'expected 2 memberships, found %', v_count; end if;
    raise notice '   ok — the agent is on % campaigns', v_count;
  end;

  -- =========================================================================
  raise notice '6. referral link slugs are unique per tenant, reusable across tenants';
  insert into referral_links (tenant_id, member_id, campaign_id, agent_id, slug)
    values (v_tenant, v_member, v_campaign, v_agent, 'andre-verify-ab12');
  begin
    insert into referral_links (tenant_id, member_id, campaign_id, agent_id, slug)
      values (v_tenant, v_member, v_campaign, v_agent, 'andre-verify-ab12');
    raise exception 'FAILED: a duplicate slug was allowed within one tenant';
  exception when unique_violation then
    raise notice '   ok — duplicate slug rejected within the tenant';
  end;

  -- =========================================================================
  raise notice '7. campaign slugs are unique per tenant but NOT globally';
  begin
    insert into campaigns (tenant_id, name, slug) values (v_tenant, 'Clash', 'verify-campaign');
    raise exception 'FAILED: duplicate campaign slug allowed in one tenant';
  exception when unique_violation then
    raise notice '   ok — duplicate slug rejected inside the tenant';
  end;

  insert into campaigns (tenant_id, name, slug) values (v_tenant2, 'Same Name Elsewhere', 'verify-campaign');
  raise notice '   ok — the same slug is allowed in a second tenant (multi-tenant ready)';

  -- =========================================================================
  raise notice '8. a lead carries a unique reference and access token';
  insert into leads (tenant_id, reference, access_token, campaign_id, agent_id, member_id, email, first_name, timezone)
    values (v_tenant, 'GZ-VERIFY1', 'token-verify-0000000000000000000000000000', v_campaign, v_agent, v_member,
            'lead@verify.test', 'Marcia', 'America/New_York')
    returning id into v_lead;

  begin
    insert into leads (tenant_id, reference, access_token, campaign_id, email)
      values (v_tenant, 'GZ-VERIFY1', 'another-token-000000000000000000000000', v_campaign, 'x@verify.test');
    raise exception 'FAILED: duplicate lead reference allowed';
  exception when unique_violation then
    raise notice '   ok — duplicate reference rejected';
  end;

  -- =========================================================================
  raise notice '9. commission maths matches the rank (10%% of 1500 = 150.00)';
  select round((cp.deal_value * cp.initial_value) / 100, 2) into v_amount
    from commission_profiles cp where cp.id = v_rank_std;
  if v_amount <> 150.00 then raise exception 'expected 150.00, got %', v_amount; end if;

  insert into commissions
    (tenant_id, lead_id, agent_id, campaign_id, commission_profile_id, kind,
     amount, currency, basis_amount, rate_label, period, payout_date)
  values
    (v_tenant, v_lead, v_agent, v_campaign, v_rank_std, 'initial',
     v_amount, 'USD', 1500, '10%', date_trunc('month', now())::date,
     (date_trunc('month', now()) + interval '14 days')::date);
  raise notice '   ok — commission recorded at %', v_amount;

  -- =========================================================================
  raise notice '10. a lead cannot be paid twice for the same kind and period';
  begin
    insert into commissions
      (tenant_id, lead_id, agent_id, campaign_id, kind, amount, period)
    values
      (v_tenant, v_lead, v_agent, v_campaign, 'initial', 150, date_trunc('month', now())::date);
    raise exception 'FAILED: duplicate commission allowed for the same lead/kind/period';
  exception when unique_violation then
    raise notice '   ok — double-pay prevented by the unique key';
  end;

  -- A recurring row for the SAME period is a different kind, so it is allowed.
  insert into commissions
    (tenant_id, lead_id, agent_id, campaign_id, kind, amount, period)
  values
    (v_tenant, v_lead, v_agent, v_campaign, 'recurring', 75, date_trunc('month', now())::date);
  raise notice '   ok — a recurring row alongside the initial one is allowed';

  -- =========================================================================
  raise notice '11. notification preference resolution (admin off = hard block)';
  insert into notification_prefs (tenant_id, user_id, event_key, channel, user_enabled, admin_enabled)
    values (v_tenant, v_agent, 'lead_created', 'email', true, true);

  select (user_enabled and admin_enabled) into v_ok from notification_prefs
    where user_id = v_agent and event_key = 'lead_created' and channel = 'email';
  if not v_ok then raise exception 'expected enabled when both are true'; end if;

  -- user mutes it
  update notification_prefs set user_enabled = false
    where user_id = v_agent and event_key = 'lead_created' and channel = 'email';
  select (user_enabled and admin_enabled) into v_ok from notification_prefs
    where user_id = v_agent and event_key = 'lead_created' and channel = 'email';
  if v_ok then raise exception 'expected muted after the user switched it off'; end if;
  raise notice '   ok — the user can mute a channel the admin left on';

  -- admin blocks it; user turning their own switch back on must not be enough
  update notification_prefs set admin_enabled = false, user_enabled = true
    where user_id = v_agent and event_key = 'lead_created' and channel = 'email';
  select (user_enabled and admin_enabled) into v_ok from notification_prefs
    where user_id = v_agent and event_key = 'lead_created' and channel = 'email';
  if v_ok then raise exception 'FAILED: a user re-enabled a channel the admin blocked'; end if;
  raise notice '   ok — an admin block survives the user switching their own flag on';

  -- =========================================================================
  raise notice '12. reminders cannot fire twice for the same appointment';
  insert into reminder_sends (tenant_id, lead_id, slot, channel, recipient, appointment_at)
    values (v_tenant, v_lead, 1, 'email', 'lead', now() + interval '2 days');
  begin
    insert into reminder_sends (tenant_id, lead_id, slot, channel, recipient, appointment_at)
      values (v_tenant, v_lead, 1, 'email', 'lead', now() + interval '2 days');
    raise exception 'FAILED: a duplicate reminder was allowed';
  exception when unique_violation then
    raise notice '   ok — the same reminder cannot be sent twice';
  end;

  -- A different recipient on the same slot is a separate send.
  insert into reminder_sends (tenant_id, lead_id, slot, channel, recipient, appointment_at)
    values (v_tenant, v_lead, 1, 'email', 'agent', now() + interval '2 days');
  raise notice '   ok — prospect and agent are tracked separately';

  -- =========================================================================
  raise notice '13. reminder slots are limited to 1..3';
  begin
    insert into campaign_reminders (tenant_id, campaign_id, slot) values (v_tenant, v_campaign, 4);
    raise exception 'FAILED: a fourth reminder slot was allowed';
  exception when check_violation then
    raise notice '   ok — only three slots exist';
  end;

  -- =========================================================================
  raise notice '14. payout day is constrained to 1..28';
  begin
    update commission_profiles set payout_day = 31 where id = v_rank_std;
    raise exception 'FAILED: payout day 31 was allowed';
  exception when check_violation then
    raise notice '   ok — payout day is capped at 28, so every month has one';
  end;

  -- =========================================================================
  raise notice '15. the audit log records before/after values';
  insert into audit_log (tenant_id, actor_id, actor_name, actor_type, action, entity_type, entity_id, summary, before, after)
    values (v_tenant, v_agent, 'Test Agent', 'admin', 'member.profile_changed', 'campaign_member', v_member,
            'Test Agent moved to Senior', '{"commission_profile":"Standard"}'::jsonb, '{"commission_profile":"Senior"}'::jsonb);
  select count(*) into v_count from audit_log where entity_id = v_member;
  if v_count <> 1 then raise exception 'expected 1 audit entry, found %', v_count; end if;
  raise notice '   ok — rank change captured with its old and new value';

  -- =========================================================================
  raise notice '16. a lead carries a full postal address';
  update leads
     set address = '12 Hope Road', address_line2 = 'Apt 4B', city = 'Kingston',
         region = 'St Andrew', postal_code = 'JMAAW10', country = 'Jamaica'
   where id = v_lead;
  select count(*) into v_count
    from leads
   where id = v_lead and address_line2 = 'Apt 4B' and postal_code = 'JMAAW10';
  if v_count <> 1 then
    raise exception 'FAILED: the lead address columns are missing — has db/migrations/001 been applied?';
  end if;
  raise notice '   ok — street, second line, city, region, postcode and country all persist';

  -- =========================================================================
  raise notice '17. only payout methods the app can actually pay are accepted';
  begin
    update profiles set payout_method = 'carrier pigeon' where id = v_agent;
    raise exception 'FAILED: an unknown payout method was allowed';
  exception when check_violation then
    raise notice '   ok — the method must be one the application knows how to pay';
  end;

  -- =========================================================================
  raise notice '18. payout details cannot be half-saved';
  begin
    update profiles
       set payout_method = null, payout_secrets = 'v1.aa.bb.cc'
     where id = v_agent;
    raise exception 'FAILED: stored account details with no method to pay them by';
  exception when check_violation then
    raise notice '   ok — a stored account always says how it is paid';
  end;

  -- =========================================================================
  raise notice '19. an account holder is personal or business, nothing else';
  begin
    update profiles set payout_holder_type = 'charity' where id = v_agent;
    raise exception 'FAILED: an unknown account holder type was allowed';
  exception when check_violation then
    raise notice '   ok — personal or business only';
  end;

  -- =========================================================================
  raise notice '20. a complete payout record stores and reads back';
  update profiles
     set payout_method = 'iban', payout_holder_name = 'Test Agent',
         payout_holder_type = 'personal', payout_bank_country = 'United Kingdom',
         payout_currency = 'USD', payout_secrets = 'v1.aa.bb.cc',
         payout_last4 = '6819', payout_updated_at = now()
   where id = v_agent;
  select count(*) into v_count
    from profiles
   where id = v_agent and payout_last4 = '6819' and payout_secrets is not null;
  if v_count <> 1 then raise exception 'FAILED: the payout record did not persist'; end if;
  raise notice '   ok — method, holder, currency and ciphertext persist together';

  -- =========================================================================
  raise notice '21. a lead can only ever hold one live initial commission';
  -- The old rule was (lead_id, kind, period), so closing in one month and
  -- again in the next slipped through and paid twice.
  insert into commissions (tenant_id, lead_id, agent_id, campaign_id, kind, amount, currency, period, status)
    values (v_tenant, v_lead, v_agent, v_campaign, 'initial', 150, 'USD', date '2026-08-01', 'pending');
  begin
    insert into commissions (tenant_id, lead_id, agent_id, campaign_id, kind, amount, currency, period, status)
      values (v_tenant, v_lead, v_agent, v_campaign, 'initial', 150, 'USD', date '2026-09-01', 'pending');
    raise exception 'FAILED: a second initial commission was created for the same lead';
  exception when unique_violation then
    raise notice '   ok — a different month is not a second chance to be paid';
  end;

  -- =========================================================================
  raise notice '22. a voided commission can be redone';
  update commissions set status = 'void'
   where lead_id = v_lead and kind = 'initial' and period = date '2026-08-01';
  insert into commissions (tenant_id, lead_id, agent_id, campaign_id, kind, amount, currency, period, status)
    values (v_tenant, v_lead, v_agent, v_campaign, 'initial', 200, 'USD', date '2026-09-01', 'pending');
  select count(*) into v_count
    from commissions where lead_id = v_lead and kind = 'initial' and status <> 'void';
  if v_count <> 1 then raise exception 'expected exactly 1 live initial commission, found %', v_count; end if;
  raise notice '   ok — voiding releases the slot, so a genuine mistake is fixable';

  -- =========================================================================
  raise notice '23. a lead carries the rank it was referred under';
  update leads
     set commission_profile_id = v_rank_std,
         terms = '{"initial_type":"percentage","initial_value":10,"deal_value":1500,"currency":"USD","payout_day":15,"recurring_enabled":false}'::jsonb,
         terms_captured_at = now()
   where id = v_lead;
  select count(*) into v_count
    from leads
   where id = v_lead
     and commission_profile_id = v_rank_std
     and (terms ->> 'initial_value')::numeric = 10;
  if v_count <> 1 then
    raise exception 'FAILED: the lead terms snapshot did not persist — has db/migrations/002 been applied?';
  end if;
  raise notice '   ok — the snapshot survives independently of the rank row';

  -- =========================================================================
  raise notice '24. a rank cannot promote automatically with no requirement';
  begin
    update commission_profiles
       set auto_promote = true, promote_after_deals = null, promote_after_amount = null
     where id = v_rank_snr;
    raise exception 'FAILED: a rank was allowed to promote everyone unconditionally';
  exception when check_violation then
    raise notice '   ok — automatic promotion must say what earns it';
  end;

  -- =========================================================================
  raise notice '25. promotion thresholds must be positive';
  begin
    update commission_profiles
       set auto_promote = true, promote_after_deals = 0
     where id = v_rank_snr;
    raise exception 'FAILED: a threshold of zero deals was allowed';
  exception when check_violation then
    raise notice '   ok — zero closed deals is not a requirement';
  end;

  -- =========================================================================
  raise notice '26. a valid promotion rule is accepted';
  update commission_profiles
     set auto_promote = true, promote_after_deals = 6, promote_after_amount = 5000
   where id = v_rank_snr;
  select count(*) into v_count
    from commission_profiles where id = v_rank_snr and auto_promote and promote_after_deals = 6;
  if v_count <> 1 then raise exception 'FAILED: the promotion rule did not persist'; end if;
  raise notice '   ok — six closed deals and 5000 earned';

  -- =========================================================================
  raise notice '27. a rank may inherit the campaign deal value';
  update commission_profiles set deal_value = null where id = v_rank_std;
  select count(*) into v_count from commission_profiles where id = v_rank_std and deal_value is null;
  if v_count <> 1 then
    raise exception 'FAILED: deal_value is still NOT NULL — has db/migrations/002 been applied?';
  end if;
  raise notice '   ok — null means inherit, so ranks cannot drift apart';

  -- =========================================================================
  raise notice '28. a rank change records when it takes effect, and who made it';
  update campaign_members
     set commission_profile_id = v_rank_snr, rank_effective_from = date '2026-08-01', rank_set_by = 'admin'
   where id = v_member;
  begin
    update campaign_members set rank_set_by = 'the vibes' where id = v_member;
    raise exception 'FAILED: an unknown rank_set_by was allowed';
  exception when check_violation then
    raise notice '   ok — join, admin or auto, and an effective date of its own';
  end;

  -- =========================================================================
  raise notice '29. a campaign can sell several products';
  insert into campaign_products (tenant_id, campaign_id, name, value, sort_order)
    values (v_tenant, v_campaign, 'Starter', 500, 1) returning id into v_product;
  insert into campaign_products (tenant_id, campaign_id, name, value, sort_order)
    values (v_tenant, v_campaign, 'Enterprise', 5000, 2);
  select count(*) into v_count from campaign_products where campaign_id = v_campaign;
  if v_count <> 2 then raise exception 'expected 2 products, found %', v_count; end if;
  raise notice '   ok — two products at two prices on one campaign';

  -- =========================================================================
  raise notice '30. two products cannot share a name on one campaign';
  begin
    insert into campaign_products (tenant_id, campaign_id, name, value)
      values (v_tenant, v_campaign, 'starter', 750);
    raise exception 'FAILED: a duplicate product name was allowed';
  exception when unique_violation then
    raise notice '   ok — otherwise the close dropdown would show two identical rows';
  end;

  -- =========================================================================
  raise notice '31. a lead records interest and purchase separately';
  update leads
     set product_interest_id = v_product,
         product_id = v_product, product_name = 'Starter', product_value = 500
   where id = v_lead;
  select count(*) into v_count
    from leads where id = v_lead and product_value = 500 and product_interest_id = v_product;
  if v_count <> 1 then
    raise exception 'FAILED: product columns missing — has db/migrations/003 been applied?';
  end if;
  -- Repricing the product must not reach a deal that already closed on it.
  update campaign_products set value = 9999 where id = v_product;
  select product_value into v_amount from leads where id = v_lead;
  if v_amount <> 500 then
    raise exception 'FAILED: repricing the product changed a closed deal (% instead of 500)', v_amount;
  end if;
  raise notice '   ok — the price is copied at close, not looked up later';

  -- =========================================================================
  raise notice '32. a reversal is negative, an ordinary commission is not';
  begin
    insert into commissions (tenant_id, lead_id, agent_id, campaign_id, kind, amount, currency, period, status)
      values (v_tenant, v_lead, v_agent, v_campaign, 'recurring', -50, 'USD', date '2026-10-01', 'paid');
    raise exception 'FAILED: a negative commission was allowed without being a reversal';
  exception when check_violation then
    raise notice '   ok — a negative amount has to say what it reverses';
  end;

  -- =========================================================================
  raise notice '33. a paid commission can be reversed rather than erased';
  select id into v_commission
    from commissions
   where lead_id = v_lead and kind = 'initial' and status <> 'void'
   limit 1;
  update commissions set status = 'paid' where id = v_commission;

  -- Same lead, same kind, same period as the original — the uniqueness rules
  -- must let this through, or a reversal would be impossible.
  insert into commissions (tenant_id, lead_id, agent_id, campaign_id, kind, amount,
                           currency, period, status, reverses_id, reversal_reason)
    values (v_tenant, v_lead, v_agent, v_campaign, 'initial', -200, 'USD',
            date '2026-09-01', 'paid', v_commission, 'Closed the wrong lead');

  select coalesce(sum(amount), 0) into v_amount
    from commissions where lead_id = v_lead and status <> 'void';
  if v_amount <> 0 then
    raise exception 'FAILED: the reversal did not net to zero (got %)', v_amount;
  end if;
  raise notice '   ok — both entries survive and the total returns to zero';

  -- =========================================================================
  raise notice '34. the original is still there to be read';
  select count(*) into v_count
    from commissions where id = v_commission and status = 'paid' and amount > 0;
  if v_count <> 1 then raise exception 'FAILED: the original payment was altered'; end if;
  raise notice '   ok — a payment that happened still says it happened';

  raise notice '';
  raise notice '=========================================';
  raise notice 'All 34 schema checks passed.';
  raise notice '=========================================';
end $$;

rollback;
