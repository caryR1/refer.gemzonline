'use strict';

/**
 * First-run setup data, and the code that installs it.
 *
 * Shared by `npm run db:seed` and the one-click "Install defaults" action in
 * Admin -> Settings, so a host with no terminal can still get set up. Every
 * install is idempotent: nothing already present is touched, so pressing the
 * button twice is harmless and pressing it after deleting a template restores
 * that template alone.
 */

const db = require('./db');
const relations = require('./relations');

const CAMPAIGN = {
  name: 'Business Automation Starter',
  slug: 'automation-starter',
  client_name: 'GemzOnline',
  description: 'Introductory automation package for small service businesses.',
  headline: 'Put your busywork on autopilot',
  hero_subtext: 'A short call, a clear plan, and the repetitive parts of your business running themselves.',
  cta_label: 'Book my free consult',
  landing_page_url: '',
  thank_you_message: 'You are all set. Watch your inbox for a confirmation with your appointment times.',
  consent_text: 'I confirm the details above are accurate and I consent to be contacted by phone and email about this enquiry. I understand I can withdraw my consent at any time.',
  custom_fields: [
    { key: 'business_type', label: 'What kind of business do you run?', type: 'text', required: true },
    { key: 'team_size', label: 'How many people are on your team?', type: 'select', required: false, options: ['Just me', '2-5', '6-20', '21-50', '50+'] },
    { key: 'biggest_bottleneck', label: 'What is eating the most time right now?', type: 'textarea', required: false, help: 'One or two sentences is plenty.' },
  ],
};

const RANKS = [
  {
    name: 'Standard', description: 'Everyone starts here.', is_default: true, rank_order: 10,
    initial_type: 'percentage', initial_value: 10,
    recurring_enabled: false, recurring_type: 'percentage', recurring_value: 0, recurring_months: null,
    payout_day: 15, deal_value: 1500,
  },
  {
    name: 'Senior', description: 'For agents with six or more closed deals.', is_default: false, rank_order: 20,
    initial_type: 'percentage', initial_value: 15,
    recurring_enabled: true, recurring_type: 'percentage', recurring_value: 5, recurring_months: 12,
    payout_day: 15, deal_value: 1500,
  },
];

