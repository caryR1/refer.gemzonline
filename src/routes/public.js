'use strict';

/**
 * The public funnel and the prospect's self-service appointment page.
 *
 * Nothing here requires a login. The prospect's identity is carried by a long
 * random token in the URL — unguessable, no expiry, which is the standard for
 * appointment links people dig out of an old email.
 *
 * Google Analytics fires on these pages only; the portals stay untagged.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../lib/db');
const tz = require('../lib/tz');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const util = require('../lib/util');
const ranks = require('../lib/ranks');
const products = require('../lib/products');

const router = express.Router();

const formLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many submissions from this connection. Try again shortly.',
});

const ATTRIBUTION_COOKIE = 'rg_ref';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a public slug to { campaign, link, agent }. */
async function resolveSlug(tenantId, slug) {
  const link = await db.one(
    `select rl.*, p.full_name as agent_name, p.email as agent_email,
            p.id as agent_profile_id
       from referral_links rl
       join profiles p on p.id = rl.agent_id
      where rl.tenant_id = $1 and rl.slug = $2 and rl.active`,
    [tenantId, slug]
  );

  if (link) {
    const campaign = await db.one(
      "select * from campaigns where id = $1 and status = 'active'",
      [link.campaign_id]
    );
    if (!campaign) return null;
    return { campaign, link, agentName: link.agent_name };
  }

  // A bare campaign slug still works — an unattributed lead.
  const campaign = await db.one(
    "select * from campaigns where tenant_id = $1 and slug = $2 and status = 'active'",
    [tenantId, slug]
  );
  if (!campaign) return null;
  return { campaign, link: null, agentName: null };
}

async function leadByToken(tenantId, token) {
  if (!token || token.length < 16) return null;
  return db.one('select * from leads where tenant_id = $1 and access_token = $2', [tenantId, token]);
}

async function campaignFor(lead) {
  return db.one('select * from campaigns where id = $1', [lead.campaign_id]);
}

async function agentFor(lead) {
  if (!lead.agent_id) return null;
  return db.one('select * from profiles where id = $1', [lead.agent_id]);
}

/** Parse the campaign's custom field answers out of a form body. */
function readCustomFields(campaign, body) {
  const out = {};
  const fields = Array.isArray(campaign.custom_fields) ? campaign.custom_fields : [];
  fields.forEach((field) => {
    if (!field || !field.key) return;
    const raw = body[`custom_${field.key}`];
    if (raw === undefined) return;
    out[field.key] = util.text(raw, 2000);
  });
  return out;
}

function missingRequiredFields(campaign, custom) {
  const fields = Array.isArray(campaign.custom_fields) ? campaign.custom_fields : [];
  return fields
    .filter((f) => f && f.required && !util.text(custom[f.key]))
    .map((f) => f.label || f.key);
}

// ---------------------------------------------------------------------------
// Referral landing
// ---------------------------------------------------------------------------

