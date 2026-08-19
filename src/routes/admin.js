'use strict';

/**
 * The admin console.
 *
 * Admins own campaigns, commission ranks, agent memberships, the closing of
 * leads (which is what creates a commission), the money, and the message
 * templates. Everything consequential is written to the audit log.
 */

const express = require('express');
const { stringify } = require('csv-stringify/sync');

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
const relations = require('../lib/relations');
const users = require('../lib/users');
const commissions = require('../lib/commissions');
const { getAdminClient } = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const [pipeline, totals, recentLeads, upcoming, awaitingClose, activeAccounts, agentCount, campaignCount] =
      await Promise.all([
        db.all('select status, count(*)::int as n from leads where tenant_id = $1 group by status', [req.tenant.id]),
        commissions.tenantTotals(req.tenant.id),
        db.all(
          `select l.*, c.name as campaign_name, p.full_name as agent_name
             from leads l join campaigns c on c.id = l.campaign_id
             left join profiles p on p.id = l.agent_id
            where l.tenant_id = $1 order by l.created_at desc limit 8`,
          [req.tenant.id]
        ),
        db.all(
          `select l.*, c.name as campaign_name, p.full_name as agent_name
             from leads l join campaigns c on c.id = l.campaign_id
             left join profiles p on p.id = l.agent_id
            where l.tenant_id = $1 and l.appointment_primary_at > now()
              and l.status not in ('closed_won','closed_lost')
            order by l.appointment_primary_at limit 8`,
          [req.tenant.id]
        ),
        db.all(
          `select l.*, c.name as campaign_name, p.full_name as agent_name
             from leads l join campaigns c on c.id = l.campaign_id
             left join profiles p on p.id = l.agent_id
            where l.tenant_id = $1 and l.status = 'appointment_set'
              and l.appointment_primary_at < now()
            order by l.appointment_primary_at limit 8`,
          [req.tenant.id]
        ),
        db.one('select count(*)::int as n from leads where tenant_id = $1 and account_active', [req.tenant.id]),
        db.one("select count(*)::int as n from profiles where tenant_id = $1 and role = 'agent' and status = 'active'", [req.tenant.id]),
        db.one("select count(*)::int as n from campaigns where tenant_id = $1 and status = 'active'", [req.tenant.id]),
      ]);

    const counts = Object.fromEntries(pipeline.map((r) => [r.status, r.n]));
    const totalLeads = pipeline.reduce((sum, r) => sum + r.n, 0);
    const won = counts.closed_won || 0;

    res.render('admin/dashboard', {
      title: 'Dashboard',
      counts,
      totalLeads,
      won,
      conversion: totalLeads ? Math.round((won / totalLeads) * 100) : 0,
      totals,
      recentLeads,
      upcoming,
      awaitingClose,
      activeAccounts: activeAccounts.n,
      agentCount: agentCount.n,
      campaignCount: campaignCount.n,
      configProblems: config.validate(),
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Campaigns
// ===========================================================================

router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await db.all(
      `select c.*,
              (select count(*) from commission_profiles cp where cp.campaign_id = c.id and cp.status = 'active')::int as profile_count,
              (select count(*) from campaign_members cm where cm.campaign_id = c.id and cm.status = 'active')::int as member_count,
              (select count(*) from leads l where l.campaign_id = c.id)::int as lead_count
         from campaigns c where c.tenant_id = $1
        order by c.status, c.name`,
      [req.tenant.id]
    );
    res.render('admin/campaigns', { title: 'Campaigns', campaigns });
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns/new', (req, res) => {
  res.render('admin/campaign-form', {
    title: 'New campaign',
    campaign: {
      cta_label: 'Get Started',
      landing_link_label: 'Click here for more information',
      requires_appointment: true,
      requires_consent: true,
      currency: 'USD',
      status: 'active',
      custom_fields: [],
    },
    reminders: [1, 2, 3].map((slot) => ({ slot, active: false, offset_value: 1, offset_unit: 'days', to_prospect: true })),
    isNew: true,
  });
});