const TEMPLATES = [
  {
    channel: 'email', slug: 'lead-welcome', name: 'Lead — welcome & acknowledge',
    trigger_event: 'welcome', send_to: 'lead',
    subject: 'Thanks {{lead.first_name}} — one quick step to confirm',
    body_html: `<h2>Thanks for reaching out, {{lead.first_name}}</h2>
<p>We have your details for <strong>{{campaign.name}}</strong>. Your reference is <strong>{{lead.reference}}</strong>.</p>
<p>To lock in your appointment, confirm your details and preferred times:</p>
<p><a class="button" href="{{lead.acknowledge_url}}">Confirm my details</a></p>
<p class="muted">If the button does not work, paste this into your browser:<br>{{lead.acknowledge_url}}</p>
<p>Talk soon,<br>{{campaign.client_name}}</p>`,
  },
  {
    channel: 'email', slug: 'lead-consent-receipt', name: 'Lead — acknowledgement received',
    trigger_event: 'consent_given', send_to: 'lead',
    subject: 'We have your confirmation, {{lead.first_name}}',
    body_html: `<h2>Confirmation received</h2>
<p>Thanks {{lead.first_name}} — your acknowledgement for <strong>{{campaign.name}}</strong> is on file (reference {{lead.reference}}).</p>
<table class="data">
  <tr><th>Primary time</th><td>{{lead.appointment_primary}}</td></tr>
  <tr><th>Backup time</th><td>{{lead.appointment_backup}}</td></tr>
</table>
<p>Need to change either one? <a href="{{lead.manage_url}}">Edit your appointment</a> at any time.</p>`,
  },
  {
    channel: 'email', slug: 'lead-appointment-confirmed', name: 'Lead — appointment set',
    trigger_event: 'appointment_set', send_to: 'lead',
    subject: 'Your appointment is confirmed — {{campaign.name}}',
    body_html: `<h2>You are booked in, {{lead.first_name}}</h2>
<p>Your local time comes first; Jamaica time is in brackets.</p>
<table class="data">
  <tr><th>Primary</th><td>{{lead.appointment_primary}}</td></tr>
  <tr><th>Backup</th><td>{{lead.appointment_backup}}</td></tr>
</table>
<p>Reference: <strong>{{lead.reference}}</strong></p>
<p><a class="button" href="{{lead.manage_url}}">Edit or cancel</a></p>`,
  },
  {
    channel: 'email', slug: 'lead-rescheduled', name: 'Lead — rescheduled',
    trigger_event: 'appointment_rescheduled', send_to: 'lead',
    subject: 'Your new time is confirmed',
    body_html: `<h2>All changed, {{lead.first_name}}</h2>
<table class="data">
  <tr><th>Primary</th><td>{{lead.appointment_primary}}</td></tr>
  <tr><th>Backup</th><td>{{lead.appointment_backup}}</td></tr>
</table>
<p><a class="button" href="{{lead.manage_url}}">Change it again</a></p>`,
  },
  {
    channel: 'email', slug: 'lead-reminder', name: 'Lead — appointment reminder',
    trigger_event: 'appointment_reminder', send_to: 'lead',
    subject: 'Reminder: your {{campaign.name}} appointment',
    body_html: `<h2>A quick reminder, {{lead.first_name}}</h2>
<p>Your appointment is coming up:</p>
<table class="data">
  <tr><th>When</th><td>{{lead.appointment_confirmed}}</td></tr>
  <tr><th>Reference</th><td>{{lead.reference}}</td></tr>
</table>
<p>If the time no longer works, <a href="{{lead.manage_url}}">change or cancel it here</a>.</p>`,
  },
  {
    channel: 'email', slug: 'agent-new-lead', name: 'Agent — new lead',
    trigger_event: 'lead_created', send_to: 'agent',
    subject: 'New lead: {{lead.full_name}} ({{campaign.name}})',
    body_html: `<h2>New lead from your referral link</h2>
<table class="data">
  <tr><th>Name</th><td>{{lead.full_name}}</td></tr>
  <tr><th>Email</th><td>{{lead.email}}</td></tr>
  <tr><th>Phone</th><td>{{lead.phone}}</td></tr>
  <tr><th>Campaign</th><td>{{campaign.name}}</td></tr>
  <tr><th>Reference</th><td>{{lead.reference}}</td></tr>
</table>
<p>Set how you know them on the lead — whoever calls will open with it.</p>
<p><a class="button" href="{{app.url}}/agent/leads">Open my pipeline</a></p>`,
  },
  {
    channel: 'email', slug: 'agent-appointment-set', name: 'Agent — appointment set',
    trigger_event: 'appointment_set', send_to: 'agent',
    subject: '{{lead.full_name}} booked a time',
    body_html: `<h2>{{lead.full_name}} picked a time</h2>
<table class="data">
  <tr><th>Primary</th><td>{{lead.appointment_primary}}</td></tr>
  <tr><th>Backup</th><td>{{lead.appointment_backup}}</td></tr>
  <tr><th>Relation</th><td>{{lead.relation}}</td></tr>
</table>
<p><a class="button" href="{{app.url}}/agent/leads">Open my pipeline</a></p>`,
  },
  {
    channel: 'email', slug: 'agent-cancelled', name: 'Agent — prospect cancelled',
    trigger_event: 'prospect_cancelled', send_to: 'agent',
    subject: '{{lead.full_name}} cancelled',
    body_html: `<h2>{{lead.full_name}} cancelled their appointment</h2>
<p>They cancelled from their own link, so the lead is now closed as lost and no further automated messages will go to them.</p>
<table class="data">
  <tr><th>Campaign</th><td>{{campaign.name}}</td></tr>
  <tr><th>Reference</th><td>{{lead.reference}}</td></tr>
</table>`,
  },
  {
    channel: 'email', slug: 'agent-lead-won', name: 'Agent — closed won',
    trigger_event: 'closed_won', send_to: 'agent',
    subject: 'Commission earned: {{lead.full_name}}',
    body_html: `<h2>Nice work, {{agent.first_name}}</h2>
<p><strong>{{lead.full_name}}</strong> on {{campaign.name}} has been closed as won. Your commission is recorded and pending approval.</p>
<p><a class="button" href="{{app.url}}/agent/earnings">View my earnings</a></p>`,
  },
  {
    channel: 'email', slug: 'agent-commission-approved', name: 'Agent — commission approved',
    trigger_event: 'commission_approved', send_to: 'agent',
    subject: 'Your {{commission.amount}} commission is approved',
    body_html: `<h2>Approved</h2>
<table class="data">
  <tr><th>Amount</th><td>{{commission.amount}}</td></tr>
  <tr><th>Period</th><td>{{commission.period}}</td></tr>
  <tr><th>Payout date</th><td>{{commission.payout_date}}</td></tr>
</table>
<p><a class="button" href="{{app.url}}/agent/earnings">View my earnings</a></p>`,
  },
  {
    channel: 'email', slug: 'agent-commission-paid', name: 'Agent — commission paid',
    trigger_event: 'commission_paid', send_to: 'agent',
    subject: 'Paid: {{commission.amount}}',
    body_html: `<h2>Payment recorded</h2>
<p>{{commission.amount}} for {{commission.period}} has been marked paid.</p>
<p><a class="button" href="{{app.url}}/agent/earnings">View my earnings</a></p>`,
  },
  {
    channel: 'email', slug: 'agent-account-dropped', name: 'Agent — recurring account cancelled',
    trigger_event: 'account_dropped', send_to: 'agent',
    subject: 'Recurring account cancelled: {{lead.full_name}}',
    body_html: `<h2>A recurring account has cancelled</h2>
<p><strong>{{lead.full_name}}</strong> on {{campaign.name}} is no longer active, so no further recurring commission will accrue.</p>
<p>Anything already earned is unaffected.</p>`,
  },
  {
    channel: 'email', slug: 'agent-reminder', name: 'Agent — appointment reminder',
    trigger_event: 'appointment_reminder', send_to: 'agent',
    subject: 'Coming up: {{lead.full_name}}',
    body_html: `<h2>Appointment coming up</h2>
<table class="data">
  <tr><th>Who</th><td>{{lead.full_name}}</td></tr>
  <tr><th>When</th><td>{{lead.appointment_confirmed}}</td></tr>
  <tr><th>Phone</th><td>{{lead.phone}}</td></tr>
  <tr><th>Relation</th><td>{{lead.relation}}</td></tr>
</table>
<p><a class="button" href="{{app.url}}/agent/leads">Open my pipeline</a></p>`,
  },
  {
    channel: 'email', slug: 'admin-new-lead', name: 'Admin — new lead',
    trigger_event: 'lead_created', send_to: 'admin',
    subject: '[{{campaign.name}}] New lead — {{lead.full_name}}',
    body_html: `<h2>New lead captured</h2>
<table class="data">
  <tr><th>Name</th><td>{{lead.full_name}}</td></tr>
  <tr><th>Email</th><td>{{lead.email}}</td></tr>
  <tr><th>Phone</th><td>{{lead.phone}}</td></tr>
  <tr><th>Campaign</th><td>{{campaign.name}}</td></tr>
  <tr><th>Agent</th><td>{{agent.full_name}}</td></tr>
</table>
<p><a class="button" href="{{app.url}}/admin/leads">Open the console</a></p>`,
  },
  {
    channel: 'email', slug: 'admin-cancelled', name: 'Admin — prospect cancelled',
    trigger_event: 'prospect_cancelled', send_to: 'admin',
    subject: '[{{campaign.name}}] {{lead.full_name}} cancelled',
    body_html: `<h2>Prospect cancelled</h2>
<table class="data">
  <tr><th>Name</th><td>{{lead.full_name}}</td></tr>
  <tr><th>Campaign</th><td>{{campaign.name}}</td></tr>
  <tr><th>Agent</th><td>{{agent.full_name}}</td></tr>
  <tr><th>Reference</th><td>{{lead.reference}}</td></tr>
</table>
<p>The lead has been closed as lost and further automated email to them is suppressed.</p>`,
  },
];

