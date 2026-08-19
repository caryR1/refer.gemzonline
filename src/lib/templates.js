'use strict';

/**
 * Template rendering for both channels.
 *
 * Email templates are HTML with `{{dotted.path}}` placeholders and are freely
 * editable. WhatsApp templates are references to Meta-approved template names;
 * this module resolves their ordered variable slots from the same context, so
 * both channels see identical data.
 */

const config = require('../config');
const tz = require('./tz');
const { escapeHtml, money } = require('./util');

/** Everything a template is allowed to reference. */
function buildContext({ lead, agent, campaign, commission, relationLabel, extra } = {}) {
  const prospectZone = tz.safeZone(lead && lead.timezone);

  const ctx = {
    app: {
      name: config.appName,
      url: config.appUrl,
      year: String(new Date().getFullYear()),
      support_email: config.smtp.fromEmail,
    },
    lead: {},
    agent: {},
    campaign: {},
    commission: {},
  };

  if (lead) {
    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
    const confirmed = lead.confirmed_slot === 'backup'
      ? lead.appointment_backup_at
      : lead.appointment_primary_at;

    ctx.lead = {
      id: lead.id || '',
      reference: lead.reference || '',
      first_name: lead.first_name || '',
      last_name: lead.last_name || '',
      full_name: fullName || lead.email || '',
      email: lead.email || '',
      phone: lead.phone || '',
      whatsapp_number: lead.whatsapp_number || '',
      company: lead.company || '',
      city: lead.city || '',
      country: lead.country || '',
      timezone: prospectZone,
      status: lead.status || '',
      relation: relationLabel || '',

      appointment_primary: tz.fmtDual(lead.appointment_primary_at, prospectZone) || 'Not set',
      appointment_backup: tz.fmtDual(lead.appointment_backup_at, prospectZone) || 'Not set',
      appointment_confirmed: tz.fmtDual(confirmed, prospectZone) || 'Not set',
      appointment_primary_local: tz.fmt(lead.appointment_primary_at, prospectZone) || 'Not set',
      appointment_primary_staff: tz.fmtStaff(lead.appointment_primary_at) || 'Not set',

      created_at: tz.fmtDual(lead.created_at, prospectZone),

      // Prospect self-service. Long random token, no expiry.
      manage_url: lead.access_token ? `${config.appUrl}/appointment/${lead.access_token}` : config.appUrl,
      acknowledge_url: lead.access_token ? `${config.appUrl}/acknowledge/${lead.access_token}` : config.appUrl,
    };

    Object.entries(lead.custom || {}).forEach(([key, value]) => {
      ctx.lead[`custom_${key}`] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    });
  }

  if (agent) {
    ctx.agent = {
      id: agent.id || '',
      full_name: agent.full_name || agent.email || '',
      first_name: (agent.full_name || '').split(' ')[0] || '',
      email: agent.email || '',
      phone: agent.phone || '',
      company: agent.company || '',
    };
  }

  if (campaign) {
    ctx.campaign = {
      id: campaign.id || '',
      name: campaign.name || '',
      slug: campaign.slug || '',
      client_name: campaign.client_name || campaign.name || '',
      description: campaign.description || '',
      landing_page_url: campaign.landing_page_url || '',
      url: campaign.slug ? `${config.appUrl}/r/${campaign.slug}` : config.appUrl,
    };
    // `program.*` kept as an alias so older templates keep working.
    ctx.program = ctx.campaign;
  }

  if (commission) {
    ctx.commission = {
      amount: money(commission.amount, commission.currency || 'USD'),
      kind: commission.kind || '',
      period: tz.periodLabel(commission.period),
      status: commission.status || '',
      payout_date: commission.payout_date ? tz.fmtDate(commission.payout_date) : 'To be confirmed',
    };
  }

  return Object.assign(ctx, extra || {});
}

function lookup(ctx, path) {
  return String(path).split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, ctx);
}

/**
 * Replace {{placeholders}}. Values are HTML-escaped; {{{triple}}} inserts raw.
 */
function render(template, ctx) {
  if (!template) return '';
  return String(template)
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (m, path) => {
      const v = lookup(ctx, path);
      return v === undefined || v === null ? '' : String(v);
    })
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path) => {
      const v = lookup(ctx, path);
      return v === undefined || v === null ? '' : escapeHtml(String(v));
    });
}

