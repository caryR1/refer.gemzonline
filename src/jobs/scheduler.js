'use strict';

/**
 * Scheduled work.
 *
 *   • appointment reminders   — every REMINDER_INTERVAL_MINUTES
 *   • recurring accrual       — monthly
 *   • commission statements   — monthly, to admin and each agent
 *   • recurring-account review— monthly, admin only
 *   • stale lead alert        — weekly
 *
 * Every run is written to `job_runs` so an operator can see what happened
 * without reading server logs.
 */

const cron = require('node-cron');
const { DateTime } = require('luxon');

const config = require('../config');
const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const notify = require('../lib/notify');
const mailer = require('../lib/mailer');
const templates = require('../lib/templates');
const commissions = require('../lib/commissions');
const tenant = require('../lib/tenant');

const tasks = [];

async function recordRun(tenantId, job, status, detail) {
  try {
    await db.query(
      'insert into job_runs (tenant_id, job, status, detail) values ($1,$2,$3,$4)',
      [tenantId, job, status, JSON.stringify(detail || {})]
    );
  } catch (err) {
    console.error(`[jobs] could not record ${job} run:`, err.message);
  }
}

/** Wrap a job so one failure never kills the scheduler. */
function safely(name, fn) {
  return async () => {
    const started = Date.now();
    try {
      const detail = await fn();
      const ms = Date.now() - started;
      console.log(`[jobs] ${name} ok (${ms}ms)`, detail ? JSON.stringify(detail) : '');
    } catch (err) {
      console.error(`[jobs] ${name} FAILED:`, err.message);
      try {
        const t = await tenant.current();
        await recordRun(t.id, name, 'failed', { error: err.message });
      } catch (_) { /* nothing more we can do */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Appointment reminders
// ---------------------------------------------------------------------------

/**
 * Find every reminder slot that has come due and dispatch it.
 *
 * A slot is due when the appointment is between now and (now + offset). The
 * `reminder_sends` unique key — including the appointment time — makes this
 * idempotent, and means a rescheduled appointment gets a fresh set of reminders.
 */
async function runReminders() {
  const t = await tenant.current();

  const slots = await db.all(
    `select cr.*, c.name as campaign_name
       from campaign_reminders cr
       join campaigns c on c.id = cr.campaign_id
      where cr.tenant_id = $1 and cr.active and c.status = 'active'
        and (cr.channel_email or cr.channel_whatsapp)
        and (cr.to_prospect or cr.to_agent or cr.to_admin)`,
    [t.id]
  );

  let sent = 0;
  let considered = 0;

  for (const slot of slots) {
    const interval = `${slot.offset_value} ${slot.offset_unit}`;

    // The appointment that matters is the confirmed one, primary by default.
    const leads = await db.all(
      `select l.*,
              case when l.confirmed_slot = 'backup' then l.appointment_backup_at
                   else l.appointment_primary_at end as target_at
         from leads l
        where l.tenant_id = $1
          and l.campaign_id = $2
          and l.status not in ('closed_won','closed_lost')
          and not l.cancelled_by_prospect
          and (case when l.confirmed_slot = 'backup' then l.appointment_backup_at
                    else l.appointment_primary_at end) is not null
          and (case when l.confirmed_slot = 'backup' then l.appointment_backup_at
                    else l.appointment_primary_at end) between now()
              and now() + $3::interval`,
      [t.id, slot.campaign_id, interval]
    );

    considered += leads.length;

    for (const lead of leads) {
      const campaign = await db.one('select * from campaigns where id = $1', [lead.campaign_id]);
      const agent = lead.agent_id ? await db.one('select * from profiles where id = $1', [lead.agent_id]) : null;

      const channels = [];
      if (slot.channel_email) channels.push('email');
      if (slot.channel_whatsapp) channels.push('whatsapp');

      const recipients = [];
      if (slot.to_prospect) recipients.push('lead');
      if (slot.to_agent) recipients.push('agent');
      if (slot.to_admin) recipients.push('admin');

      // Claim each (lead, slot, channel, recipient, time) before sending, so a
      // second worker or an overlapping run cannot double-send.
      const claims = [];
      for (const channel of channels) {
        for (const recipient of recipients) {
          const claimed = await db.one(
            `insert into reminder_sends (tenant_id, lead_id, slot, channel, recipient, appointment_at)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (lead_id, slot, channel, recipient, appointment_at) do nothing
             returning id`,
            [t.id, lead.id, slot.slot, channel, recipient, lead.target_at]
          );
          if (claimed) claims.push({ channel, recipient });
        }
      }

      if (!claims.length) continue;

      const byChannel = {};
      claims.forEach((c) => {
        byChannel[c.channel] = byChannel[c.channel] || [];
        byChannel[c.channel].push(c.recipient);
      });

      for (const [channel, recipientList] of Object.entries(byChannel)) {
        await notify.fire('appointment_reminder', {
          tenantId: t.id,
          lead, agent, campaign,
          channels: [channel],
          recipients: recipientList,
          reminderSlot: slot.slot,
        });
        sent += recipientList.length;
      }
    }
  }

  const detail = { slots: slots.length, considered, sent };
  if (sent) await recordRun(t.id, 'appointment_reminders', 'ok', detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Monthly: accrue recurring commission, then send statements
// ---------------------------------------------------------------------------

async function runMonthlyAccrual() {
  const t = await tenant.current();
  const period = tz.periodKey();
  const result = await commissions.accrueRecurring(t.id, { period });
  const detail = { period, created: result.created.length, skipped: result.skipped.length };
  await recordRun(t.id, 'recurring_accrual', 'ok', detail);
  return detail;
}

/** Build a small HTML statement table for one agent. */
function statementHtml(rows, heading) {
  if (!rows.length) return `<p>${heading}: nothing this period.</p>`;
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const currency = rows[0].currency || 'USD';

  const body = rows.map((r) => `
    <tr>
      <td>${util.escapeHtml(r.campaign_name || '')}</td>
      <td>${util.escapeHtml(r.reference || '—')}</td>
      <td>${util.escapeHtml(r.kind)}</td>
      <td style="text-align:right">${util.escapeHtml(util.money(r.amount, r.currency))}</td>
      <td>${util.escapeHtml(r.status)}</td>
    </tr>`).join('');

  return `<h3>${util.escapeHtml(heading)}</h3>
<table class="data">
  <tr><th>Campaign</th><th>Lead</th><th>Type</th><th style="text-align:right">Amount</th><th>Status</th></tr>
  ${body}
  <tr><th colspan="3">Total</th><th style="text-align:right">${util.escapeHtml(util.money(total, currency))}</th><th></th></tr>
</table>`;
}

async function runMonthlyStatements() {
  const t = await tenant.current();
  const period = tz.periodKey();

  const agents = await db.all(
    `select distinct p.* from profiles p
       join commissions cm on cm.agent_id = p.id
      where p.tenant_id = $1 and p.status = 'active' and cm.period = $2`,
    [t.id, period]
  );

  let sentTo = 0;

  for (const agent of agents) {
    const rows = await db.all(
      `select cm.*, c.name as campaign_name, l.reference
         from commissions cm
         join campaigns c on c.id = cm.campaign_id
         left join leads l on l.id = cm.lead_id
        where cm.agent_id = $1 and cm.period = $2 and cm.status <> 'void'
        order by cm.kind, c.name`,
      [agent.id, period]
    );
    if (!rows.length) continue;

    const enabled = await notify.isEnabled(t.id, agent.id, 'monthly_report', 'email');
    if (!enabled || !mailer.available()) continue;

    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const inner = `
      <h2>Your ${tz.periodLabel(period)} statement</h2>
      <p>Hello ${util.escapeHtml((agent.full_name || '').split(' ')[0] || 'there')}, here is everything recorded for you this period.</p>
      ${statementHtml(rows, 'Commission this period')}
      <p><a class="button" href="${config.appUrl}/agent/earnings">Open my earnings</a></p>
      <p class="muted">Amounts shown are what has been recorded. Payment happens separately, on the payout day for each rank.</p>`;

    const html = templates.wrap(inner, { title: `${tz.periodLabel(period)} statement` });
    const result = await mailer.send({
      to: agent.email,
      subject: `Your ${tz.periodLabel(period)} commission statement — ${util.money(total, rows[0].currency)}`,
      html,
      text: templates.toPlainText(inner),
    });

    await notify.logSend(t.id, {
      channel: 'email', agentId: agent.id, to: agent.email, recipient: 'agent',
      subject: `${tz.periodLabel(period)} commission statement`,
      body: html, eventKey: 'monthly_report',
      status: result.ok ? 'sent' : 'failed', error: result.error, messageId: result.messageId,
    });

    if (result.ok) sentTo += 1;
  }

  // Admin summary
  const summary = await db.all(
    `select p.full_name, p.email,
            sum(cm.amount)::numeric as total,
            count(*)::int as entries
       from commissions cm join profiles p on p.id = cm.agent_id
      where cm.tenant_id = $1 and cm.period = $2 and cm.status <> 'void'
      group by p.full_name, p.email order by total desc`,
    [t.id, period]
  );

  if (summary.length && mailer.available()) {
    const grand = summary.reduce((sum, r) => sum + Number(r.total), 0);
    const inner = `
      <h2>${tz.periodLabel(period)} commission summary</h2>
      <p>${summary.length} agent${summary.length === 1 ? '' : 's'} earned ${util.escapeHtml(util.money(grand))} this period.</p>
      <table class="data">
        <tr><th>Agent</th><th style="text-align:right">Entries</th><th style="text-align:right">Total</th></tr>
        ${summary.map((r) => `<tr><td>${util.escapeHtml(r.full_name || r.email)}</td><td style="text-align:right">${r.entries}</td><td style="text-align:right">${util.escapeHtml(util.money(r.total))}</td></tr>`).join('')}
        <tr><th>Total</th><th style="text-align:right"></th><th style="text-align:right">${util.escapeHtml(util.money(grand))}</th></tr>
      </table>
      <p><a class="button" href="${config.appUrl}/admin/commissions">Review and approve</a></p>`;

    const admins = await db.all("select * from profiles where tenant_id = $1 and role = 'admin' and status = 'active'", [t.id]);
    for (const admin of admins) {
      if (!(await notify.isEnabled(t.id, admin.id, 'monthly_report', 'email'))) continue;
      const html = templates.wrap(inner, { title: 'Commission summary' });
      const result = await mailer.send({
        to: admin.email,
        subject: `[${config.appName}] ${tz.periodLabel(period)} commission summary`,
        html,
        text: templates.toPlainText(inner),
      });
      await notify.logSend(t.id, {
        channel: 'email', agentId: admin.id, to: admin.email, recipient: 'admin',
        subject: `${tz.periodLabel(period)} commission summary`, body: html,
        eventKey: 'monthly_report',
        status: result.ok ? 'sent' : 'failed', error: result.error, messageId: result.messageId,
      });
    }
  }

  const detail = { period, agents: sentTo };
  await recordRun(t.id, 'monthly_statements', 'ok', detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Monthly: recurring-account review, so nothing keeps paying out unnoticed
// ---------------------------------------------------------------------------

async function runAccountReview() {
  const t = await tenant.current();

  const rows = await db.all(
    `select l.reference, l.first_name, l.last_name, l.email, l.account_started_on,
            c.name as campaign_name, p.full_name as agent_name,
            cp.name as profile_name, cp.recurring_months,
            cp.recurring_type, cp.recurring_value, cp.deal_value, cp.currency
       from leads l
       join campaigns c on c.id = l.campaign_id
       left join profiles p on p.id = l.agent_id
       left join campaign_members cm on cm.campaign_id = l.campaign_id and cm.agent_id = l.agent_id
       left join commission_profiles cp on cp.id = cm.commission_profile_id
      where l.tenant_id = $1 and l.account_active
      order by c.name, l.account_started_on`,
    [t.id]
  );

  if (!rows.length || !mailer.available()) {
    const detail = { accounts: rows.length, emailed: 0 };
    await recordRun(t.id, 'account_review', 'ok', detail);
    return detail;
  }

  const inner = `
    <h2>Recurring accounts still active</h2>
    <p>${rows.length} account${rows.length === 1 ? ' is' : 's are'} accruing recurring commission.
       Anything on this list that has actually cancelled should be switched off, or it keeps paying out.</p>
    <table class="data">
      <tr><th>Account</th><th>Campaign</th><th>Agent</th><th>Since</th><th style="text-align:right">Monthly</th></tr>
      ${rows.map((r) => {
    const monthly = r.recurring_type === 'fixed'
      ? Number(r.recurring_value || 0)
      : (Number(r.deal_value || 0) * Number(r.recurring_value || 0)) / 100;
    return `<tr>
          <td>${util.escapeHtml([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email)}<br>
              <span style="color:#5b6675;font-size:12px">${util.escapeHtml(r.reference)}</span></td>
          <td>${util.escapeHtml(r.campaign_name)}</td>
          <td>${util.escapeHtml(r.agent_name || '—')}</td>
          <td>${r.account_started_on ? util.escapeHtml(tz.fmtDate(r.account_started_on)) : '—'}</td>
          <td style="text-align:right">${util.escapeHtml(util.money(monthly, r.currency || 'USD'))}</td>
        </tr>`;
  }).join('')}
    </table>
    <p><a class="button" href="${config.appUrl}/admin/leads?account=active">Review active accounts</a></p>`;

  const admins = await db.all("select * from profiles where tenant_id = $1 and role = 'admin' and status = 'active'", [t.id]);
  let emailed = 0;

  for (const admin of admins) {
    if (!(await notify.isEnabled(t.id, admin.id, 'monthly_account_review', 'email'))) continue;
    const html = templates.wrap(inner, { title: 'Active recurring accounts' });
    const result = await mailer.send({
      to: admin.email,
      subject: `[${config.appName}] ${rows.length} recurring account${rows.length === 1 ? '' : 's'} to review`,
      html,
      text: templates.toPlainText(inner),
    });
    await notify.logSend(t.id, {
      channel: 'email', agentId: admin.id, to: admin.email, recipient: 'admin',
      subject: 'Active recurring accounts', body: html, eventKey: 'monthly_account_review',
      status: result.ok ? 'sent' : 'failed', error: result.error, messageId: result.messageId,
    });
    if (result.ok) emailed += 1;
  }

  const detail = { accounts: rows.length, emailed };
  await recordRun(t.id, 'account_review', 'ok', detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Weekly: stale leads
// ---------------------------------------------------------------------------

async function runStaleLeads() {
  const t = await tenant.current();
  const days = config.cron.staleLeadDays;

  const rows = await db.all(
    `select l.*, c.name as campaign_name, p.full_name as agent_name, p.email as agent_email, p.id as agent_pid
       from leads l
       join campaigns c on c.id = l.campaign_id
       left join profiles p on p.id = l.agent_id
      where l.tenant_id = $1
        and l.status in ('new','contacted')
        and coalesce(l.last_contacted_at, l.created_at) < now() - ($2 || ' days')::interval
      order by coalesce(l.last_contacted_at, l.created_at)`,
    [t.id, String(days)]
  );

  if (!rows.length || !mailer.available()) {
    await recordRun(t.id, 'stale_leads', 'ok', { stale: rows.length, emailed: 0 });
    return { stale: rows.length, emailed: 0 };
  }

  // Group by agent so nobody gets a list of other people's leads.
  const byAgent = new Map();
  rows.forEach((r) => {
    const key = r.agent_pid || 'unassigned';
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(r);
  });

  let emailed = 0;

  for (const [agentId, leads] of byAgent) {
    if (agentId === 'unassigned') continue;
    if (!(await notify.isEnabled(t.id, agentId, 'stale_lead', 'email'))) continue;

    const agent = await db.one('select * from profiles where id = $1', [agentId]);
    if (!agent || agent.status !== 'active') continue;

    const inner = `
      <h2>${leads.length} lead${leads.length === 1 ? '' : 's'} waiting on you</h2>
      <p>These have had no contact for ${days} days or more.</p>
      <table class="data">
        <tr><th>Name</th><th>Campaign</th><th>Waiting since</th></tr>
        ${leads.map((l) => `<tr>
            <td>${util.escapeHtml([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email)}</td>
            <td>${util.escapeHtml(l.campaign_name)}</td>
            <td>${util.escapeHtml(tz.fmtDate(l.last_contacted_at || l.created_at))}</td>
          </tr>`).join('')}
      </table>
      <p><a class="button" href="${config.appUrl}/agent/leads">Open my pipeline</a></p>`;

    const html = templates.wrap(inner, { title: 'Leads waiting' });
    const result = await mailer.send({
      to: agent.email,
      subject: `${leads.length} lead${leads.length === 1 ? '' : 's'} waiting on you`,
      html,
      text: templates.toPlainText(inner),
    });

    await notify.logSend(t.id, {
      channel: 'email', agentId: agent.id, to: agent.email, recipient: 'agent',
      subject: 'Leads waiting', body: html, eventKey: 'stale_lead',
      status: result.ok ? 'sent' : 'failed', error: result.error, messageId: result.messageId,
    });

    if (result.ok) emailed += 1;
  }

  const detail = { stale: rows.length, emailed };
  await recordRun(t.id, 'stale_leads', 'ok', detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function start() {
  const zone = config.staffTimezone;
  const hour = config.cron.jobHour;
  const day = config.cron.monthlyReportDay;
  const every = config.cron.reminderIntervalMinutes;

  const schedule = (expr, name, fn) => {
    const task = cron.schedule(expr, safely(name, fn), { timezone: zone });
    tasks.push(task);
    return task;
  };

  // Reminders — frequently, because a "1 hour before" slot needs granularity.
  schedule(`*/${Math.min(59, Math.max(1, every))} * * * *`, 'appointment_reminders', runReminders);

  // Month start: accrue, then a little later send the statements.
  schedule(`0 ${hour} ${day} * *`, 'recurring_accrual', runMonthlyAccrual);
  schedule(`30 ${hour} ${day} * *`, 'monthly_statements', runMonthlyStatements);
  schedule(`0 ${(hour + 1) % 24} ${day} * *`, 'account_review', runAccountReview);

  // Weekly nudge, Monday morning.
  schedule(`0 ${hour} * * 1`, 'stale_leads', runStaleLeads);

  console.log(`  Scheduler running (${zone}): reminders every ${every}m; monthly jobs on day ${day} at ${String(hour).padStart(2, '0')}:00.`);
}

function stop() {
  tasks.forEach((t) => t.stop());
  tasks.length = 0;
}

module.exports = {
  start, stop,
  runReminders, runMonthlyAccrual, runMonthlyStatements, runAccountReview, runStaleLeads,
};
