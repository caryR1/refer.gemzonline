'use strict';

/** Admin: audit log, settings, own profile, diagnostics. */

const express = require('express');
const { stringify } = require('csv-stringify/sync');

const config = require('../config');
const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const audit = require('../lib/audit');
const mailer = require('../lib/mailer');
const whatsapp = require('../lib/whatsapp');
const relations = require('../lib/relations');

const router = express.Router();

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

router.get('/audit', async (req, res, next) => {
  try {
    const filters = {
      action: util.text(req.query.action, 80),
      entityType: util.text(req.query.entity, 40),
      actorId: util.text(req.query.actor, 40),
    };

    const total = await audit.count(req.tenant.id, filters);
    const page = util.paginate(total, req.query.page, 50);
    const entries = await audit.list(req.tenant.id, { ...filters, limit: page.perPage, offset: page.offset });

    const actors = await db.all(
      `select distinct p.id, p.full_name, p.email from audit_log a
         join profiles p on p.id = a.actor_id where a.tenant_id = $1 order by p.full_name`,
      [req.tenant.id]
    );

    res.render('admin/audit', {
      title: 'Audit log',
      entries, page, actors,
      actionLabel: audit.actionLabel,
      knownActions: Object.keys(audit.ACTION_LABELS),
      basePath: '/admin/audit',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit.csv', async (req, res, next) => {
  try {
    const entries = await audit.list(req.tenant.id, {
      action: util.text(req.query.action, 80),
      entityType: util.text(req.query.entity, 40),
      actorId: util.text(req.query.actor, 40),
      limit: 10000,
      offset: 0,
    });

    const csv = stringify(
      entries.map((e) => ({
        When: tz.fmtShort(e.created_at, req.user.timezone),
        Actor: e.actor_name || 'System',
        'Actor type': e.actor_type,
        Action: audit.actionLabel(e.action),
        Entity: e.entity_type,
        'Entity id': e.entity_id || '',
        Summary: e.summary || '',
        Before: e.before ? JSON.stringify(e.before) : '',
        After: e.after ? JSON.stringify(e.after) : '',
        IP: e.ip_address || '',
      })),
      { header: true }
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${tz.isoDate()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', async (req, res, next) => {
  try {
    const [relationOptions, settingRows, jobRuns] = await Promise.all([
      relations.list(req.tenant.id, { includeInactive: true }),
      db.all('select * from settings where tenant_id = $1', [req.tenant.id]),
      db.all('select * from job_runs order by created_at desc limit 15', []),
    ]);

    const [emailHealth, waHealth, dbHealth] = await Promise.all([
      mailer.verify(), whatsapp.verify(), db.healthcheck(),
    ]);

    res.render('admin/settings', {
      title: 'Settings',
      relationOptions,
      settings: Object.fromEntries(settingRows.map((r) => [r.key, r.value])),
      jobRuns,
      health: {
        email: emailHealth,
        whatsapp: waHealth,
        database: dbHealth,
        analytics: { ok: Boolean(config.analytics.ga4Id), id: config.analytics.ga4Id },
        google: { ok: config.supabase.googleEnabled },
      },
      problems: config.validate(),
      tenant: req.tenant,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/relations', async (req, res, next) => {
  try {
    const label = util.text(req.body.label, 80);
    if (!label) {
      req.flash('error', 'Give the relationship a label.');
      return res.redirect('/admin/settings#relations');
    }

    const code = util.slugify(req.body.code || label, `rel-${util.token(4)}`).replace(/-/g, '_');
    const sortOrder = util.num(req.body.sort_order, 999);

    await db.query(
      `insert into relation_options (tenant_id, code, label, sort_order)
       values ($1,$2,$3,$4)
       on conflict (tenant_id, code) do update set label = excluded.label, active = true`,
      [req.tenant.id, code, label, sortOrder]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'settings.relation_added',
      entityType: 'relation_option',
      summary: `Added relationship option "${label}"`,
      after: { code, label },
    });

    req.flash('success', `"${label}" added.`);
    return res.redirect('/admin/settings#relations');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/relations/:id/toggle', async (req, res, next) => {
  try {
    const option = await db.one('select * from relation_options where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!option) return next();

    await db.query('update relation_options set active = not active where id = $1', [option.id]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'settings.relation_toggled',
      entityType: 'relation_option',
      entityId: option.id,
      summary: `Relationship "${option.label}" ${option.active ? 'hidden' : 'restored'}`,
      before: { active: option.active }, after: { active: !option.active },
    });

    return res.redirect('/admin/settings#relations');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/seed-relations', async (req, res, next) => {
  try {
    await relations.seedDefaults(req.tenant.id);
    req.flash('success', 'Default relationship options restored.');
    return res.redirect('/admin/settings#relations');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Own profile
// ---------------------------------------------------------------------------

router.get('/profile', (req, res) => {
  res.render('admin/profile', {
    title: 'My profile',
    timezones: tz.COMMON_TIMEZONES,
    narrow: true,
  });
});

router.post('/profile', async (req, res, next) => {
  try {
    const before = req.user;
    const after = {
      full_name: util.text(req.body.full_name, 120) || before.full_name,
      phone: util.text(req.body.phone, 40),
      whatsapp_number: util.text(req.body.whatsapp_number, 40),
      timezone: tz.safeZone(req.body.timezone, before.timezone),
    };

    await db.query(
      'update profiles set full_name=$2, phone=$3, whatsapp_number=$4, timezone=$5 where id=$1',
      [before.id, after.full_name, after.phone, after.whatsapp_number, after.timezone]
    );

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'profile.updated',
      entityType: 'profile',
      entityId: before.id,
      summary: `${after.full_name} updated their profile`,
      before, after,
    }, ['full_name', 'phone', 'whatsapp_number', 'timezone']);

    req.flash('success', 'Profile saved.');
    return res.redirect('/admin/profile');
  } catch (err) {
    next(err);
  }
});

/** Send a test email to yourself, to prove SMTP works before you need it. */
router.post('/settings/test-email', async (req, res, next) => {
  try {
    const to = util.text(req.body.to, 200) || req.user.email;
    const result = await mailer.send({
      to,
      subject: `${config.appName} — test message`,
      html: `<p>This is a test from ${config.appName}.</p>
             <p>If you are reading it, your Hostinger SMTP settings are correct.</p>
             <p style="color:#5b6675;font-size:13px">Sent ${tz.fmtStaff(new Date())}</p>`,
      text: 'Test message. If you are reading this, SMTP is working.',
    });

    if (result.ok) req.flash('success', `Test email sent to ${to}.`);
    else req.flash('error', `Could not send: ${result.error}`);

    return res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
