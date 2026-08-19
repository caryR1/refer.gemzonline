'use strict';

/**
 * Notification service.
 *
 * One entry point — `fire(eventKey, payload)` — resolves who should hear about
 * an event, on which channels, renders the right template per channel, sends,
 * and logs every attempt.
 *
 * PREFERENCE RESOLUTION (the rule agreed in the spec, §8.5):
 *
 *     admin_enabled = false  ->  HARD BLOCK. The user cannot re-enable it.
 *     admin_enabled = true   ->  a default; user_enabled = false mutes it.
 *
 *     effective = admin_enabled AND user_enabled
 *
 * Admin can suppress, but cannot compel. Prospects have no preference row —
 * they are governed by consent instead (`whatsapp_opt_in`, `suppress_email`).
 */

const db = require('./db');
const config = require('../config');
const mailer = require('./mailer');
const whatsapp = require('./whatsapp');
const templates = require('./templates');
const events = require('./events');
const { emailList } = require('./util');

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * Effective preference for one user / event / channel.
 * Missing row = on by default (admin_enabled true, user_enabled true).
 */
async function isEnabled(tenantId, userId, eventKey, channel) {
  if (!userId) return true;
  const row = await db.one(
    `select user_enabled, admin_enabled from notification_prefs
     where user_id = $1 and event_key = $2 and channel = $3`,
    [userId, eventKey, channel]
  );
  if (!row) return true;
  return row.admin_enabled && row.user_enabled;   // the asymmetric rule
}

/** Full preference matrix for a user, with defaults filled in. */
async function prefsFor(tenantId, userId) {
  const rows = await db.all(
    'select event_key, channel, user_enabled, admin_enabled from notification_prefs where user_id = $1',
    [userId]
  );
  const index = new Map(rows.map((r) => [`${r.event_key}:${r.channel}`, r]));

  return events.staffEvents().map((evt) => {
    const build = (channel) => {
      const row = index.get(`${evt.key}:${channel}`);
      const adminEnabled = row ? row.admin_enabled : true;
      const userEnabled = row ? row.user_enabled : true;
      return {
        channel,
        adminEnabled,
        userEnabled,
        effective: adminEnabled && userEnabled,
        blocked: !adminEnabled,        // renders the switch disabled
      };
    };
    return { event: evt, email: build('email'), whatsapp: build('whatsapp') };
  });
}

/** A user changing their own preference. Cannot touch a hard block. */
async function setUserPref(tenantId, userId, eventKey, channel, enabled) {
  const existing = await db.one(
    'select admin_enabled from notification_prefs where user_id = $1 and event_key = $2 and channel = $3',
    [userId, eventKey, channel]
  );
  if (existing && existing.admin_enabled === false) {
    return { ok: false, blocked: true };
  }
  await db.query(
    `insert into notification_prefs (tenant_id, user_id, event_key, channel, user_enabled, admin_enabled)
     values ($1,$2,$3,$4,$5,true)
     on conflict (user_id, event_key, channel)
     do update set user_enabled = excluded.user_enabled, updated_at = now()`,
    [tenantId, userId, eventKey, channel, Boolean(enabled)]
  );
  return { ok: true };
}

