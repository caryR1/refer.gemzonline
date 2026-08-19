'use strict';

/** Admin: the lead pipeline. Closing a lead lives here, because it creates money. */

const express = require('express');
const { stringify } = require('csv-stringify/sync');

const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const relations = require('../lib/relations');
const commissions = require('../lib/commissions');

const router = express.Router();

function buildLeadFilters(req) {
  const where = ['l.tenant_id = $1'];
  const params = [req.tenant.id];

  if (req.query.status) { params.push(req.query.status); where.push(`l.status = $${params.length}`); }
  if (req.query.campaign) { params.push(req.query.campaign); where.push(`l.campaign_id = $${params.length}`); }
  if (req.query.agent) { params.push(req.query.agent); where.push(`l.agent_id = $${params.length}`); }
  if (req.query.account === 'active') where.push('l.account_active');
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where.push(`(l.first_name ilike $${params.length} or l.last_name ilike $${params.length}
                 or l.email ilike $${params.length} or l.reference ilike $${params.length}
                 or l.company ilike $${params.length})`);
  }
  return { clause: where.join(' and '), params };
}

router.get('/leads', async (req, res, next) => {
  try {
    const { clause, params } = buildLeadFilters(req);

    const countRow = await db.one(`select count(*)::int as n from leads l where ${clause}`, params);
    const page = util.paginate(countRow.n, req.query.page, 30);

    const listParams = params.slice();
    listParams.push(page.perPage, page.offset);

    const [leads, campaigns, agents] = await Promise.all([
      db.all(
        `select l.*, c.name as campaign_name, p.full_name as agent_name
           from leads l
           join campaigns c on c.id = l.campaign_id
           left join profiles p on p.id = l.agent_id
          where ${clause}
          order by l.created_at desc
          limit $${listParams.length - 1} offset $${listParams.length}`,
        listParams
      ),
      db.all('select id, name from campaigns where tenant_id = $1 order by name', [req.tenant.id]),
      db.all("select id, full_name, email from profiles where tenant_id = $1 and role = 'agent' order by full_name", [req.tenant.id]),
    ]);

    res.render('admin/leads', {
      title: 'Leads',
      leads,
      campaigns,
      agents,
      page,
      relationMap: await relations.labelMap(req.tenant.id),
      basePath: '/admin/leads',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/leads.csv', async (req, res, next) => {
  try {
    const { clause, params } = buildLeadFilters(req);
    const rows = await db.all(
      `select l.*, c.name as campaign_name, p.full_name as agent_name
         from leads l join campaigns c on c.id = l.campaign_id
         left join profiles p on p.id = l.agent_id
        where ${clause} order by l.created_at desc limit 5000`,
      params
    );
    const relationMap = await relations.labelMap(req.tenant.id);

    const csv = stringify(
      rows.map((l) => ({
        Reference: l.reference,
        'First name': l.first_name,
        'Last name': l.last_name,
        Email: l.email,
        Phone: l.phone || '',
        Company: l.company || '',
        Campaign: l.campaign_name,
        Agent: l.agent_name || '',
        Relation: l.relation_code ? (relationMap[l.relation_code] || l.relation_code) : '',
        Status: util.statusMeta(l.status).label,
        'Appointment (their time)': l.appointment_primary_at ? tz.fmt(l.appointment_primary_at, l.timezone) : '',
        'Appointment (Jamaica)': l.appointment_primary_at ? tz.fmtStaff(l.appointment_primary_at) : '',
        Consent: l.consent_given ? 'Yes' : 'No',
        'Account active': l.account_active ? 'Yes' : 'No',
        Created: tz.fmtShort(l.created_at, req.user.timezone),
      })),
      { header: true }
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${tz.isoDate()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/leads/:id', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const [campaign, agent, notes, messages, relationOptions, commissionRows, profile, emailTemplates] =
      await Promise.all([
        db.one('select * from campaigns where id = $1', [lead.campaign_id]),
        lead.agent_id ? db.one('select * from profiles where id = $1', [lead.agent_id]) : null,
        db.all('select * from lead_notes where lead_id = $1 order by created_at desc', [lead.id]),
        db.all('select * from notification_log where lead_id = $1 order by created_at desc limit 30', [lead.id]),
        relations.list(req.tenant.id),
        db.all('select * from commissions where lead_id = $1 order by period desc', [lead.id]),
        commissions.profileForLead(lead),
        db.all("select id, name, slug, channel from notification_templates where tenant_id = $1 and active order by channel, name", [req.tenant.id]),
      ]);

    const preview = profile ? commissions.calculate(profile, 'initial') : null;

    res.render('admin/lead-detail', {
      title: `${lead.first_name} ${lead.last_name}`.trim() || lead.email,
      lead,
      campaign,
      agent,
      notes,
      messages,
      relationOptions,
      commissionRows,
      profile,
      preview,
      emailTemplates,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/status', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const status = String(req.body.status || '');
    if (!util.LEAD_STATUSES.some((s) => s.value === status)) {
      req.flash('error', 'That is not a valid status.');
      return res.redirect(`/admin/leads/${lead.id}`);
    }
    if (status === lead.status) return res.redirect(`/admin/leads/${lead.id}`);

    const closing = status === 'closed_won' || status === 'closed_lost';

    const updated = await db.one(
      `update leads set status = $2,
              closed_at = case when $3 then now() else null end,
              account_active = case when $2 = 'closed_won' then account_active else false end,
              account_started_on = case when $2 = 'closed_won' then account_started_on else null end,
              last_contacted_at = case when $2 = 'contacted' then now() else last_contacted_at end
        where id = $1 returning *`,
      [lead.id, status, closing]
    );

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,'status_change',$5)`,
      [
        req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email,
        `Status changed from ${util.statusMeta(lead.status).label} to ${util.statusMeta(status).label}.`,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email}: ${lead.status} → ${status}`,
      before: { status: lead.status }, after: { status },
    });

    const campaign = await db.one('select * from campaigns where id = $1', [lead.campaign_id]);
    const agent = lead.agent_id ? await db.one('select * from profiles where id = $1', [lead.agent_id]) : null;

    // Closing as won is what creates the commission.
    if (status === 'closed_won') {
      const result = await commissions.createInitial(req.tenant.id, updated);
      if (result.ok) {
        await audit.log({
          tenantId: req.tenant.id, req,
          action: 'commission.created',
          entityType: 'commission',
          entityId: result.commission.id,
          summary: `Commission of ${util.money(result.commission.amount, result.commission.currency)} created for ${agent ? agent.full_name : 'unassigned'} on ${campaign.name}`,
          after: {
            amount: result.commission.amount,
            rate: result.commission.rate_label,
            basis: result.commission.basis_amount,
            profile: result.profile.name,
          },
        });
        req.flash('success', `Closed as won. A ${util.money(result.commission.amount, result.commission.currency)} commission is pending approval.`);
      } else {
        req.flash('info', `Closed as won, but no commission was created: ${result.reason}`);
      }

      notify.fire('closed_won', { tenantId: req.tenant.id, lead: updated, agent, campaign })
        .catch((e) => console.error('[notify] closed_won failed:', e.message));
    } else {
      if (status === 'closed_lost') {
        notify.fire('closed_lost', { tenantId: req.tenant.id, lead: updated, agent, campaign })
          .catch((e) => console.error('[notify] closed_lost failed:', e.message));
      } else if (status === 'contacted') {
        notify.fire('contacted', { tenantId: req.tenant.id, lead: updated, agent, campaign })
          .catch((e) => console.error('[notify] contacted failed:', e.message));
      }
      req.flash('success', 'Status updated.');
    }

    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

/** The recurring-account switch. Turning it off stops accrual and tells the agent. */
router.post('/leads/:id/account', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const active = util.bool(req.body.account_active);

    if (active && lead.status !== 'closed_won') {
      req.flash('error', 'Only a lead closed as won can have an active recurring account.');
      return res.redirect(`/admin/leads/${lead.id}`);
    }

    const updated = await db.one(
      `update leads set
         account_active = $2,
         account_started_on = case when $2 and account_started_on is null then current_date
                                   when $2 then account_started_on else account_started_on end,
         account_dropped_at = case when $2 then null else now() end
       where id = $1 returning *`,
      [lead.id, active]
    );

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,'system',$5)`,
      [
        req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email,
        active
          ? 'Recurring account switched on. Monthly commission will accrue from the next run.'
          : 'Recurring account cancelled. No further commission will accrue.',
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.account_toggled',
      entityType: 'lead',
      entityId: lead.id,
      summary: `Recurring account for ${lead.email} ${active ? 'activated' : 'cancelled'}`,
      before: { account_active: lead.account_active },
      after: { account_active: active },
    });

    if (!active && lead.account_active) {
      const campaign = await db.one('select * from campaigns where id = $1', [lead.campaign_id]);
      const agent = lead.agent_id ? await db.one('select * from profiles where id = $1', [lead.agent_id]) : null;
      notify.fire('account_dropped', {
        tenantId: req.tenant.id, lead: updated, agent, campaign, recipients: ['agent', 'admin'],
      }).catch((e) => console.error('[notify] account_dropped failed:', e.message));
      req.flash('success', 'Recurring account cancelled and the agent has been notified.');
    } else {
      req.flash('success', active ? 'Recurring account activated.' : 'Recurring account switched off.');
    }

    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/appointment', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const slot = req.body.confirmed_slot === 'backup' ? 'backup'
      : (req.body.confirmed_slot === 'primary' ? 'primary' : null);

    await db.query('update leads set confirmed_slot = $2 where id = $1', [lead.id, slot]);
    await db.query('delete from reminder_sends where lead_id = $1', [lead.id]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.appointment_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `Confirmed the ${slot || 'primary (default)'} slot for ${lead.email}`,
      before: { confirmed_slot: lead.confirmed_slot },
      after: { confirmed_slot: slot },
    });

    req.flash('success', `Reminders will now follow the ${slot || 'primary'} time.`);
    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/relation', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const code = util.text(req.body.relation_code, 60) || null;
    const note = util.text(req.body.relation_note, 500) || null;

    await db.query('update leads set relation_code = $2, relation_note = $3 where id = $1', [lead.id, code, note]);
    const label = code ? await relations.labelFor(req.tenant.id, code) : 'not set';

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.relation_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `Relation for ${lead.email} set to ${label}`,
      before: { relation_code: lead.relation_code },
      after: { relation_code: code },
    });

    req.flash('success', 'Relation saved.');
    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/note', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const body = util.text(req.body.body, 4000);
    const kind = ['note', 'call', 'meeting'].includes(req.body.kind) ? req.body.kind : 'note';
    if (!body) return res.redirect(`/admin/leads/${lead.id}`);

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,$5,$6)`,
      [req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email, kind, body]
    );

    if (kind === 'call' || kind === 'meeting') {
      await db.query('update leads set last_contacted_at = now() where id = $1', [lead.id]);
    }

    req.flash('success', 'Note added.');
    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

/** Reassign a lead to a different agent — changes who gets paid, so it is audited. */
router.post('/leads/:id/agent', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const agentId = util.text(req.body.agent_id) || null;
    let member = null;

    if (agentId) {
      member = await db.one(
        "select * from campaign_members where campaign_id = $1 and agent_id = $2 and status = 'active'",
        [lead.campaign_id, agentId]
      );
      if (!member) {
        req.flash('error', 'That agent is not on this campaign. Add them to it first.');
        return res.redirect(`/admin/leads/${lead.id}`);
      }
    }

    await db.query('update leads set agent_id = $2, member_id = $3 where id = $1',
      [lead.id, agentId, member ? member.id : null]);

    const newAgent = agentId ? await db.one('select full_name, email from profiles where id = $1', [agentId]) : null;

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.agent_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email} reassigned to ${newAgent ? (newAgent.full_name || newAgent.email) : 'nobody'}`,
      before: { agent_id: lead.agent_id },
      after: { agent_id: agentId },
    });

    req.flash('success', 'Lead reassigned.');
    return res.redirect(`/admin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
