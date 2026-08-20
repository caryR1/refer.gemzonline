'use strict';

/**
 * Commission calculation.
 *
 * The rank the lead was REFERRED under is what pays. Every lead carries a
 * snapshot of its rank's terms, taken the moment it arrived, and that snapshot
 * is what the maths reads.
 *
 * This is the difference between a promotion being a reward and a promotion
 * quietly re-pricing three months of other people's work. Looking the rank up
 * live at closing time — which is what this did before — meant the amount an
 * agent earned depended on when an admin got round to clicking Close, and a
 * demotion or a corrected rate reached backwards into deals already done.
 *
 * There is still no per-lead value override. What a deal is worth comes from
 * the campaign, or from a rank that overrides it, and both are audited.
 */

const { DateTime } = require('luxon');
const db = require('./db');
const tz = require('./tz');
const ranks = require('./ranks');
const products = require('./products');
const { calculate, round2, withinRecurringWindow } = require('./commission-math');

/** The payout date for a period, from the profile's payout day. */
function payoutDate(period, payoutDay) {
  const dt = DateTime.fromISO(String(period).slice(0, 10));
  if (!dt.isValid) return null;
  const day = Math.min(Math.max(1, Number(payoutDay) || 15), 28);
  return dt.set({ day }).toFormat('yyyy-LL-dd');
}

/**
 * The rank behind a lead, and the campaign it belongs to.
 *
 * Only needed as a fallback now — for leads referred before snapshots existed,
 * and to name the rank on screen. The stamped `commission_profile_id` is
 * preferred over the live membership, because the membership's rank changes and
 * the stamp does not.
 */
async function profileForLead(lead) {
  if (!lead) return null;

  if (lead.commission_profile_id) {
    const stamped = await db.one('select * from commission_profiles where id = $1', [lead.commission_profile_id]);
    if (stamped) return stamped;
  }

  if (!lead.agent_id) return null;
  return db.one(
    `select cp.* from campaign_members cm
       join commission_profiles cp on cp.id = cm.commission_profile_id
      where cm.campaign_id = $1 and cm.agent_id = $2`,
    [lead.campaign_id, lead.agent_id]
  );
}

/**
 * The terms governing a lead: its snapshot if it has one, otherwise resolved
 * live from the rank and campaign as it would have been before snapshots.
 *
 * The product recorded at close, if there is one, then supplies the basis —
 * the rank sets the rate, the product sets the value.
 */
async function termsForLead(lead) {
  let terms = ranks.isSnapshotted(lead) ? lead.terms : null;

  if (!terms) {
    const profile = await profileForLead(lead);
    if (!profile) return null;
    const campaign = await db.one('select id, currency, deal_value from campaigns where id = $1', [lead.campaign_id]);
    terms = ranks.resolveTerms(profile, campaign);
  }

  return products.applyTo(terms, lead);
}

/**
 * Create the initial commission when a lead is closed/won.
 *
 * Idempotent twice over: the unique index on (lead_id, kind, period) catches a
 * repeat within one month, and `commissions_one_initial_per_lead` catches the
 * case that actually bit — closing, reopening, and closing again in a LATER
 * month, which used to slip past because the period differed.
 */
async function createInitial(tenantId, lead, { period } = {}) {
  const terms = await termsForLead(lead);
  if (!terms) {
    return { ok: false, reason: 'This agent had no rank on the campaign when the lead came in, so there is nothing to calculate from.' };
  }

  const calc = calculate(terms, 'initial');
  if (!calc) return { ok: false, reason: 'No initial commission is configured.' };

  const p = period || tz.periodKey();
  const profileId = lead.commission_profile_id || terms.commission_profile_id || null;

  let row;
  try {
    row = await db.one(
      `insert into commissions
         (tenant_id, lead_id, agent_id, campaign_id, commission_profile_id, kind,
          amount, currency, basis_amount, rate_label, period, status, payout_date)
       values ($1,$2,$3,$4,$5,'initial',$6,$7,$8,$9,$10,'pending',$11)
       on conflict (lead_id, kind, period) do nothing
       returning *`,
      [
        tenantId, lead.id, lead.agent_id, lead.campaign_id, profileId,
        calc.amount, calc.currency, calc.basis_amount, calc.rate_label,
        p, payoutDate(p, terms.payout_day),
      ]
    );
  } catch (err) {
    // 23505 here is the one-initial-per-lead index: the lead already has a live
    // initial commission from a different month. That is the double-pay this
    // index exists to stop, so report it plainly rather than as a crash.
    if (err.code === '23505') {
      return { ok: false, reason: 'This lead already has an initial commission. Void that one first if it needs redoing.' };
    }
    throw err;
  }

  if (!row) return { ok: false, reason: 'A commission already exists for this lead and period.' };
  return { ok: true, commission: row, terms };
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

  // Every closed, active lead — the recurring decision is made per lead from
  // its own terms, not filtered in SQL against a rank that may have been edited
  // since. A campaign row comes along for leads with no snapshot to fall back on.
  const rows = await db.all(
    `select l.*,
            c.currency   as campaign_currency,
            c.deal_value as campaign_deal_value,
            cp.*, cp.id  as live_profile_id
       from leads l
       join campaigns c on c.id = l.campaign_id
       left join campaign_members cm
         on cm.campaign_id = l.campaign_id and cm.agent_id = l.agent_id
       left join commission_profiles cp
         on cp.id = coalesce(l.commission_profile_id, cm.commission_profile_id)
      where l.tenant_id = $1
        and l.status = 'closed_won'
        and l.account_active`,
    [tenantId]
  );

  const created = [];
  const skipped = [];

  for (const lead of rows) {
    // `select cp.*` above has flattened the rank onto the row, so rebuild it
    // into something resolveTerms understands. Only used when the lead has no
    // snapshot of its own.
    const liveProfile = lead.live_profile_id ? { ...lead, id: lead.live_profile_id } : null;
    const campaign = { currency: lead.campaign_currency, deal_value: lead.campaign_deal_value };

    const terms = products.applyTo(
      ranks.termsForLead(lead, { profile: liveProfile, campaign }),
      lead
    );
    if (!terms) {
      skipped.push({ leadId: lead.id, reason: 'no rank to calculate from' });
      continue;
    }
    if (!terms.recurring_enabled) {
      skipped.push({ leadId: lead.id, reason: 'rank has no recurring commission' });
      continue;
    }

    // Has the recurring window run out? Read from the terms the lead was
    // referred under — shortening a rank's window must not cut off accounts
    // that are already running.
    const startedOn = lead.account_started_on || lead.closed_at || lead.created_at;
    if (!withinRecurringWindow({
      startedOn,
      period: p,
      recurringMonths: terms.recurring_months,
    })) {
      skipped.push({ leadId: lead.id, reason: 'outside recurring window' });
      continue;
    }

    const calc = calculate(terms, 'recurring');
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
        tenantId, lead.id, lead.agent_id, lead.campaign_id,
        lead.commission_profile_id || terms.commission_profile_id || lead.live_profile_id,
        calc.amount, calc.currency, calc.basis_amount, calc.rate_label,
        p, payoutDate(p, terms.payout_day),
      ]
    );

    if (row) created.push(row);
    else skipped.push({ leadId: lead.id, reason: 'already accrued for this period' });
  }

  return { period: p, created, skipped };
}