/**
 * What is present and what is missing. Drives the Settings screen so an
 * operator can see the state before pressing anything.
 */
async function status(tenantId) {
  const [rel, tpls, campaigns] = await Promise.all([
    db.one('select count(*)::int as n from relation_options where tenant_id = $1', [tenantId]),
    db.one('select count(*)::int as n from notification_templates where tenant_id = $1', [tenantId]),
    db.one('select count(*)::int as n from campaigns where tenant_id = $1', [tenantId]),
  ]);

  return {
    relations: { installed: rel.n, expected: relations.DEFAULTS.length },
    templates: { installed: tpls.n, expected: TEMPLATES.length },
    campaigns: { installed: campaigns.n },
    needsSetup: rel.n === 0 || tpls.n === 0,
  };
}

/** Install the default relationship options. Returns how many were added. */
async function installRelations(tenantId) {
  const before = await db.one('select count(*)::int as n from relation_options where tenant_id = $1', [tenantId]);
  await relations.seedDefaults(tenantId);
  const after = await db.one('select count(*)::int as n from relation_options where tenant_id = $1', [tenantId]);
  return after.n - before.n;
}

/** Install any missing default templates. Existing ones are left alone. */
async function installTemplates(tenantId) {
  let added = 0;
  for (const tpl of TEMPLATES) {
    const row = await db.one(
      `insert into notification_templates
        (tenant_id, channel, name, slug, trigger_event, send_to, subject, body_html, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,true)
       on conflict (tenant_id, slug) do nothing
       returning id`,
      [tenantId, tpl.channel, tpl.name, tpl.slug, tpl.trigger_event, tpl.send_to, tpl.subject, tpl.body_html]
    );
    if (row) added += 1;
  }
  return added;
}