/** Shared read of the campaign form body. */
function readCampaignBody(body) {
  let customFields = [];
  try {
    const parsed = JSON.parse(body.custom_fields || '[]');
    if (Array.isArray(parsed)) {
      customFields = parsed
        .filter((f) => f && f.key)
        .map((f) => ({
          key: util.slugify(f.key, 'field').replace(/-/g, '_'),
          label: util.text(f.label, 200) || f.key,
          type: ['text', 'textarea', 'select', 'number'].includes(f.type) ? f.type : 'text',
          required: Boolean(f.required),
          options: Array.isArray(f.options) ? f.options.map((o) => util.text(o, 120)).filter(Boolean) : undefined,
          help: util.text(f.help, 300) || undefined,
        }));
    }
  } catch (_) { /* leave empty and tell the operator below */ }

  return {
    name: util.text(body.name, 120),
    slug: util.slugify(body.slug || body.name, ''),
    client_name: util.text(body.client_name, 120),
    description: util.text(body.description, 4000),
    status: ['active', 'paused', 'archived'].includes(body.status) ? body.status : 'active',
    currency: util.text(body.currency, 8) || 'USD',
    headline: util.text(body.headline, 200),
    hero_subtext: util.text(body.hero_subtext, 400),
    cta_label: util.text(body.cta_label, 60) || 'Get Started',
    thank_you_message: util.text(body.thank_you_message, 800),
    landing_page_url: util.text(body.landing_page_url, 500),
    landing_link_label: util.text(body.landing_link_label, 120) || 'Click here for more information',
    requires_appointment: util.bool(body.requires_appointment),
    requires_consent: util.bool(body.requires_consent),
    consent_text: util.text(body.consent_text, 4000),
    terms_url: util.text(body.terms_url, 500),
    notify_emails: util.text(body.notify_emails, 500),
    custom_fields: customFields,
  };
}