/**
 * Undo the money side of a lead that was closed by mistake.
 *
 * What "undo" means depends entirely on how far the money travelled, and
 * flattening that distinction is how records start lying:
 *
 *   pending / approved — nothing has left the account. Void it. Clean.
 *   paid               — the agent has the money. Voiding it would leave the
 *                        books saying they were never paid, which is false and
 *                        surfaces at the worst possible moment. Post a matching
 *                        negative entry instead: the original stays exactly as
 *                        it is, the two net to zero, and a statement reads
 *                        honestly as "paid, then reversed".
 *
 * Returns what it did, so the caller can tell the admin plainly.
 */
async function unwindForLead(tenantId, leadId, { reason, actorName } = {}) {
  const rows = await db.all(
    `select * from commissions
      where tenant_id = $1 and lead_id = $2 and status <> 'void' and reverses_id is null
      order by created_at`,
    [tenantId, leadId]
  );

  const voided = [];
  const reversed = [];

  for (const c of rows) {
    if (c.status === 'paid') {
      const note = reason
        ? `Reversed: ${reason}`
        : 'Reversed because the lead was reopened.';

      const entry = await db.one(
        `insert into commissions
           (tenant_id, lead_id, agent_id, campaign_id, commission_profile_id, kind,
            amount, currency, basis_amount, rate_label, period, status, payout_date,
            reverses_id, reversal_reason, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'paid',$12,$13,$14,$15)
         returning *`,
        [
          tenantId, c.lead_id, c.agent_id, c.campaign_id, c.commission_profile_id, c.kind,
          -Math.abs(Number(c.amount) || 0), c.currency, c.basis_amount,
          c.rate_label ? `reversal of ${c.rate_label}` : 'reversal',
          // Booked in the current period, not the original's. The reversal
          // happens now, and dating it to a month that is already reported
          // would quietly restate a statement the agent has already read.
          tz.periodKey(), c.payout_date, c.id, note,
          actorName ? `Reversed by ${actorName}.` : null,
        ]
      );
      reversed.push(entry);
    } else {
      const note = reason ? `Voided: ${reason}` : 'Voided because the lead was reopened.';
      const updated = await db.one(
        `update commissions
            set status = 'void',
                notes = trim(both E'\n' from coalesce(notes, '') || E'\n' || $2)
          where id = $1 returning *`,
        [c.id, note]
      );
      voided.push(updated);
    }
  }

  return { voided, reversed };
}

/**
 * An agent's record on one campaign, as the promotion rules measure it.
 *
 * Deals are counted as closed/won leads rather than commission rows, so a lead
 * whose commission was voided still counts as work done. Earnings exclude void.
 */
async function agentCampaignStats(tenantId, agentId, campaignId) {
  const row = await db.one(
    `select
       (select count(*) from leads
         where tenant_id = $1 and agent_id = $2 and campaign_id = $3
           and status = 'closed_won')::int as closed_deals,
       (select coalesce(sum(amount), 0) from commissions
         where tenant_id = $1 and agent_id = $2 and campaign_id = $3
           and status <> 'void')::numeric  as earned`,
    [tenantId, agentId, campaignId]
  );
  return {
    closedDeals: row ? Number(row.closed_deals) || 0 : 0,
    earned: row ? Number(row.earned) || 0 : 0,
  };
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
  calculate, payoutDate, profileForLead, termsForLead, createInitial,
  accrueRecurring, unwindForLead, agentCampaignStats, agentTotals, tenantTotals,
  round2, withinRecurringWindow,
};
