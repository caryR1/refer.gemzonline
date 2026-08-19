'use strict';

/**
 * Commission calculation.
 *
 * The commission profile (the agent's rank on that campaign) is the single
 * source of truth. Its `deal_value` is the basis every percentage calculates
 * from — there is deliberately no per-lead override anywhere in the system.
 * Changing what a deal is worth means editing the profile, or moving the agent
 * to a different rank. Both are audited.
 */

const { DateTime } = require('luxon');
const db = require('./db');
const tz = require('./tz');
const { calculate, round2, withinRecurringWindow } = require('./commission-math');

/** The payout date for a period, from the profile's payout day. */
function payoutDate(period, payoutDay) {
  const dt = DateTime.fromISO(String(period).slice(0, 10));
  if (!dt.isValid) return null;
  const day = Math.min(Math.max(1, Number(payoutDay) || 15), 28);
  return dt.set({ day }).toFormat('yyyy-LL-dd');
}

/** The commission profile behind a lead, via the agent's campaign membership. */
async function profileForLead(lead) {
  if (!lead || !lead.agent_id) return null;
  return db.one(
    `select cp.* from campaign_members cm
       join commission_profiles cp on cp.id = cm.commission_profile_id
      where cm.campaign_id = $1 and cm.agent_id = $2`,
    [lead.campaign_id, lead.agent_id]
  );
}

/**
 * Create the initial commission when a lead is closed/won.
 * Idempotent — the unique index on (lead_id, kind, period) means re-closing a
 * lead will not double-pay.
 */
async function createInitial(tenantId, lead, { period } = {}) {
  const profile = await profileForLead(lead);
  if (!profile) {
    return { ok: false, reason: 'This agent has no commission profile on the campaign.' };
  }

  const calc = calculate(profile, 'initial');
  if (!calc) return { ok: false, reason: 'No initial commission is configured.' };

  const p = period || tz.periodKey();

  const row = await db.one(
    `insert into commissions
       (tenant_id, lead_id, agent_id, campaign_id, commission_profile_id, kind,
        amount, currency, basis_amount, rate_label, period, status, payout_date)
     values ($1,$2,$3,$4,$5,'initial',$6,$7,$8,$9,$10,'pending',$11)
     on conflict (lead_id, kind, period) do nothing
     returning *`,
    [
      tenantId, lead.id, lead.agent_id, lead.campaign_id, profile.id,
      calc.amount, calc.currency, calc.basis_amount, calc.rate_label,
      p, payoutDate(p, profile.payout_day),
    ]
  );

  if (!row) return { ok: false, reason: 'A commission already exists for this lead and period.' };
  return { ok: true, commission: row, profile };
}

/**
 * Accrue recurring commissions for one period.
 *
 * A lead accrues when: it is closed/won, its account is still active, its
 * profile has recurring enabled, and it has not exhausted `recurring_months`
 * counted from `account_started_on`.
 */
async function accrueRecurring(tenantId, { period } = {}) {
  const p = period || tz.periodKey();

  const rows = await db.all(
    `select l.*, cp.id as profile_id, cp.recurring_enabled, cp.recurring_type,
            cp.recurring_value, cp.recurring_months, cp.payout_day,
            cp.deal_value, cp.currency
       from leads l
       join campaign_members cm
         on cm.campaign_id = l.campaign_id and cm.agent_id = l.agent_id
       join commission_profiles cp on cp.id = cm.commission_profile_id
      where l.tenant_id = $1
        and l.status = 'closed_won'
        and l.account_active
        and cp.recurring_enabled`,
    [tenantId]
  );

  const created = [];
  const skipped = [];

  for (const lead of rows) {
    // Has the recurring window run out?
    const startedOn = lead.account_started_on || lead.closed_at || lead.created_at;
    if (!withinRecurringWindow({
      startedOn,
      period: p,
      recurringMonths: lead.recurring_months,
    })) {
      skipped.push({ leadId: lead.id, reason: 'outside recurring window' });
      continue;
    }

    const calc = calculate(
      {
        recurring_enabled: lead.recurring_enabled,
        recurring_type: lead.recurring_type,
        recurring_value: lead.recurring_value,
        deal_value: lead.deal_value,
        currency: lead.currency,
      },
      'recurring'
    );
    if (!calc || calc.amount <= 0) {
      skipped.push({ leadId: lead.id, reason: 'zero recurring amount' });
      continue;
    }

    const row = await db.one(
      `insert into commissions
         (tenant_id, lead_id, agent_id, campaign_id, commission_profile_id, kind,
          amount, currency, basis_amount, rate_label, period, status, payout_date)
       values ($1,$2,$3,$4,$5,'recurring',$6,$7,$8,$9,$10,'pending',$11)
       on conflict (lead_id, kind, period) do nothing
       returning *`,
      [
        tenantId, lead.id, lead.agent_id, lead.campaign_id, lead.profile_id,
        calc.amount, calc.currency, calc.basis_amount, calc.rate_label,
        p, payoutDate(p, lead.payout_day),
      ]
    );

    if (row) created.push(row);
    else skipped.push({ leadId: lead.id, reason: 'already accrued for this period' });
  }

  return { period: p, created, skipped };
}

/** Totals for an agent, for the dashboard and earnings screen. */
async function agentTotals(tenantId, agentId) {
  const row = await db.one(
    `select
       coalesce(sum(amount) filter (where status <> 'void'), 0)::numeric      as total,
       coalesce(sum(amount) filter (where status = 'pending'), 0)::numeric    as pending,
       coalesce(sum(amount) filter (where status = 'approved'), 0)::numeric   as approved,
       coalesce(sum(amount) filter (where status = 'paid'), 0)::numeric       as paid,
       coalesce(sum(amount) filter (where status <> 'void'
                and period = date_trunc('month', now())::date), 0)::numeric   as this_month,
       count(*) filter (where status <> 'void')::int                          as entries
     from commissions where tenant_id = $1 and agent_id = $2`,
    [tenantId, agentId]
  );
  return row || { total: 0, pending: 0, approved: 0, paid: 0, this_month: 0, entries: 0 };
}

/** Totals across the whole tenant, for the admin dashboard. */
async function tenantTotals(tenantId) {
  const row = await db.one(
    `select
       coalesce(sum(amount) filter (where status = 'pending'), 0)::numeric  as pending,
       coalesce(sum(amount) filter (where status = 'approved'), 0)::numeric as approved,
       coalesce(sum(amount) filter (where status = 'paid'), 0)::numeric     as paid,
       coalesce(sum(amount) filter (where status in ('pending','approved')), 0)::numeric as liability
     from commissions where tenant_id = $1`,
    [tenantId]
  );
  return row || { pending: 0, approved: 0, paid: 0, liability: 0 };
}

module.exports = {
  calculate, payoutDate, profileForLead, createInitial,
  accrueRecurring, agentTotals, tenantTotals, round2, withinRecurringWindow,
};