router.post('/campaigns', async (req, res, next) => {
  try {
    const data = readCampaignBody(req.body);
    if (!data.name) {
      req.flash('error', 'Give the campaign a name.');
      return res.redirect('/admin/campaigns/new');
    }
    if (!data.slug) data.slug = util.slugify(data.name, `campaign-${util.token(4)}`);

    const existing = await db.one('select 1 from campaigns where tenant_id = $1 and slug = $2', [req.tenant.id, data.slug]);
    if (existing) data.slug = `${data.slug}-${util.token(4)}`;

    const campaign = await db.one(
      `insert into campaigns
        (tenant_id, name, slug, client_name, description, status, currency, headline,
         hero_subtext, cta_label, thank_you_message, landing_page_url, landing_link_label,
         requires_appointment, requires_consent, consent_text, terms_url, notify_emails, custom_fields)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning *`,
      [
        req.tenant.id, data.name, data.slug, data.client_name, data.description,
        data.status, data.currency, data.headline, data.hero_subtext, data.cta_label,
        data.thank_you_message, data.landing_page_url, data.landing_link_label,
        data.requires_appointment, data.requires_consent, data.consent_text,
        data.terms_url, data.notify_emails, JSON.stringify(data.custom_fields),
      ]
    );

    // Three reminder slots, all off, ready to be configured.
    for (const slot of [1, 2, 3]) {
      await db.query(
        `insert into campaign_reminders (tenant_id, campaign_id, slot, offset_value, offset_unit)
         values ($1,$2,$3,$4,'days') on conflict (campaign_id, slot) do nothing`,
        [req.tenant.id, campaign.id, slot, slot === 1 ? 2 : (slot === 2 ? 1 : 1)]
      );
    }

    // A campaign with no rank cannot pay anybody — seed a sensible default.
    await db.query(
      `insert into commission_profiles
        (tenant_id, campaign_id, name, is_default, initial_type, initial_value, deal_value, currency)
       values ($1,$2,'Standard',true,'percentage',10,0,$3)`,
      [req.tenant.id, campaign.id, data.currency]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: campaign.id,
      summary: `Created campaign "${campaign.name}"`,
      after: { name: campaign.name, slug: campaign.slug, status: campaign.status },
    });

    req.flash('success', 'Campaign created. Set up its commission ranks next.');
    return res.redirect(`/admin/campaigns/${campaign.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!campaign) return next();

    const [profiles, members, reminders, stats, notificationTemplates] = await Promise.all([
      db.all(
        `select cp.*, (select count(*) from campaign_members cm
                        where cm.commission_profile_id = cp.id and cm.status = 'active')::int as member_count
           from commission_profiles cp where cp.campaign_id = $1 order by cp.rank_order, cp.name`,
        [campaign.id]
      ),
      db.all(
        `select cm.*, p.full_name, p.email, cp.name as profile_name, rl.slug as link_slug,
                (select count(*) from leads l where l.campaign_id = cm.campaign_id and l.agent_id = cm.agent_id)::int as lead_count
           from campaign_members cm
           join profiles p on p.id = cm.agent_id
           left join commission_profiles cp on cp.id = cm.commission_profile_id
           left join referral_links rl on rl.member_id = cm.id
          where cm.campaign_id = $1 and cm.status = 'active'
          order by p.full_name`,
        [campaign.id]
      ),
      db.all('select * from campaign_reminders where campaign_id = $1 order by slot', [campaign.id]),
      db.one(
        `select count(*)::int as leads,
                count(*) filter (where status = 'closed_won')::int as won,
                count(*) filter (where account_active)::int as active_accounts
           from leads where campaign_id = $1`,
        [campaign.id]
      ),
      db.all(
        'select id, name, channel, trigger_event from notification_templates where tenant_id = $1 and active order by name',
        [req.tenant.id]
      ),
    ]);

    res.render('admin/campaign-detail', {
      title: campaign.name,
      campaign,
      profiles,
      members,
      reminders,
      stats,
      notificationTemplates,
      whatsappLive: config.whatsapp.configured,
      appUrl: config.appUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns/:id/edit', async (req, res, next) => {
  try {
    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!campaign) return next();
    res.render('admin/campaign-form', { title: `Edit ${campaign.name}`, campaign, isNew: false });
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns/:id', async (req, res, next) => {
  try {
    const before = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!before) return next();

    const data = readCampaignBody(req.body);
    if (!data.name) {
      req.flash('error', 'Give the campaign a name.');
      return res.redirect(`/admin/campaigns/${before.id}/edit`);
    }
    if (!data.slug) data.slug = before.slug;

    if (data.slug !== before.slug) {
      const clash = await db.one('select 1 from campaigns where tenant_id = $1 and slug = $2 and id <> $3',
        [req.tenant.id, data.slug, before.id]);
      if (clash) data.slug = `${data.slug}-${util.token(4)}`;
    }

    const after = await db.one(
      `update campaigns set
         name=$2, slug=$3, client_name=$4, description=$5, status=$6, currency=$7,
         headline=$8, hero_subtext=$9, cta_label=$10, thank_you_message=$11,
         landing_page_url=$12, landing_link_label=$13, requires_appointment=$14,
         requires_consent=$15, consent_text=$16, terms_url=$17, notify_emails=$18,
         custom_fields=$19
       where id=$1 returning *`,
      [
        before.id, data.name, data.slug, data.client_name, data.description,
        data.status, data.currency, data.headline, data.hero_subtext, data.cta_label,
        data.thank_you_message, data.landing_page_url, data.landing_link_label,
        data.requires_appointment, data.requires_consent, data.consent_text,
        data.terms_url, data.notify_emails, JSON.stringify(data.custom_fields),
      ]
    );

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'campaign.updated',
      entityType: 'campaign',
      entityId: before.id,
      summary: `Updated campaign "${after.name}"`,
      before, after,
    }, ['name', 'slug', 'status', 'landing_page_url', 'landing_link_label', 'requires_appointment', 'requires_consent', 'currency']);

    req.flash('success', 'Campaign saved.');
    return res.redirect(`/admin/campaigns/${before.id}`);
  } catch (err) {
    next(err);
  }
});

// --- reminder slots --------------------------------------------------------

router.post('/campaigns/:id/reminders', async (req, res, next) => {
  try {
    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!campaign) return next();

    for (const slot of [1, 2, 3]) {
      const active = util.bool(req.body[`slot${slot}_active`]);
      const value = Math.max(1, util.num(req.body[`slot${slot}_offset_value`], 1));
      const unit = req.body[`slot${slot}_offset_unit`] === 'hours' ? 'hours' : 'days';

      await db.query(
        `insert into campaign_reminders
          (tenant_id, campaign_id, slot, active, offset_value, offset_unit,
           channel_email, channel_whatsapp, to_prospect, to_agent, to_admin)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (campaign_id, slot) do update set
           active=excluded.active, offset_value=excluded.offset_value,
           offset_unit=excluded.offset_unit, channel_email=excluded.channel_email,
           channel_whatsapp=excluded.channel_whatsapp, to_prospect=excluded.to_prospect,
           to_agent=excluded.to_agent, to_admin=excluded.to_admin`,
        [
          req.tenant.id, campaign.id, slot, active, value, unit,
          util.bool(req.body[`slot${slot}_channel_email`]),
          util.bool(req.body[`slot${slot}_channel_whatsapp`]),
          util.bool(req.body[`slot${slot}_to_prospect`]),
          util.bool(req.body[`slot${slot}_to_agent`]),
          util.bool(req.body[`slot${slot}_to_admin`]),
        ]
      );
    }

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'campaign.reminders_updated',
      entityType: 'campaign',
      entityId: campaign.id,
      summary: `Updated appointment reminders on "${campaign.name}"`,
    });

    req.flash('success', 'Reminder settings saved.');
    return res.redirect(`/admin/campaigns/${campaign.id}#reminders`);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Commission profiles (ranks)
// ===========================================================================

function readProfileBody(body) {
  return {
    name: util.text(body.name, 80),
    description: util.text(body.description, 500),
    initial_type: body.initial_type === 'fixed' ? 'fixed' : 'percentage',
    initial_value: util.num(body.initial_value, 0),
    recurring_enabled: util.bool(body.recurring_enabled),
    recurring_type: body.recurring_type === 'fixed' ? 'fixed' : 'percentage',
    recurring_value: util.num(body.recurring_value, 0),
    recurring_months: util.text(body.recurring_months) ? Math.max(1, util.num(body.recurring_months, 1)) : null,
    payout_day: Math.min(28, Math.max(1, util.num(body.payout_day, 15))),
    deal_value: util.num(body.deal_value, 0),
    currency: util.text(body.currency, 8) || 'USD',
    rank_order: util.num(body.rank_order, 0),
    is_default: util.bool(body.is_default),
    status: body.status === 'archived' ? 'archived' : 'active',
  };
}

router.post('/campaigns/:id/profiles', async (req, res, next) => {
  try {
    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!campaign) return next();

    const data = readProfileBody(req.body);
    if (!data.name) {
      req.flash('error', 'Give the rank a name, for example "Standard" or "Senior".');
      return res.redirect(`/admin/campaigns/${campaign.id}`);
    }

    if (data.is_default) {
      await db.query('update commission_profiles set is_default = false where campaign_id = $1', [campaign.id]);
    }

    const profile = await db.one(
      `insert into commission_profiles
        (tenant_id, campaign_id, name, description, is_default, rank_order,
         initial_type, initial_value, recurring_enabled, recurring_type,
         recurring_value, recurring_months, payout_day, deal_value, currency, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [
        req.tenant.id, campaign.id, data.name, data.description, data.is_default,
        data.rank_order, data.initial_type, data.initial_value, data.recurring_enabled,
        data.recurring_type, data.recurring_value, data.recurring_months,
        data.payout_day, data.deal_value, data.currency, data.status,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'commission_profile.created',
      entityType: 'commission_profile',
      entityId: profile.id,
      summary: `Created rank "${profile.name}" on ${campaign.name}`,
      after: {
        name: profile.name,
        initial: util.rateLabel(profile.initial_type, profile.initial_value, profile.currency),
        deal_value: profile.deal_value,
        recurring: profile.recurring_enabled
          ? util.rateLabel(profile.recurring_type, profile.recurring_value, profile.currency) : 'none',
      },
    });

    req.flash('success', `Rank "${profile.name}" added.`);
    return res.redirect(`/admin/campaigns/${campaign.id}#ranks`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'A rank with that name already exists on this campaign.');
      return res.redirect(`/admin/campaigns/${req.params.id}#ranks`);
    }
    next(err);
  }
});

router.post('/profiles/:id', async (req, res, next) => {
  try {
    const before = await db.one(
      'select cp.*, c.name as campaign_name from commission_profiles cp join campaigns c on c.id = cp.campaign_id where cp.id = $1 and cp.tenant_id = $2',
      [req.params.id, req.tenant.id]
    );
    if (!before) return next();

    const data = readProfileBody(req.body);
    if (!data.name) {
      req.flash('error', 'The rank needs a name.');
      return res.redirect(`/admin/campaigns/${before.campaign_id}#ranks`);
    }

    if (data.is_default) {
      await db.query('update commission_profiles set is_default = false where campaign_id = $1 and id <> $2',
        [before.campaign_id, before.id]);
    }

    const after = await db.one(
      `update commission_profiles set
         name=$2, description=$3, is_default=$4, rank_order=$5, initial_type=$6,
         initial_value=$7, recurring_enabled=$8, recurring_type=$9, recurring_value=$10,
         recurring_months=$11, payout_day=$12, deal_value=$13, currency=$14, status=$15
       where id=$1 returning *`,
      [
        before.id, data.name, data.description, data.is_default, data.rank_order,
        data.initial_type, data.initial_value, data.recurring_enabled, data.recurring_type,
        data.recurring_value, data.recurring_months, data.payout_day, data.deal_value,
        data.currency, data.status,
      ]
    );

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'commission_profile.updated',
      entityType: 'commission_profile',
      entityId: before.id,
      summary: `Updated rank "${after.name}" on ${before.campaign_name}`,
      before, after,
    }, [
      'name', 'is_default', 'initial_type', 'initial_value', 'recurring_enabled',
      'recurring_type', 'recurring_value', 'recurring_months', 'payout_day',
      'deal_value', 'currency', 'status',
    ]);

    req.flash('success', 'Rank updated. It applies to commissions created from now on.');
    return res.redirect(`/admin/campaigns/${before.campaign_id}#ranks`);
  } catch (err) {
    next(err);
  }
});