router.get('/r/:slug', async (req, res, next) => {
  try {
    const resolved = await resolveSlug(req.tenant.id, req.params.slug);
    if (!resolved) return next();

    const { campaign, link, agentName } = resolved;

    if (link) {
      await db.query(
        'update referral_links set clicks = clicks + 1, last_click_at = now() where id = $1',
        [link.id]
      );
      res.cookie(ATTRIBUTION_COOKIE, link.slug, {
        maxAge: 1000 * 60 * 60 * 24 * 60,
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
      });
    }

    res.render('public/landing', {
      layout: 'layouts/public',
      title: campaign.headline || campaign.name,
      metaDescription: campaign.hero_subtext || campaign.description || '',
      ga4Id: config.analytics.ga4Id,
      campaign,
      link,
      agentName,
      slug: req.params.slug,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lead form
// ---------------------------------------------------------------------------

router.get('/r/:slug/apply', async (req, res, next) => {
  try {
    const resolved = await resolveSlug(req.tenant.id, req.params.slug);
    if (!resolved) return next();

    res.render('public/lead-form', {
      layout: 'layouts/public',
      title: `Get started · ${resolved.campaign.name}`,
      ga4Id: config.analytics.ga4Id,
      campaign: resolved.campaign,
      agentName: resolved.agentName,
      slug: req.params.slug,
      timezones: tz.COMMON_TIMEZONES,
      productList: await products.list(resolved.campaign.id),
      form: {},
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/r/:slug/apply', formLimiter, async (req, res, next) => {
  try {
    const resolved = await resolveSlug(req.tenant.id, req.params.slug);
    if (!resolved) return next();

    const { campaign, link } = resolved;
    const body = req.body || {};

    const form = {
      first_name: util.text(body.first_name, 80),
      last_name: util.text(body.last_name, 80),
      email: util.text(body.email, 200).toLowerCase(),
      phone: util.text(body.phone, 40),
      company: util.text(body.company, 120),
      // Full postal address. All optional — a prospect who will not give an
      // address is still a prospect, and an extra required field on a public
      // form costs more in abandoned submissions than the data is worth.
      address: util.text(body.address, 160),
      address_line2: util.text(body.address_line2, 160),
      city: util.text(body.city, 80),
      region: util.text(body.region, 80),
      postal_code: util.text(body.postal_code, 24),
      country: util.text(body.country, 80),
      timezone: tz.safeZone(body.timezone, config.staffTimezone),
      product_interest_id: util.text(body.product_interest_id) || '',
    };
    const custom = readCustomFields(campaign, body);

    // What they say they are interested in. Recorded because it is useful to the
    // agent before the call, and deliberately never used to calculate anything —
    // what someone ticks on a web form should not decide what an agent is paid.
    // The admin confirms the real product at close.
    const interest = util.text(body.product_interest_id)
      ? await products.forCampaign(util.text(body.product_interest_id), campaign.id)
      : null;

    const errors = [];
    if (!form.first_name) errors.push('Tell us your first name.');
    if (!util.isEmail(form.email)) errors.push('Enter an email address we can reach you on.');
    missingRequiredFields(campaign, custom).forEach((label) => {
      errors.push(`${label} is required.`);
    });

    if (errors.length) {
      return res.status(400).render('public/lead-form', {
        layout: 'layouts/public',
        title: `Get started · ${campaign.name}`,
        ga4Id: config.analytics.ga4Id,
        campaign,
        agentName: resolved.agentName,
        slug: req.params.slug,
        timezones: tz.COMMON_TIMEZONES,
        productList: await products.list(campaign.id),
        form: { ...form, ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [`custom_${k}`, v])) },
        errors,
      });
    }

    // The rank at referral is the rank that pays.
    //
    // Take a snapshot now, while the work is being done, rather than looking it
    // up when an admin gets round to closing. Otherwise a promotion silently
    // re-prices every open lead upward and a demotion re-prices them down, and
    // what someone earns depends on the timing of somebody else's click.
    let rankStamp = null;
    if (link && link.agent_id) {
      const liveRank = await db.one(
        `select cp.* from campaign_members cm
           join commission_profiles cp on cp.id = cm.commission_profile_id
          where cm.campaign_id = $1 and cm.agent_id = $2 and cm.status = 'active'`,
        [campaign.id, link.agent_id]
      );
      if (liveRank) rankStamp = ranks.snapshot(liveRank, campaign);
    }

    const lead = await db.one(
      `insert into leads
        (tenant_id, reference, access_token, campaign_id, agent_id, member_id,
         referral_link_id, first_name, last_name, email, phone, company,
         address, address_line2, city, region, postal_code, country,
         timezone, custom, utm_source, utm_medium, utm_campaign,
         landing_url, user_agent, ip_address,
         commission_profile_id, terms, terms_captured_at, product_interest_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       returning *`,
      [
        req.tenant.id,
        util.reference(),
        util.token(40),
        campaign.id,
        link ? link.agent_id : null,
        link ? link.member_id : null,
        link ? link.id : null,
        form.first_name, form.last_name, form.email, form.phone, form.company,
        form.address, form.address_line2, form.city, form.region,
        form.postal_code, form.country,
        form.timezone,
        JSON.stringify(custom),
        util.text(body.utm_source, 120), util.text(body.utm_medium, 120),
        util.text(body.utm_campaign, 120),
        `${config.appUrl}/r/${req.params.slug}`,
        util.text(req.get('user-agent'), 400),
        req.ip,
        rankStamp ? rankStamp.commission_profile_id : null,
        rankStamp ? JSON.stringify(rankStamp) : null,
        rankStamp ? new Date() : null,
        interest ? interest.id : null,
      ]
    );

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, kind, author_name, body)
       values ($1,$2,'system','System',$3)`,
      [
        req.tenant.id, lead.id,
        link
          ? `Lead captured from ${resolved.agentName}'s referral link.`
          : 'Lead captured from the campaign link (no referring agent).',
      ]
    );

    await audit.log({
      tenantId: req.tenant.id,
      req,
      actorType: 'prospect',
      actorName: `${form.first_name} ${form.last_name}`.trim(),
      action: 'lead.created',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${form.first_name} ${form.last_name} submitted the form for ${campaign.name}`,
      after: { email: form.email, campaign: campaign.name, agent: resolved.agentName || null },
    });

    const agent = await agentFor(lead);

    // Fire and forget — a slow SMTP server must not block the prospect.
    notify.fire('lead_created', {
      tenantId: req.tenant.id, lead, agent, campaign,
    }).catch((err) => console.error('[notify] lead_created failed:', err.message));

    notify.fire('welcome', {
      tenantId: req.tenant.id, lead, agent, campaign, recipients: ['lead'],
    }).catch((err) => console.error('[notify] welcome failed:', err.message));

    return res.redirect(`/acknowledge/${lead.access_token}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Acknowledgement / consent
// ---------------------------------------------------------------------------

router.get('/acknowledge/:token', async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();

    const campaign = await campaignFor(lead);

    if (lead.consent_given && lead.status !== 'new') {
      return res.redirect(`/appointment/${lead.access_token}`);
    }

    res.render('public/acknowledge', {
      layout: 'layouts/public',
      title: `Confirm your details · ${campaign.name}`,
      ga4Id: config.analytics.ga4Id,
      lead,
      campaign,
      timezones: tz.COMMON_TIMEZONES,
      errors: [],
      minDate: tz.isoDate(new Date(), lead.timezone),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/acknowledge/:token', formLimiter, async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();

    const campaign = await campaignFor(lead);
    const body = req.body || {};

    const zone = tz.safeZone(body.timezone, lead.timezone);
    const primaryAt = tz.localInputToDate(body.primary_date, body.primary_time, zone);
    const backupAt = tz.localInputToDate(body.backup_date, body.backup_time, zone);
    const consent = util.bool(body.consent);
    const consentName = util.text(body.consent_name, 120);
    const waOptIn = util.bool(body.whatsapp_opt_in);
    const waNumber = util.text(body.whatsapp_number, 40);

    const errors = [];
    if (campaign.requires_appointment) {
      if (!primaryAt) errors.push('Choose a date and time that suits you.');
      if (!backupAt) errors.push('Choose a backup date and time as well.');
      if (primaryAt && primaryAt.getTime() < Date.now() - 60000) {
        errors.push('Your preferred time is in the past.');
      }
      if (primaryAt && backupAt && primaryAt.getTime() === backupAt.getTime()) {
        errors.push('Your backup time should be different from your first choice.');
      }
    }
    if (campaign.requires_consent) {
      if (!consent) errors.push('Please tick the box to confirm you agree.');
      if (!consentName) errors.push('Type your name to confirm.');
    }
    if (waOptIn && !waNumber) errors.push('Add the number to reach you on WhatsApp, or untick that box.');

    if (errors.length) {
      return res.status(400).render('public/acknowledge', {
        layout: 'layouts/public',
        title: `Confirm your details · ${campaign.name}`,
        ga4Id: config.analytics.ga4Id,
        lead: { ...lead, timezone: zone },
        campaign,
        timezones: tz.COMMON_TIMEZONES,
        errors,
        submitted: body,
        minDate: tz.isoDate(new Date(), zone),
      });
    }

    const updated = await db.one(
      `update leads set
         timezone = $2,
         appointment_primary_at = $3,
         appointment_backup_at = $4,
         consent_given = $5,
         consent_at = case when $5 then now() else consent_at end,
         consent_ip = case when $5 then $6 else consent_ip end,
         consent_name = case when $5 then $7 else consent_name end,
         whatsapp_opt_in = $8,
         whatsapp_number = $9,
         status = case when status = 'new' and $3 is not null then 'appointment_set'::lead_status else status end
       where id = $1
       returning *`,
      [lead.id, zone, primaryAt, backupAt, consent, req.ip, consentName, waOptIn, waNumber || null]
    );

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, kind, author_name, body)
       values ($1,$2,'prospect',$3,$4)`,
      [
        req.tenant.id, lead.id, consentName || 'Prospect',
        campaign.requires_appointment
          ? `Acknowledged and chose appointment times.\nPrimary: ${tz.fmtDual(primaryAt, zone)}\nBackup: ${tz.fmtDual(backupAt, zone)}`
          : 'Acknowledged and gave consent.',
      ]
    );

    await audit.log({
      tenantId: req.tenant.id,
      req,
      actorType: 'prospect',
      actorName: consentName || `${lead.first_name} ${lead.last_name}`.trim(),
      action: 'lead.consent_given',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${consentName || lead.email} completed the acknowledgement`,
      after: {
        consent_given: consent,
        timezone: zone,
        appointment_primary_at: primaryAt,
        appointment_backup_at: backupAt,
        whatsapp_opt_in: waOptIn,
      },
    });

    const agent = await agentFor(updated);

    notify.fire('consent_given', { tenantId: req.tenant.id, lead: updated, agent, campaign })
      .catch((err) => console.error('[notify] consent_given failed:', err.message));

    if (primaryAt) {
      notify.fire('appointment_set', { tenantId: req.tenant.id, lead: updated, agent, campaign })
        .catch((err) => console.error('[notify] appointment_set failed:', err.message));
    }

    return res.redirect(`/thanks/${updated.access_token}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Thank you
// ---------------------------------------------------------------------------

router.get('/thanks/:token', async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();
    const campaign = await campaignFor(lead);

    res.render('public/thanks', {
      layout: 'layouts/public',
      title: 'Thank you',
      ga4Id: config.analytics.ga4Id,
      lead,
      campaign,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Prospect self-service — edit or cancel the appointment
// ---------------------------------------------------------------------------

router.get('/appointment/:token', async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();
    const campaign = await campaignFor(lead);

    res.render('public/appointment', {
      layout: 'layouts/public',
      title: 'Your appointment',
      ga4Id: config.analytics.ga4Id,
      lead,
      campaign,
      timezones: tz.COMMON_TIMEZONES,
      errors: [],
      minDate: tz.isoDate(new Date(), lead.timezone),
      cancelled: lead.cancelled_by_prospect,
      saved: req.query.saved === '1',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/appointment/:token', formLimiter, async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();
    if (lead.cancelled_by_prospect) return res.redirect(`/appointment/${lead.access_token}`);

    const campaign = await campaignFor(lead);
    const body = req.body || {};

    const zone = tz.safeZone(body.timezone, lead.timezone);
    const primaryAt = tz.localInputToDate(body.primary_date, body.primary_time, zone);
    const backupAt = tz.localInputToDate(body.backup_date, body.backup_time, zone);

    const errors = [];
    if (!primaryAt) errors.push('Choose a date and time that suits you.');
    if (primaryAt && primaryAt.getTime() < Date.now() - 60000) errors.push('That time is in the past.');
    if (primaryAt && backupAt && primaryAt.getTime() === backupAt.getTime()) {
      errors.push('Your backup time should be different from your first choice.');
    }

    if (errors.length) {
      return res.status(400).render('public/appointment', {
        layout: 'layouts/public',
        title: 'Your appointment',
        ga4Id: config.analytics.ga4Id,
        lead: { ...lead, timezone: zone },
        campaign,
        timezones: tz.COMMON_TIMEZONES,
        errors,
        minDate: tz.isoDate(new Date(), zone),
        cancelled: false,
      });
    }

    const updated = await db.one(
      `update leads set
         timezone = $2,
         appointment_primary_at = $3,
         appointment_backup_at = $4,
         confirmed_slot = null,
         status = case when status in ('new','contacted') then 'appointment_set'::lead_status else status end
       where id = $1 returning *`,
      [lead.id, zone, primaryAt, backupAt]
    );

    // A changed appointment invalidates any reminder already sent for the old
    // time — the unique key includes appointment_at, so new ones will fire.
    await db.query('delete from reminder_sends where lead_id = $1', [lead.id]);

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, kind, author_name, body)
       values ($1,$2,'prospect',$3,$4)`,
      [
        req.tenant.id, lead.id,
        `${lead.first_name} ${lead.last_name}`.trim() || 'Prospect',
        `Rescheduled from their own link.\nPrimary: ${tz.fmtDual(primaryAt, zone)}\nBackup: ${tz.fmtDual(backupAt, zone)}`,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id,
      req,
      actorType: 'prospect',
      actorName: `${lead.first_name} ${lead.last_name}`.trim() || lead.email,
      action: 'lead.rescheduled',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email} rescheduled their appointment`,
      before: {
        appointment_primary_at: lead.appointment_primary_at,
        appointment_backup_at: lead.appointment_backup_at,
      },
      after: { appointment_primary_at: primaryAt, appointment_backup_at: backupAt },
    });

    const agent = await agentFor(updated);
    notify.fire('appointment_rescheduled', { tenantId: req.tenant.id, lead: updated, agent, campaign })
      .catch((err) => console.error('[notify] appointment_rescheduled failed:', err.message));

    return res.redirect(`/appointment/${updated.access_token}?saved=1`);
  } catch (err) {
    next(err);
  }
});

router.post('/appointment/:token/cancel', formLimiter, async (req, res, next) => {
  try {
    const lead = await leadByToken(req.tenant.id, req.params.token);
    if (!lead) return next();

    const campaign = await campaignFor(lead);
    const reason = util.text(req.body.reason, 500);

    const updated = await db.one(
      `update leads set
         status = 'closed_lost',
         cancelled_by_prospect = true,
         cancel_reason = $2,
         appointment_primary_at = null,
         appointment_backup_at = null,
         confirmed_slot = null,
         suppress_email = true,
         closed_at = now()
       where id = $1 returning *`,
      [lead.id, reason || 'Cancelled by the prospect from their appointment link.']
    );

    await db.query('delete from reminder_sends where lead_id = $1', [lead.id]);

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, kind, author_name, body)
       values ($1,$2,'prospect',$3,$4)`,
      [
        req.tenant.id, lead.id,
        `${lead.first_name} ${lead.last_name}`.trim() || 'Prospect',
        `Cancelled from their own link. Lead closed as lost.${reason ? `\nReason given: ${reason}` : ''}`,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id,
      req,
      actorType: 'prospect',
      actorName: `${lead.first_name} ${lead.last_name}`.trim() || lead.email,
      action: 'lead.cancelled',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email} cancelled — lead closed as lost`,
      before: { status: lead.status },
      after: { status: 'closed_lost', cancel_reason: reason || null },
    });

    const agent = await agentFor(updated);

    // Agent and admin only — the prospect asked us to stop emailing them.
    notify.fire('prospect_cancelled', {
      tenantId: req.tenant.id, lead: updated, agent, campaign, recipients: ['agent', 'admin'],
    }).catch((err) => console.error('[notify] prospect_cancelled failed:', err.message));

    return res.redirect(`/appointment/${updated.access_token}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
