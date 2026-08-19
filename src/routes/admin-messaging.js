'use strict';

/** Admin: message templates (email + WhatsApp) and the notification log. */

const express = require('express');

const config = require('../config');
const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const events = require('../lib/events');
const mailer = require('../lib/mailer');
const whatsapp = require('../lib/whatsapp');
const templates = require('../lib/templates');

const router = express.Router();

/** A believable lead/agent/campaign so previews are not full of blanks. */
function sampleContext() {
  const soon = new Date(Date.now() + 1000 * 60 * 60 * 48);
  const later = new Date(Date.now() + 1000 * 60 * 60 * 72);
  return templates.buildContext({
    lead: {
      id: '00000000-0000-0000-0000-000000000000',
      access_token: 'sample-token-for-preview-only-000000000000',
      reference: 'GZ-4KQ7M2',
      first_name: 'Marcia', last_name: 'Bennett',
      email: 'marcia.bennett@example.com', phone: '+1 876 555 0142',
      company: 'Bennett Catering', city: 'Kingston', country: 'Jamaica',
      timezone: 'America/Jamaica', status: 'appointment_set',
      appointment_primary_at: soon, appointment_backup_at: later,
      created_at: new Date(), custom: {},
    },
    agent: {
      id: '00000000-0000-0000-0000-000000000001',
      full_name: 'Andre Clarke', email: 'andre@example.com', phone: '+1 876 555 0180',
    },
    campaign: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Business Automation Starter', slug: 'automation-starter',
      client_name: 'GemzOnline', description: 'Introductory automation package.',
      landing_page_url: 'https://gemzonline.com/automation',
    },
    commission: { amount: 225, currency: 'USD', kind: 'initial', period: tz.periodKey(), status: 'approved' },
    relationLabel: 'Sister',
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

router.get('/templates', async (req, res, next) => {
  try {
    const rows = await db.all(
      `select t.*, c.name as campaign_name
         from notification_templates t
         left join campaigns c on c.id = t.campaign_id
        where t.tenant_id = $1
        order by t.channel, t.trigger_event nulls last, t.name`,
      [req.tenant.id]
    );

    res.render('admin/templates', {
      title: 'Message templates',
      templates: rows,
      whatsappLive: config.whatsapp.configured,
      eventLabel: events.label,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/templates/new', async (req, res, next) => {
  try {
    const campaigns = await db.all('select id, name from campaigns where tenant_id = $1 order by name', [req.tenant.id]);
    res.render('admin/template-form', {
      title: 'New template',
      template: {
        channel: req.query.channel === 'whatsapp' ? 'whatsapp' : 'email',
        send_to: 'lead',
        active: true,
        wa_language: config.whatsapp.defaultLanguage,
        wa_variable_map: { body: [] },
      },
      campaigns,
      triggerOptions: events.triggerOptions(),
      variableReference: templates.VARIABLE_REFERENCE,
      isNew: true,
    });
  } catch (err) {
    next(err);
  }
});

function readTemplateBody(body) {
  let variableMap = { body: [] };
  const raw = util.text(body.wa_variables, 2000);
  if (raw) {
    variableMap = {
      body: raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    };
  }

  return {
    channel: body.channel === 'whatsapp' ? 'whatsapp' : 'email',
    name: util.text(body.name, 120),
    slug: util.slugify(body.slug || body.name, ''),
    campaign_id: util.text(body.campaign_id) || null,
    trigger_event: events.EVENT_KEYS.includes(body.trigger_event) ? body.trigger_event : null,
    send_to: ['lead', 'agent', 'admin'].includes(body.send_to) ? body.send_to : 'lead',
    active: util.bool(body.active),
    subject: util.text(body.subject, 300),
    body_html: String(body.body_html || '').slice(0, 60000),
    wa_template_name: util.text(body.wa_template_name, 120),
    wa_language: util.text(body.wa_language, 20) || config.whatsapp.defaultLanguage,
    wa_variable_map: variableMap,
  };
}

router.post('/templates', async (req, res, next) => {
  try {
    const data = readTemplateBody(req.body);
    if (!data.name) {
      req.flash('error', 'Give the template a name.');
      return res.redirect('/admin/templates/new');
    }
    if (!data.slug) data.slug = util.slugify(data.name, `template-${util.token(4)}`);

    const clash = await db.one('select 1 from notification_templates where tenant_id = $1 and slug = $2', [req.tenant.id, data.slug]);
    if (clash) data.slug = `${data.slug}-${util.token(4)}`;

    const row = await db.one(
      `insert into notification_templates
        (tenant_id, channel, name, slug, campaign_id, trigger_event, send_to, active,
         subject, body_html, wa_template_name, wa_language, wa_variable_map)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        req.tenant.id, data.channel, data.name, data.slug, data.campaign_id,
        data.trigger_event, data.send_to, data.active, data.subject, data.body_html,
        data.wa_template_name, data.wa_language, JSON.stringify(data.wa_variable_map),
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'template.created',
      entityType: 'notification_template',
      entityId: row.id,
      summary: `Created ${row.channel} template "${row.name}"`,
      after: { name: row.name, channel: row.channel, trigger_event: row.trigger_event },
    });

    req.flash('success', 'Template created.');
    return res.redirect(`/admin/templates/${row.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/templates/:id', async (req, res, next) => {
  try {
    const template = await db.one('select * from notification_templates where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!template) return next();

    const campaigns = await db.all('select id, name from campaigns where tenant_id = $1 order by name', [req.tenant.id]);

    res.render('admin/template-form', {
      title: template.name,
      template,
      campaigns,
      triggerOptions: events.triggerOptions(),
      variableReference: templates.VARIABLE_REFERENCE,
      isNew: false,
      whatsappLive: config.whatsapp.configured,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/templates/:id', async (req, res, next) => {
  try {
    const before = await db.one('select * from notification_templates where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!before) return next();

    const data = readTemplateBody(req.body);
    if (!data.name) {
      req.flash('error', 'The template needs a name.');
      return res.redirect(`/admin/templates/${before.id}`);
    }
    if (!data.slug) data.slug = before.slug;

    const after = await db.one(
      `update notification_templates set
         channel=$2, name=$3, slug=$4, campaign_id=$5, trigger_event=$6, send_to=$7,
         active=$8, subject=$9, body_html=$10, wa_template_name=$11, wa_language=$12,
         wa_variable_map=$13
       where id=$1 returning *`,
      [
        before.id, data.channel, data.name, data.slug, data.campaign_id,
        data.trigger_event, data.send_to, data.active, data.subject, data.body_html,
        data.wa_template_name, data.wa_language, JSON.stringify(data.wa_variable_map),
      ]
    );

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'template.updated',
      entityType: 'notification_template',
      entityId: before.id,
      summary: `Updated template "${after.name}"`,
      before, after,
    }, ['name', 'channel', 'trigger_event', 'send_to', 'active', 'subject', 'wa_template_name']);

    req.flash('success', 'Template saved.');
    return res.redirect(`/admin/templates/${before.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/templates/:id/delete', async (req, res, next) => {
  try {
    const template = await db.one('select * from notification_templates where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!template) return next();

    await db.query('delete from notification_templates where id = $1', [template.id]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'template.deleted',
      entityType: 'notification_template',
      entityId: template.id,
      summary: `Deleted template "${template.name}"`,
      before: { name: template.name, channel: template.channel },
    });

    req.flash('success', 'Template deleted.');
    return res.redirect('/admin/templates');
  } catch (err) {
    next(err);
  }
});

/** Live preview, rendered with believable sample data. */
router.get('/templates/:id/preview', async (req, res, next) => {
  try {
    const template = await db.one('select * from notification_templates where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!template) return next();

    const rendered = notify.preview(template, sampleContext());

    if (rendered.channel === 'whatsapp') {
      return res.render('admin/template-preview-wa', {
        title: `Preview · ${template.name}`,
        layout: 'layouts/bare',
        wide: true,
        template,
        rendered,
      });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(rendered.html);
  } catch (err) {
    next(err);
  }
});

/** Send a template to a chosen address, for a real lead or with sample data. */
router.post('/templates/:id/send', async (req, res, next) => {
  try {
    const template = await db.one('select * from notification_templates where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!template) return next();

    const to = util.text(req.body.to, 200);
    if (!to) {
      req.flash('error', 'Enter where it should go.');
      return res.redirect(`/admin/templates/${template.id}`);
    }

    let payload = {};
    const leadRef = util.text(req.body.lead_reference, 40);
    if (leadRef) {
      const lead = await db.one('select * from leads where tenant_id = $1 and reference = $2', [req.tenant.id, leadRef]);
      if (!lead) {
        req.flash('error', `No lead with reference ${leadRef}.`);
        return res.redirect(`/admin/templates/${template.id}`);
      }
      payload = {
        lead,
        campaign: await db.one('select * from campaigns where id = $1', [lead.campaign_id]),
        agent: lead.agent_id ? await db.one('select * from profiles where id = $1', [lead.agent_id]) : null,
      };
    }

    const result = await notify.sendManual(req.tenant.id, {
      slug: template.slug, to, payload, sentBy: req.user.id,
    });

    if (result.ok) req.flash('success', `Sent to ${to}.`);
    else req.flash('error', `Could not send: ${result.error}`);

    return res.redirect(`/admin/templates/${template.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Notification log
// ---------------------------------------------------------------------------

router.get('/notifications', async (req, res, next) => {
  try {
    const where = ['n.tenant_id = $1'];
    const params = [req.tenant.id];

    if (req.query.channel) { params.push(req.query.channel); where.push(`n.channel = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`n.status = $${params.length}`); }
    if (req.query.event) { params.push(req.query.event); where.push(`n.trigger_event = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(n.to_address ilike $${params.length} or n.subject ilike $${params.length})`);
    }

    const clause = where.join(' and ');
    const countRow = await db.one(`select count(*)::int as n from notification_log n where ${clause}`, params);
    const page = util.paginate(countRow.n, req.query.page, 50);

    params.push(page.perPage, page.offset);
    const rows = await db.all(
      `select n.*, l.reference from notification_log n
         left join leads l on l.id = n.lead_id
        where ${clause} order by n.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params
    );

    const [emailHealth, waHealth] = await Promise.all([mailer.verify(), whatsapp.verify()]);

    res.render('admin/notifications', {
      title: 'Notification log',
      rows, page,
      basePath: '/admin/notifications',
      eventOptions: events.EVENTS,
      emailHealth, waHealth,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/notifications/:id', async (req, res, next) => {
  try {
    const row = await db.one('select * from notification_log where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!row) return next();

    if (row.channel === 'email' && row.body) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(row.body);
    }

    return res.render('admin/notification-detail', {
      title: 'Message',
      layout: 'layouts/bare',
      wide: true,
      row,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