router.post('/profiles/:id/delete', async (req, res, next) => {
  try {
    const profile = await db.one(
      'select cp.*, c.name as campaign_name from commission_profiles cp join campaigns c on c.id = cp.campaign_id where cp.id = $1 and cp.tenant_id = $2',
      [req.params.id, req.tenant.id]
    );
    if (!profile) return next();

    const inUse = await db.one(
      "select count(*)::int as n from campaign_members where commission_profile_id = $1 and status = 'active'",
      [profile.id]
    );
    if (inUse.n > 0) {
      req.flash('error', `${inUse.n} agent${inUse.n === 1 ? ' is' : 's are'} on that rank. Move them first, then archive it.`);
      return res.redirect(`/admin/campaigns/${profile.campaign_id}#ranks`);
    }

    await db.query("update commission_profiles set status = 'archived', is_default = false where id = $1", [profile.id]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'commission_profile.deleted',
      entityType: 'commission_profile',
      entityId: profile.id,
      summary: `Archived rank "${profile.name}" on ${profile.campaign_name}`,
      before: { name: profile.name, status: 'active' },
      after: { status: 'archived' },
    });

    req.flash('success', 'Rank archived. Existing commissions are untouched.');
    return res.redirect(`/admin/campaigns/${profile.campaign_id}#ranks`);
  } catch (err) {
    next(err);
  }
});