/** Plain (unescaped) resolution — used for WhatsApp variable slots. */
function renderPlain(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path) => {
    const v = lookup(ctx, path);
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Resolve a WhatsApp template's ordered variable slots.
 * `map` looks like { "body": ["lead.first_name", "campaign.name"] }
 */
function resolveWaVariables(map, ctx) {
  const body = (map && Array.isArray(map.body)) ? map.body : [];
  return body.map((path) => {
    const v = lookup(ctx, path);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Shown in the admin template editor sidebar. */
const VARIABLE_REFERENCE = [
  {
    group: 'Lead',
    vars: [
      'lead.first_name', 'lead.last_name', 'lead.full_name', 'lead.email',
      'lead.phone', 'lead.company', 'lead.city', 'lead.country',
      'lead.reference', 'lead.status', 'lead.relation', 'lead.timezone',
      'lead.created_at',
    ],
  },
  {
    group: 'Appointment',
    vars: [
      'lead.appointment_primary', 'lead.appointment_backup',
      'lead.appointment_confirmed', 'lead.appointment_primary_local',
      'lead.appointment_primary_staff', 'lead.manage_url', 'lead.acknowledge_url',
    ],
  },
  { group: 'Agent', vars: ['agent.full_name', 'agent.first_name', 'agent.email', 'agent.phone', 'agent.company'] },
  { group: 'Campaign', vars: ['campaign.name', 'campaign.client_name', 'campaign.description', 'campaign.url', 'campaign.landing_page_url'] },
  { group: 'Commission', vars: ['commission.amount', 'commission.kind', 'commission.period', 'commission.status', 'commission.payout_date'] },
  { group: 'App', vars: ['app.name', 'app.url', 'app.year', 'app.support_email'] },
];

// Navy / grey / white, matching the interface.
const NAVY = '#12244a';
const NAVY_DEEP = '#0b1830';
const INK = '#1f2733';
const MUTED = '#5b6675';
const LINE = '#e3e7ee';
const CANVAS = '#f4f6f9';

/** Wraps rendered body HTML in a responsive, email-client-safe shell. */
function wrap(bodyHtml, { title = '', preheader = '', headerImage = '' } = {}) {
  const banner = headerImage
    ? `<tr><td style="padding:0"><img src="${escapeHtml(headerImage)}" alt="" width="620" style="display:block;width:100%;max-width:620px;height:auto;border:0"></td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title || config.appName)}</title>
<style>
  body { margin:0; padding:0; background:${CANVAS}; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:${INK}; -webkit-font-smoothing:antialiased; }
  .wrap { width:100%; background:${CANVAS}; padding:24px 12px; }
  .card { max-width:620px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; box-shadow:0 2px 8px rgba(18,36,74,.08); }
  .head { background:${NAVY}; color:#ffffff; padding:20px 28px; font-size:17px; font-weight:600; letter-spacing:.2px; }
  .body { padding:28px; font-size:15px; line-height:1.62; }
  .body h2 { margin:0 0 14px; font-size:20px; color:${NAVY_DEEP}; font-weight:650; }
  .body h3 { margin:22px 0 10px; font-size:16px; color:${NAVY_DEEP}; }
  .body p { margin:0 0 14px; }
  .body a { color:${NAVY}; }
  .button { display:inline-block; background:${NAVY}; color:#ffffff !important; text-decoration:none; padding:13px 24px; border-radius:9px; font-weight:600; margin:6px 0 16px; }
  .button.ghost { background:#ffffff; color:${NAVY} !important; border:1.5px solid ${LINE}; }
  table.data { width:100%; border-collapse:collapse; margin:0 0 18px; }
  table.data th { text-align:left; padding:10px 12px; background:#f7f9fc; color:${MUTED}; font-size:13px; font-weight:600; width:38%; border-bottom:1px solid ${LINE}; }
  table.data td { padding:10px 12px; border-bottom:1px solid ${LINE}; font-size:14px; }
  .muted { color:${MUTED}; font-size:13px; }
  .rule { height:1px; background:${LINE}; border:0; margin:22px 0; }
  .foot { padding:18px 28px 26px; color:${MUTED}; font-size:12px; line-height:1.55; text-align:center; }
  .foot a { color:${NAVY}; }
  .preheader { display:none; font-size:1px; color:${CANVAS}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
  @media (max-width:620px) { .body { padding:22px 18px; } .head { padding:18px 18px; } }
</style>
</head>
<body>
  <span class="preheader">${escapeHtml(preheader)}</span>
  <div class="wrap">
    <table role="presentation" class="card" cellpadding="0" cellspacing="0" border="0" align="center">
      <tr><td class="head">${escapeHtml(config.appName)}</td></tr>
      ${banner}
      <tr><td class="body">${bodyHtml}</td></tr>
      <tr><td class="foot">
        Sent by ${escapeHtml(config.appName)} · <a href="${config.appUrl}">${escapeHtml(config.appUrl.replace(/^https?:\/\//, ''))}</a><br>
        &copy; ${new Date().getFullYear()} — appointment times show your local time first, Jamaica time in brackets.
      </td></tr>
    </table>
  </div>
</body>
</html>`;
}

/** Rough plain-text fallback so text-only clients get something readable. */
function toPlainText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h1|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  buildContext, render, renderPlain, resolveWaVariables,
  wrap, toPlainText, VARIABLE_REFERENCE,
};