/** An admin setting another user's preference. Off here is a hard block. */
async function setAdminPref(tenantId, userId, eventKey, channel, enabled) {
  await db.query(
    `insert into notification_prefs (tenant_id, user_id, event_key, channel, user_enabled, admin_enabled)
     values ($1,$2,$3,$4,true,$5)
     on conflict (user_id, event_key, channel)
     do update set admin_enabled = excluded.admin_enabled, updated_at = now()`,
    [tenantId, userId, eventKey, channel, Boolean(enabled)]
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Template lookup
// ---------------------------------------------------------------------------

/**
 * Find the best template for an event: a campaign-specific one wins over a
 * global one, on the requested channel and recipient.
 */
async function findTemplate(tenantId, { channel, eventKey, campaignId, sendTo }) {
  return db.one(
    `select * from notification_templates
     where tenant_id = $1 and channel = $2 and trigger_event = $3
       and send_to = $4 and active
       and (campaign_id = $5 or campaign_id is null)
     order by (campaign_id is not null) desc, updated_at desc
     limit 1`,
    [tenantId, channel, eventKey, sendTo, campaignId || null]
  );
}

async function templateBySlug(tenantId, slug) {
  return db.one('select * from notification_templates where tenant_id = $1 and slug = $2', [tenantId, slug]);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function logSend(tenantId, entry) {
  try {
    await db.query(
      `insert into notification_log
        (tenant_id, channel, template_id, lead_id, agent_id, to_address, recipient,
         subject, body, trigger_event, reminder_slot, status, error,
         provider_message_id, sent_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        tenantId, entry.channel, entry.templateId || null, entry.leadId || null,
        entry.agentId || null, entry.to, entry.recipient || null,
        entry.subject || '', entry.body || null, entry.eventKey || null,
        entry.reminderSlot || null, entry.status, entry.error || null,
        entry.messageId || null, entry.sentBy || null,
      ]
    );
  } catch (err) {
    console.error('[notify] could not write notification_log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Render and send one email. */
async function sendEmail(tenantId, { template, ctx, to, leadId, agentId, recipient, eventKey, reminderSlot, sentBy, headerImage }) {
  if (!to) return { ok: false, skipped: true };

  const subject = templates.render(template.subject, ctx);
  const inner = templates.render(template.body_html, ctx);
  const html = templates.wrap(inner, {
    title: subject,
    preheader: templates.toPlainText(inner).slice(0, 140),
    headerImage,
  });

  const result = mailer.available()
    ? await mailer.send({ to, subject, html, text: templates.toPlainText(inner) })
    : { ok: false, error: 'SMTP is not configured.' };

  await logSend(tenantId, {
    channel: 'email',
    templateId: template.id,
    leadId, agentId, to, recipient, subject,
    body: html,
    eventKey, reminderSlot, sentBy,
    status: result.ok ? 'sent' : (mailer.available() ? 'failed' : 'skipped'),
    error: result.error,
    messageId: result.messageId,
  });

  return result;
}

/** Render and send one WhatsApp message. */
async function sendWhatsApp(tenantId, { template, ctx, to, leadId, agentId, recipient, eventKey, reminderSlot, sentBy }) {
  if (!to) return { ok: false, skipped: true };

  const variables = templates.resolveWaVariables(template.wa_variable_map, ctx);

  const result = await whatsapp.send({
    to,
    templateName: template.wa_template_name,
    language: template.wa_language,
    variables,
  });

  await logSend(tenantId, {
    channel: 'whatsapp',
    templateId: template.id,
    leadId, agentId, to, recipient,
    subject: template.wa_template_name || template.name,
    body: JSON.stringify({ template: template.wa_template_name, variables }),
    eventKey, reminderSlot, sentBy,
    status: result.ok ? 'sent' : (result.skipped ? 'skipped' : 'failed'),
    error: result.error,
    messageId: result.messageId,
  });

  return result;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Fire an event. Resolves recipients, checks preferences and consent, renders
 * per channel, sends, logs.
 *
 * @param {string} eventKey
 * @param {object} payload
 * @param {string} payload.tenantId
 * @param {object} [payload.lead]
 * @param {object} [payload.agent]
 * @param {object} [payload.campaign]
 * @param {object} [payload.commission]
 * @param {string} [payload.relationLabel]
 * @param {number} [payload.reminderSlot]
 * @param {string[]} [payload.channels]   restrict to these channels
 * @param {string[]} [payload.recipients] restrict to these recipient types
 * @param {string} [payload.sentBy]       profile id, for manual sends
 */
async function fire(eventKey, payload = {}) {
  const tenantId = payload.tenantId;
  if (!tenantId) throw new Error('notify.fire needs a tenantId');

  const evt = events.EVENT_MAP[eventKey];
  const allowedRecipients = payload.recipients || (evt ? evt.recipients : ['lead', 'agent', 'admin']);
  const allowedChannels = payload.channels || ['email', 'whatsapp'];

  const ctx = templates.buildContext(payload);
  const results = [];

  const campaignId = payload.campaign ? payload.campaign.id : null;
  const lead = payload.lead;
  const agent = payload.agent;

  // --- prospect -----------------------------------------------------------
  if (allowedRecipients.includes('lead') && lead) {
    if (allowedChannels.includes('email') && lead.email && !lead.suppress_email) {
      const tpl = await findTemplate(tenantId, { channel: 'email', eventKey, campaignId, sendTo: 'lead' });
      if (tpl) {
        results.push(await sendEmail(tenantId, {
          template: tpl, ctx, to: lead.email, leadId: lead.id,
          agentId: lead.agent_id, recipient: 'lead', eventKey,
          reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
          headerImage: payload.headerImage,
        }));
      }
    }
    // Prospects need an explicit opt-in before any WhatsApp message.
    if (allowedChannels.includes('whatsapp') && lead.whatsapp_opt_in && lead.whatsapp_number) {
      const tpl = await findTemplate(tenantId, { channel: 'whatsapp', eventKey, campaignId, sendTo: 'lead' });
      if (tpl) {
        results.push(await sendWhatsApp(tenantId, {
          template: tpl, ctx, to: lead.whatsapp_number, leadId: lead.id,
          agentId: lead.agent_id, recipient: 'lead', eventKey,
          reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
        }));
      }
    }
  }

  // --- assigned agent -----------------------------------------------------
  if (allowedRecipients.includes('agent') && agent && agent.id) {
    for (const channel of allowedChannels) {
      const enabled = await isEnabled(tenantId, agent.id, eventKey, channel);
      if (!enabled) continue;

      const tpl = await findTemplate(tenantId, { channel, eventKey, campaignId, sendTo: 'agent' });
      if (!tpl) continue;

      if (channel === 'email' && agent.email) {
        results.push(await sendEmail(tenantId, {
          template: tpl, ctx, to: agent.email, leadId: lead ? lead.id : null,
          agentId: agent.id, recipient: 'agent', eventKey,
          reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
        }));
      } else if (channel === 'whatsapp' && agent.whatsapp_number) {
        results.push(await sendWhatsApp(tenantId, {
          template: tpl, ctx, to: agent.whatsapp_number, leadId: lead ? lead.id : null,
          agentId: agent.id, recipient: 'agent', eventKey,
          reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
        }));
      }
    }
  }

  // --- admins -------------------------------------------------------------
  if (allowedRecipients.includes('admin')) {
    const admins = await db.all(
      "select * from profiles where tenant_id = $1 and role = 'admin' and status = 'active'",
      [tenantId]
    );

    // Campaign-specific extra recipients, plus the global alert address.
    const extraEmails = new Set([
      ...emailList(payload.campaign && payload.campaign.notify_emails),
      ...(payload.includeAlertEmail === false ? [] : emailList(config.smtp.adminAlertEmail)),
    ]);

    for (const admin of admins) {
      extraEmails.delete(admin.email);
      for (const channel of allowedChannels) {
        const enabled = await isEnabled(tenantId, admin.id, eventKey, channel);
        if (!enabled) continue;

        const tpl = await findTemplate(tenantId, { channel, eventKey, campaignId, sendTo: 'admin' });
        if (!tpl) continue;

        if (channel === 'email' && admin.email) {
          results.push(await sendEmail(tenantId, {
            template: tpl, ctx, to: admin.email, leadId: lead ? lead.id : null,
            agentId: admin.id, recipient: 'admin', eventKey,
            reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
          }));
        } else if (channel === 'whatsapp' && admin.whatsapp_number) {
          results.push(await sendWhatsApp(tenantId, {
            template: tpl, ctx, to: admin.whatsapp_number, leadId: lead ? lead.id : null,
            agentId: admin.id, recipient: 'admin', eventKey,
            reminderSlot: payload.reminderSlot, sentBy: payload.sentBy,
          }));
        }
      }
    }

    // Non-user addresses configured on the campaign get the email only.
    if (allowedChannels.includes('email') && extraEmails.size) {
      const tpl = await findTemplate(tenantId, { channel: 'email', eventKey, campaignId, sendTo: 'admin' });
      if (tpl) {
        for (const address of extraEmails) {
          results.push(await sendEmail(tenantId, {
            template: tpl, ctx, to: address, leadId: lead ? lead.id : null,
            recipient: 'admin', eventKey, reminderSlot: payload.reminderSlot,
            sentBy: payload.sentBy,
          }));
        }
      }
    }
  }

  return results;
}

/** Send one specific template by slug — used by the admin "send manually" action. */
async function sendManual(tenantId, { slug, to, payload, sentBy }) {
  const tpl = await templateBySlug(tenantId, slug);
  if (!tpl) return { ok: false, error: `No template with slug "${slug}".` };

  const ctx = templates.buildContext(payload || {});
  const lead = payload && payload.lead;

  if (tpl.channel === 'whatsapp') {
    return sendWhatsApp(tenantId, {
      template: tpl, ctx, to, leadId: lead ? lead.id : null,
      recipient: tpl.send_to, eventKey: tpl.trigger_event, sentBy,
    });
  }
  return sendEmail(tenantId, {
    template: tpl, ctx, to, leadId: lead ? lead.id : null,
    recipient: tpl.send_to, eventKey: tpl.trigger_event, sentBy,
  });
}

/** Render a template for the preview pane without sending anything. */
function preview(template, ctx) {
  if (template.channel === 'whatsapp') {
    return {
      channel: 'whatsapp',
      templateName: template.wa_template_name,
      variables: templates.resolveWaVariables(template.wa_variable_map, ctx),
    };
  }
  const subject = templates.render(template.subject, ctx);
  const inner = templates.render(template.body_html, ctx);
  return { channel: 'email', subject, html: templates.wrap(inner, { title: subject }) };
}

module.exports = {
  fire, sendManual, preview,
  isEnabled, prefsFor, setUserPref, setAdminPref,
  findTemplate, templateBySlug, logSend,
};