/** Move an agent between ranks — the change the audit log cares most about. */
router.post('/members/:id/profile', async (req, res, next) => {
  try {
    const member = await db.one(
      `select cm.*, p.full_name, p.email, c.name as campaign_name,
              cp.name as current_profile_name
         from campaign_members cm
         join profiles p on p.id = cm.agent_id
         join campaigns c on c.id = cm.campaign_id
         left join commission_profiles cp on cp.id = cm.commission_profile_id
        where cm.id = $1 and cm.tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (!member) return next();

    const profileId = util.text(req.body.commission_profile_id) || null;
    let newProfile = null;
    if (profileId) {
      newProfile = await db.one(
        'select * from commission_profiles where id = $1 and campaign_id = $2',
        [profileId, member.campaign_id]
      );
      if (!newProfile) {
        req.flash('error', 'That rank does not belong to this campaign.');
        return res.redirect(req.get('referer') || `/admin/campaigns/${member.campaign_id}`);
      }
    }

    await db.query('update campaign_members set commission_profile_id = $2 where id = $1',
      [member.id, newProfile ? newProfile.id : null]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'member.profile_changed',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${member.full_name || member.email} moved to "${newProfile ? newProfile.name : 'no rank'}" on ${member.campaign_name}`,
      before: { commission_profile: member.current_profile_name || null },
      after: { commission_profile: newProfile ? newProfile.name : null },
    });

    req.flash('success', 'Commission rank updated.');
    return res.redirect(req.get('referer') || `/admin/campaigns/${member.campaign_id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/remove', async (req, res, next) => {
  try {
    const member = await db.one(
      `select cm.*, p.full_name, p.email, c.name as campaign_name
         from campaign_members cm
         join profiles p on p.id = cm.agent_id
         join campaigns c on c.id = cm.campaign_id
        where cm.id = $1 and cm.tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (!member) return next();

    await db.query("update campaign_members set status = 'removed', left_at = now() where id = $1", [member.id]);
    await db.query('update referral_links set active = false where member_id = $1', [member.id]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'member.removed',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${member.full_name || member.email} removed from ${member.campaign_name}`,
    });

    req.flash('success', 'Agent removed from the campaign. Their link no longer works.');
    return res.redirect(req.get('referer') || `/admin/campaigns/${member.campaign_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The rest of the console lives in focused sibling routers so no single file
// becomes unreadable. They are all mounted under /admin and inherit the
// requireAdmin guard above.
// ---------------------------------------------------------------------------
router.use(require('./admin-agents'));
router.use(require('./admin-leads'));
router.use(require('./admin-money'));
router.use(require('./admin-messaging'));
router.use(require('./admin-system'));

module.exports = router;