/**
 * Install the sample campaign, its two ranks and three reminder slots.
 * Optional — most installs will delete it once a real campaign exists.
 */
async function installSampleCampaign(tenantId) {
  const existing = await db.one('select * from campaigns where tenant_id = $1 and slug = $2', [tenantId, CAMPAIGN.slug]);
  if (existing) return { campaign: existing, created: false };

  const campaign = await db.one(
    `insert into campaigns
      (tenant_id, name, slug, client_name, description, headline, hero_subtext,
       cta_label, landing_page_url, thank_you_message, consent_text, custom_fields)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      tenantId, CAMPAIGN.name, CAMPAIGN.slug, CAMPAIGN.client_name, CAMPAIGN.description,
      CAMPAIGN.headline, CAMPAIGN.hero_subtext, CAMPAIGN.cta_label, CAMPAIGN.landing_page_url,
      CAMPAIGN.thank_you_message, CAMPAIGN.consent_text, JSON.stringify(CAMPAIGN.custom_fields),
    ]
  );

  for (const rank of RANKS) {
    await db.query(
      `insert into commission_profiles
        (tenant_id, campaign_id, name, description, is_default, rank_order,
         initial_type, initial_value, recurring_enabled, recurring_type,
         recurring_value, recurring_months, payout_day, deal_value, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict do nothing`,
      [
        tenantId, campaign.id, rank.name, rank.description, rank.is_default, rank.rank_order,
        rank.initial_type, rank.initial_value, rank.recurring_enabled, rank.recurring_type,
        rank.recurring_value, rank.recurring_months, rank.payout_day, rank.deal_value,
        campaign.currency,
      ]
    );
  }

  const slots = [
    { slot: 1, offset_value: 2, offset_unit: 'days' },
    { slot: 2, offset_value: 1, offset_unit: 'days' },
    { slot: 3, offset_value: 1, offset_unit: 'hours' },
  ];
  for (const s of slots) {
    await db.query(
      `insert into campaign_reminders (tenant_id, campaign_id, slot, offset_value, offset_unit)
       values ($1,$2,$3,$4,$5) on conflict (campaign_id, slot) do nothing`,
      [tenantId, campaign.id, s.slot, s.offset_value, s.offset_unit]
    );
  }

  return { campaign, created: true };
}

/** Everything, in one call. */
async function installAll(tenantId, { sampleCampaign = false } = {}) {
  const result = {
    relations: await installRelations(tenantId),
    templates: await installTemplates(tenantId),
    campaign: null,
  };

  await db.query(
    `insert into settings (tenant_id, key, value) values ($1,'pipeline','{"stale_lead_days":14}'::jsonb)
     on conflict (tenant_id, key) do nothing`,
    [tenantId]
  );

  if (sampleCampaign) {
    const r = await installSampleCampaign(tenantId);
    result.campaign = r.created ? r.campaign.name : null;
  }

  return result;
}

module.exports = {
  CAMPAIGN, RANKS, TEMPLATES,
  status, installRelations, installTemplates, installSampleCampaign, installAll,
};
