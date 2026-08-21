'use strict';

/** Admin: commissions and reports. Tracking only — no payment is ever moved. */

const express = require('express');
const { stringify } = require('csv-stringify/sync');

const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const commissions = require('../lib/commissions');

const router = express.Router();

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------

function commissionFilters(req) {
  const where = ['cm.tenant_id = $1'];
  const params = [req.tenant.id];

  if (req.query.status) { params.push(req.query.status); where.push(`cm.status = $${params.length}`); }
  if (req.query.agent) { params.push(req.query.agent); where.push(`cm.agent_id = $${params.length}`); }
  if (req.query.campaign) { params.push(req.query.campaign); where.push(`cm.campaign_id = $${params.length}`); }
  if (req.query.period) { params.push(req.query.period); where.push(`cm.period = $${params.length}`); }
  if (req.query.kind) { params.push(req.query.kind); where.push(`cm.kind = $${params.length}`); }

  return { clause: where.join(' and '), params };
}

router.get('/commissions', async (req, res, next) => {
  try {
    const { clause, params } = commissionFilters(req);

    const countRow = await db.one(`select count(*)::int as n from commissions cm where ${clause}`, params);
    const page = util.paginate(countRow.n, req.query.page, 40);

    const listParams = params.slice();
    listParams.push(page.perPage, page.offset);

    const [rows, totals, agents, campaigns, periods] = await Promise.all([
      db.all(
        `select cm.*, p.full_name as agent_name, p.email as agent_email,
                c.name as campaign_name, l.reference, l.first_name, l.last_name,
                cp.name as profile_name
           from commissions cm
           join profiles p on p.id = cm.agent_id
           join campaigns c on c.id = cm.campaign_id
           left join leads l on l.id = cm.lead_id
           left join commission_profiles cp on cp.id = cm.commission_profile_id
          where ${clause}
          order by cm.period desc, cm.created_at desc
          limit $${listParams.length - 1} offset $${listParams.length}`,
        listParams
      ),
      commissions.tenantTotals(req.tenant.id),
      db.all("select id, full_name, email from profiles where tenant_id = $1 and role = 'agent' order by full_name", [req.tenant.id]),
      db.all('select id, name from campaigns where tenant_id = $1 order by name', [req.tenant.id]),
      db.all('select distinct period from commissions where tenant_id = $1 order by period desc limit 24', [req.tenant.id]),
    ]);

    const filtered = await db.one(
      `select coalesce(sum(amount),0)::numeric as sum, count(*)::int as n from commissions cm where ${clause}`,
      params
    );

    res.render('admin/commissions', {
      title: 'Commissions',
      rows, totals, agents, campaigns, periods, page,
      filteredTotal: filtered.sum,
      basePath: '/admin/commissions',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/commissions/:id/status', async (req, res, next) => {
  try {
    const row = await db.one(
      `select cm.*, p.full_name as agent_name, p.email as agent_email,
              c.name as campaign_name
         from commissions cm
         join profiles p on p.id = cm.agent_id
         join campaigns c on c.id = cm.campaign_id
        where cm.id = $1 and cm.tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (!row) return next();

    const status = ['pending', 'approved', 'paid', 'void'].includes(req.body.status) ? req.body.status : null;
    if (!status || status === row.status) return res.redirect(req.get('referer') || '/admin/commissions');

    const updated = await db.one(
      // $2 is bound as TEXT and cast to the enum where it is assigned. Without
      // the cast Postgres deduces it two ways in one statement and refuses the
      // query with "inconsistent types deduced for parameter $2".
      `update commissions set status = $2::commission_status,
              paid_at = case when $2 = 'paid' then now() else null end
        where id = $1::uuid returning *`,
      [row.id, status]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'commission.status_changed',
      entityType: 'commission',
      entityId: row.id,
      summary: `${util.money(row.amount, row.currency)} for ${row.agent_name || row.agent_email}: ${row.status} → ${status}`,
      before: { status: row.status, amount: row.amount },
      after: { status, amount: row.amount },
    });

    if (status === 'approved' || status === 'paid') {
      const agent = await db.one('select * from profiles where id = $1', [row.agent_id]);
      const campaign = await db.one('select * from campaigns where id = $1', [row.campaign_id]);
      const lead = row.lead_id ? await db.one('select * from leads where id = $1', [row.lead_id]) : null;

      notify.fire(status === 'paid' ? 'commission_paid' : 'commission_approved', {
        tenantId: req.tenant.id, lead, agent, campaign, commission: updated, recipients: ['agent'],
      }).catch((e) => console.error('[notify] commission status failed:', e.message));
    }

    req.flash('success', `Marked ${status}.`);
    return res.redirect(req.get('referer') || '/admin/commissions');
  } catch (err) {
    next(err);
  }
});

/** Bulk transition — the month-end workflow. */
router.post('/commissions/bulk', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).filter(Boolean);
    const status = ['approved', 'paid', 'void', 'pending'].includes(req.body.status) ? req.body.status : null;

    if (!ids.length || !status) {
      req.flash('error', 'Select at least one commission and an action.');
      return res.redirect(req.get('referer') || '/admin/commissions');
    }

    const rows = await db.all(
      // $2 is bound as TEXT and cast to the enum where it is assigned. Without
      // the cast Postgres deduces it two ways in one statement and refuses the
      // query with "inconsistent types deduced for parameter $2".
      `update commissions set status = $2::commission_status,
              paid_at = case when $2 = 'paid' then now() else null end
        where tenant_id = $1::uuid and id = any($3::uuid[]) returning *`,
      [req.tenant.id, status, ids]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'commission.status_changed',
      entityType: 'commission',
      summary: `${rows.length} commission${rows.length === 1 ? '' : 's'} marked ${status} (${util.money(rows.reduce((s, r) => s + Number(r.amount), 0))})`,
      after: { status, count: rows.length, ids },
    });

    req.flash('success', `${rows.length} commission${rows.length === 1 ? '' : 's'} marked ${status}.`);
    return res.redirect(req.get('referer') || '/admin/commissions');
  } catch (err) {
    next(err);
  }
});

router.get('/commissions.csv', async (req, res, next) => {
  try {
    const { clause, params } = commissionFilters(req);
    const rows = await db.all(
      `select cm.*, p.full_name as agent_name, p.email as agent_email,
              c.name as campaign_name, l.reference
         from commissions cm
         join profiles p on p.id = cm.agent_id
         join campaigns c on c.id = cm.campaign_id
         left join leads l on l.id = cm.lead_id
        where ${clause} order by cm.period desc limit 10000`,
      params
    );

    const csv = stringify(
      rows.map((r) => ({
        Period: tz.periodLabel(r.period),
        Agent: r.agent_name || r.agent_email,
        Email: r.agent_email,
        Campaign: r.campaign_name,
        Lead: r.reference || '',
        Type: r.kind,
        Rate: r.rate_label || '',
        Basis: Number(r.basis_amount).toFixed(2),
        Amount: Number(r.amount).toFixed(2),
        Currency: r.currency,
        Status: r.status,
        'Payout date': r.payout_date ? tz.fmtDate(r.payout_date) : '',
        'Paid at': r.paid_at ? tz.fmtShort(r.paid_at, req.user.timezone) : '',
      })),
      { header: true }
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commissions-${tz.isoDate()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/** Run the recurring accrual by hand, rather than waiting for the monthly job. */
router.post('/commissions/accrue', async (req, res, next) => {
  try {
    const period = util.text(req.body.period) || tz.periodKey();
    const result = await commissions.accrueRecurring(req.tenant.id, { period });

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'commission.accrued',
      entityType: 'commission',
      summary: `Recurring accrual run for ${tz.periodLabel(period)}: ${result.created.length} created, ${result.skipped.length} skipped`,
      after: { period, created: result.created.length, skipped: result.skipped.length },
    });

    req.flash('success', `${result.created.length} recurring commission${result.created.length === 1 ? '' : 's'} created for ${tz.periodLabel(period)}.`);
    return res.redirect('/admin/commissions');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get('/reports', async (req, res, next) => {
  try {
    const [byAgent, byCampaign, byMonth, funnel, relationPerformance] = await Promise.all([
      db.all(
        `select p.id, p.full_name, p.email,
                count(distinct l.id)::int as leads,
                count(distinct l.id) filter (where l.status = 'closed_won')::int as won,
                coalesce(sum(cm.amount) filter (where cm.status <> 'void'), 0)::numeric as earned,
                coalesce(sum(cm.amount) filter (where cm.status = 'paid'), 0)::numeric as paid
           from profiles p
           left join leads l on l.agent_id = p.id
           left join commissions cm on cm.agent_id = p.id
          where p.tenant_id = $1 and p.role = 'agent'
          group by p.id, p.full_name, p.email
          having count(distinct l.id) > 0 or coalesce(sum(cm.amount), 0) > 0
          order by earned desc, leads desc`,
        [req.tenant.id]
      ),
      db.all(
        `select c.id, c.name,
                count(l.id)::int as leads,
                count(l.id) filter (where l.status = 'closed_won')::int as won,
                count(l.id) filter (where l.account_active)::int as active_accounts,
                coalesce(sum(cm.amount) filter (where cm.status <> 'void'), 0)::numeric as commission
           from campaigns c
           left join leads l on l.campaign_id = c.id
           left join commissions cm on cm.campaign_id = c.id
          where c.tenant_id = $1
          group by c.id, c.name order by leads desc`,
        [req.tenant.id]
      ),
      db.all(
        `select date_trunc('month', created_at)::date as month,
                count(*)::int as leads,
                count(*) filter (where status = 'closed_won')::int as won
           from leads where tenant_id = $1
          group by 1 order by 1 desc limit 12`,
        [req.tenant.id]
      ),
      db.all('select status, count(*)::int as n from leads where tenant_id = $1 group by status', [req.tenant.id]),
      db.all(
        `select coalesce(ro.label, 'Not set') as relation,
                count(l.id)::int as leads,
                count(l.id) filter (where l.status = 'closed_won')::int as won
           from leads l
           left join relation_options ro on ro.tenant_id = l.tenant_id and ro.code = l.relation_code
          where l.tenant_id = $1
          group by 1 order by leads desc`,
        [req.tenant.id]
      ),
    ]);

    res.render('admin/reports', {
      title: 'Reports',
      byAgent, byCampaign, byMonth, relationPerformance,
      funnel: Object.fromEntries(funnel.map((f) => [f.status, f.n])),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/reports/agents.csv', async (req, res, next) => {
  try {
    const rows = await db.all(
      `select p.full_name, p.email,
              count(distinct l.id)::int as leads,
              count(distinct l.id) filter (where l.status = 'closed_won')::int as won,
              coalesce(sum(cm.amount) filter (where cm.status <> 'void'), 0)::numeric as earned,
              coalesce(sum(cm.amount) filter (where cm.status = 'paid'), 0)::numeric as paid
         from profiles p
         left join leads l on l.agent_id = p.id
         left join commissions cm on cm.agent_id = p.id
        where p.tenant_id = $1 and p.role = 'agent'
        group by p.id, p.full_name, p.email order by earned desc`,
      [req.tenant.id]
    );

    const csv = stringify(
      rows.map((r) => ({
        Agent: r.full_name || r.email,
        Email: r.email,
        Leads: r.leads,
        Won: r.won,
        'Conversion %': r.leads ? Math.round((r.won / r.leads) * 100) : 0,
        Earned: Number(r.earned).toFixed(2),
        Paid: Number(r.paid).toFixed(2),
      })),
      { header: true }
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-performance-${tz.isoDate()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
