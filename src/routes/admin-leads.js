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
const products = require('../lib/products');

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
        // Joined and split. The one-line version is what a person reads; the
        // separate parts are what a mail merge or a mapping tool needs.
        Address: util.addressOneLine(l),
        'Address line 1': l.address || '',
        'Address line 2': l.address_line2 || '',
        City: l.city || '',
        'State / parish': l.region || '',
        'Postal code': l.postal_code || '',
        Country: l.country || '',
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

    // Preview what closing would pay, using the same path the close itself
    // takes — the lead's own snapshot, with the product layered in. Showing a
    // number here that a real close would not produce is worse than showing
    // nothing, so this deliberately reuses termsForLead rather than
    // recalculating from the live rank.
    const terms = await commissions.termsForLead(lead);
    const preview = terms ? commissions.calculate(terms, 'initial') : null;
    const productList = await products.list(lead.campaign_id);
    const basis = products.basisFor(lead, terms);

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
      terms,
      preview,
      basis,
      productList,
      emailTemplates,
      timezones: tz.COMMON_TIMEZONES,
      reopenStatuses: util.LEAD_STATUSES.filter((s) => !s.value.startsWith('closed')),
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

    // Moving out of "closed / won" is not a status change, it is an undo of a
    // payment. Sending it through this route would leave the commission behind
    // and wipe the account dates, so it has a route of its own that asks why
    // and deals with the money.
    if (lead.status === 'closed_won') {
      req.flash('error', 'This lead is closed as won and has a commission against it. Use Reopen, which handles the commission properly.');
      return res.redirect(`/admin/leads/${lead.id}#reopen`);
    }

    const closing = status === 'closed_won' || status === 'closed_lost';

    // Which product was actually sold. Only asked for on a winning close, and
    // only when the campaign has more than the one thing to sell.
    let product = null;
    if (status === 'closed_won') {
      const chosen = util.text(req.body.product_id);
      if (chosen) {
        product = await products.forCampaign(chosen, lead.campaign_id);
        if (!product) {
          req.flash('error', 'That product does not belong to this campaign.');
          return res.redirect(`/admin/leads/${lead.id}`);
        }
      } else {
        const available = await products.list(lead.campaign_id);
        if (available.length) {
          req.flash('error', 'Choose which product this deal was for — it decides what the commission is calculated from.');
          return res.redirect(`/admin/leads/${lead.id}`);
        }
      }
    }

    const updated = await db.one(
      // $2 is bound as TEXT and cast to the enum where it is assigned.
      //
      // Without the cast Postgres deduces $2 two different ways in one
      // statement -- lead_status from `status = $2`, text from `$2 =
      // 'closed_won'` -- and refuses the whole query with "inconsistent types
      // deduced for parameter $2". Comparing the text form is what makes both
      // readings agree.
      `update leads set status = $2::lead_status,
              closed_at = case when $3::boolean then now() else null end,
              account_active = case when $2 = 'closed_won' then account_active else false end,
              account_started_on = case when $2 = 'closed_won' then account_started_on else null end,
              last_contacted_at = case when $2 = 'contacted' then now() else last_contacted_at end,
              -- Copied, not just referenced: repricing a product next quarter
              -- must not reprice a deal that closed this one.
              product_id    = coalesce($4::uuid, product_id),
              product_name  = coalesce($5::text, product_name),
              product_value = coalesce($6::numeric, product_value)
        where id = $1::uuid returning *`,
      [
        lead.id, status, closing,
        product ? product.id : null,
        product ? product.name : null,
        product ? product.value : null,
      ]
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
            rank: result.terms.profile_name || null,
            product: updated.product_name || null,
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

/**
 * Reopen a lead that was closed by mistake.
 *
 * Its own action rather than a value in the status dropdown, because closing is
 * the click that creates money and undoing it has to deal with the money. The
 * dropdown version left the commission sitting there and wiped the account
 * dates on the way past — so a mis-click cost you the account start date
 * permanently and left a commission attached to a lead that was no longer won.
 *
 * A reason is required. Not bureaucracy: this is the one action in the system
 * that reverses a payment, and six months later "why is there a minus entry on
 * my statement" is a question somebody will ask.
 */
router.post('/leads/:id/reopen', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    if (lead.status !== 'closed_won' && lead.status !== 'closed_lost') {
      req.flash('error', 'That lead is not closed.');
      return res.redirect(`/admin/leads/${lead.id}`);
    }

    const reason = util.text(req.body.reason, 300);
    if (!reason) {
      req.flash('error', 'Say why it is being reopened — it goes on the record beside any commission this reverses.');
      return res.redirect(`/admin/leads/${lead.id}#reopen`);
    }

    const backTo = util.LEAD_STATUSES.some((s) => s.value === req.body.status && !s.value.startsWith('closed'))
      ? req.body.status
      : 'appointment_set';

    const money = await commissions.unwindForLead(req.tenant.id, lead.id, {
      reason,
      actorName: req.user.full_name || req.user.email,
    });

    const updated = await db.one(
      `update leads set
         status = $2,
         closed_at = null,
         account_active = false,
         -- Remember the start date rather than discarding it. If this reopen is
         -- itself corrected in a minute, the original date is still here.
         prior_account_started_on = coalesce(account_started_on, prior_account_started_on),
         account_started_on = null,
         reopened_at = now(),
         reopened_reason = $3
       where id = $1 returning *`,
      [lead.id, backTo, reason]
    );

    const parts = [];
    if (money.voided.length) parts.push(`${money.voided.length} unpaid commission${money.voided.length === 1 ? '' : 's'} voided`);
    if (money.reversed.length) {
      const total = money.reversed.reduce((sum, r) => sum + Math.abs(Number(r.amount) || 0), 0);
      parts.push(`${util.money(total, money.reversed[0].currency)} of paid commission reversed`);
    }

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,'status_change',$5)`,
      [
        req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email,
        `Reopened from ${util.statusMeta(lead.status).label} to ${util.statusMeta(backTo).label}. `
        + `Reason: ${reason}${parts.length ? `. ${parts.join('; ')}.` : '.'}`,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.reopened',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email} reopened from ${lead.status}${parts.length ? ` — ${parts.join('; ')}` : ''}`,
      before: {
        status: lead.status,
        account_started_on: lead.account_started_on,
        account_active: lead.account_active,
      },
      after: {
        status: backTo,
        reason,
        voided: money.voided.length,
        reversed: money.reversed.length,
      },
    });

    req.flash('success', parts.length
      ? `Reopened. ${parts.join('; ')}. Both sides stay on the record.`
      : 'Reopened. There was no commission to undo.');

    return res.redirect(`/admin/leads/${updated.id}`);
  } catch (err) {
    return next(err);
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

/**
 * Set, move or clear a lead's appointment.
 *
 * Times are entered in the PROSPECT'S timezone, not the admin's. That is the
 * zone the prospect chose, the zone their confirmation email quotes, and the
 * zone they will actually be sitting in when the phone rings. An admin in
 * Kingston booking a prospect in London who types "2pm" means 2pm for the
 * prospect — anything else invites a call at the wrong hour, and the mistake is
 * invisible until nobody answers.
 *
 * The same selector doubles as the fix for a prospect who picked the wrong zone
 * on the form, because that mistake makes every displayed time wrong and there
 * was previously no way to correct it.
 */
router.post('/leads/:id/appointment', async (req, res, next) => {
  try {
    const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!lead) return next();

    const zone = tz.safeZone(req.body.timezone, lead.timezone);
    const back = `/admin/leads/${lead.id}#appointment`;

    // Clearing is an explicit choice, not an accident of leaving fields blank.
    if (util.bool(req.body.clear)) {
      const cleared = await db.one(
        `update leads set appointment_primary_at = null, appointment_backup_at = null,
                confirmed_slot = null
          where id = $1 returning *`,
        [lead.id]
      );
      await db.query('delete from reminder_sends where lead_id = $1', [lead.id]);

      await audit.log({
        tenantId: req.tenant.id, req,
        action: 'lead.appointment_changed',
        entityType: 'lead',
        entityId: lead.id,
        summary: `Cleared the appointment for ${lead.email}`,
        before: {
          appointment_primary_at: lead.appointment_primary_at,
          appointment_backup_at: lead.appointment_backup_at,
        },
        after: { appointment_primary_at: null, appointment_backup_at: null },
      });

      req.flash('success', 'Appointment cleared. No reminders will be sent.');
      return res.redirect(back);
    }

    const primaryAt = tz.localInputToDate(req.body.primary_date, req.body.primary_time, zone);
    const backupAt = tz.localInputToDate(req.body.backup_date, req.body.backup_time, zone);

    const errors = [];
    if (req.body.primary_date && !req.body.primary_time) errors.push('The primary appointment needs a time as well as a date.');
    if (req.body.primary_time && !req.body.primary_date) errors.push('The primary appointment needs a date as well as a time.');
    if (req.body.backup_date && !req.body.backup_time) errors.push('The backup appointment needs a time as well as a date.');
    if (req.body.backup_time && !req.body.backup_date) errors.push('The backup appointment needs a date as well as a time.');
    if (backupAt && !primaryAt) errors.push('Set a primary time before a backup one.');
    if (primaryAt && backupAt && primaryAt.getTime() === backupAt.getTime()) {
      errors.push('The backup time is the same as the primary one — a backup is only useful if it differs.');
    }

    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect(back);
    }

    const slot = req.body.confirmed_slot === 'backup' ? 'backup'
      : (req.body.confirmed_slot === 'primary' ? 'primary' : null);

    const moved = String(lead.appointment_primary_at || '') !== String(primaryAt || '')
      || String(lead.appointment_backup_at || '') !== String(backupAt || '');

    const updated = await db.one(
      `update leads set
         timezone = $2,
         appointment_primary_at = $3,
         appointment_backup_at  = $4,
         -- A confirmed slot that no longer has a time behind it is worse than
         -- none: reminders would follow a booking that does not exist.
         confirmed_slot = case
           when $5::appointment_slot = 'backup'  and $4::timestamptz is null then null
           when $5::appointment_slot = 'primary' and $3::timestamptz is null then null
           else $5::appointment_slot end,
         status = case
           when status = 'new' and $3::timestamptz is not null then 'appointment_set'::lead_status
           else status end
       where id = $1::uuid
       returning *`,
      [lead.id, zone, primaryAt, backupAt, slot]
    );

    // Reminders already sent are recorded so they are not sent twice. When the
    // time moves, that record is about a different appointment — clear it, or
    // the "1 hour before" nudge for the new time never fires because the old
    // one is marked done.
    if (moved) await db.query('delete from reminder_sends where lead_id = $1', [lead.id]);

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,'status_change',$5)`,
      [
        req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email,
        primaryAt
          ? `Appointment set by ${req.user.full_name || req.user.email}.\n`
            + `Primary: ${tz.fmtDual(primaryAt, zone)}\n`
            + `Backup: ${backupAt ? tz.fmtDual(backupAt, zone) : 'none'}`
          : 'Appointment times removed.',
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'lead.appointment_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: primaryAt
        ? `Appointment for ${lead.email} set to ${tz.fmt(primaryAt, zone)}`
        : `Appointment times removed for ${lead.email}`,
      before: {
        appointment_primary_at: lead.appointment_primary_at,
        appointment_backup_at: lead.appointment_backup_at,
        confirmed_slot: lead.confirmed_slot,
        timezone: lead.timezone,
      },
      after: {
        appointment_primary_at: primaryAt,
        appointment_backup_at: backupAt,
        confirmed_slot: updated.confirmed_slot,
        timezone: zone,
      },
    });

    // Telling the prospect is opt-in. Correcting a typo in a backup time does
    // not warrant an email; moving the call they are expecting does.
    let told = false;
    if (util.bool(req.body.notify) && primaryAt) {
      const [campaign, agent] = await Promise.all([
        db.one('select * from campaigns where id = $1', [lead.campaign_id]),
        lead.agent_id ? db.one('select * from profiles where id = $1', [lead.agent_id]) : null,
      ]);
      const event = lead.appointment_primary_at ? 'appointment_rescheduled' : 'appointment_set';
      notify.fire(event, { tenantId: req.tenant.id, lead: updated, agent, campaign })
        .catch((e) => console.error(`[notify] ${event} failed:`, e.message));
      told = true;
    }

    req.flash('success', primaryAt
      ? `Appointment set for ${tz.fmt(primaryAt, zone)}${told ? ' and the prospect has been told.' : '.'}`
      : 'Appointment times removed.');

    return res.redirect(back);
  } catch (err) {
    return next(err);
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
