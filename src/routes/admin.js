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
const products = require('../lib/products');
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
    // What one deal here is worth. Lives on the campaign because it describes
    // the product, not the person who sold it — every rank inherits it unless
    // it deliberately overrides.
    deal_value: util.num(body.deal_value, 0),
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
        (tenant_id, name, slug, client_name, description, status, currency, deal_value,
         headline, hero_subtext, cta_label, thank_you_message, landing_page_url,
         landing_link_label, requires_appointment, requires_consent, consent_text,
         terms_url, notify_emails, custom_fields)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       returning *`,
      [
        req.tenant.id, data.name, data.slug, data.client_name, data.description,
        data.status, data.currency, data.deal_value, data.headline, data.hero_subtext,
        data.cta_label, data.thank_you_message, data.landing_page_url, data.landing_link_label,
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
    // deal_value is left null so it inherits the campaign's, which is the
    // behaviour you want for the overwhelming majority of ranks.
    await db.query(
      `insert into commission_profiles
        (tenant_id, campaign_id, name, is_default, initial_type, initial_value, deal_value, currency)
       values ($1,$2,'Standard',true,'percentage',10,null,$3)`,
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

    const [profiles, members, reminders, stats, notificationTemplates, productList] = await Promise.all([
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
      products.list(campaign.id, { includeInactive: true }),
    ]);

    res.render('admin/campaign-detail', {
      productList,
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

    // A live campaign with no rank takes referrals it can never pay for. The
    // agent does the work, the lead closes, and the commission cannot be
    // calculated — discovered far too late to be fair about. Refuse to publish.
    if (data.status === 'active' && before.status !== 'active') {
      const rankCount = await db.one(
        "select count(*)::int as n from commission_profiles where campaign_id = $1 and status = 'active'",
        [before.id]
      );
      if (!rankCount || rankCount.n === 0) {
        req.flash('error', 'This campaign has no active commission rank, so a closed lead could not be paid. Add a rank before making it live.');
        return res.redirect(`/admin/campaigns/${before.id}#ranks`);
      }
    }

    const after = await db.one(
      `update campaigns set
         name=$2, slug=$3, client_name=$4, description=$5, status=$6, currency=$7,
         deal_value=$8, headline=$9, hero_subtext=$10, cta_label=$11,
         thank_you_message=$12, landing_page_url=$13, landing_link_label=$14,
         requires_appointment=$15, requires_consent=$16, consent_text=$17,
         terms_url=$18, notify_emails=$19, custom_fields=$20
       where id=$1 returning *`,
      [
        before.id, data.name, data.slug, data.client_name, data.description,
        data.status, data.currency, data.deal_value, data.headline, data.hero_subtext,
        data.cta_label, data.thank_you_message, data.landing_page_url, data.landing_link_label,
        data.requires_appointment, data.requires_consent, data.consent_text,
        data.terms_url, data.notify_emails, JSON.stringify(data.custom_fields),
      ]
    );

    // The campaign's currency is the only currency. Keep the ranks in step so
    // nothing can be read as disagreeing with it.
    if (after.currency !== before.currency) {
      await db.query('update commission_profiles set currency = $2 where campaign_id = $1', [before.id, after.currency]);
    }

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'campaign.updated',
      entityType: 'campaign',
      entityId: before.id,
      summary: `Updated campaign "${after.name}"`,
      before, after,
    }, ['name', 'slug', 'status', 'landing_page_url', 'landing_link_label',
      'requires_appointment', 'requires_consent', 'currency', 'deal_value']);

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
// Products — what a campaign sells
//
// The rank sets the rate; the product sets the value. Keeping them apart is
// what lets one campaign carry a Starter, a Pro and an Enterprise without
// needing three ranks that differ only in the number they multiply.
// ===========================================================================

router.post('/campaigns/:id/products', async (req, res, next) => {
  try {
    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!campaign) return next();

    const data = products.readBody(req.body, util);
    if (!data.name) {
      req.flash('error', 'Give the product a name.');
      return res.redirect(`/admin/campaigns/${campaign.id}#products`);
    }

    const created = await db.one(
      `insert into campaign_products (tenant_id, campaign_id, name, code, description, value, sort_order, active)
       values ($1,$2,$3,$4,$5,$6,$7,true)
       returning *`,
      [req.tenant.id, campaign.id, data.name, data.code, data.description, data.value, data.sort_order]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'product.created',
      entityType: 'campaign_product',
      entityId: created.id,
      summary: `Added product "${created.name}" at ${util.money(created.value, campaign.currency)} to ${campaign.name}`,
      after: { name: created.name, value: created.value },
    });

    req.flash('success', `"${created.name}" added.`);
    return res.redirect(`/admin/campaigns/${campaign.id}#products`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'A product with that name already exists on this campaign.');
      return res.redirect(`/admin/campaigns/${req.params.id}#products`);
    }
    return next(err);
  }
});

router.post('/products/:id', async (req, res, next) => {
  try {
    const before = await db.one(
      `select p.*, c.name as campaign_name, c.currency
         from campaign_products p join campaigns c on c.id = p.campaign_id
        where p.id = $1 and p.tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (!before) return next();

    const data = products.readBody(req.body, util);
    if (!data.name) {
      req.flash('error', 'The product needs a name.');
      return res.redirect(`/admin/campaigns/${before.campaign_id}#products`);
    }

    const after = await db.one(
      `update campaign_products
          set name=$2, code=$3, description=$4, value=$5, sort_order=$6, active=$7, updated_at=now()
        where id=$1 returning *`,
      [before.id, data.name, data.code, data.description, data.value, data.sort_order, data.active]
    );

    await audit.logDiff({
      tenantId: req.tenant.id, req,
      action: 'product.updated',
      entityType: 'campaign_product',
      entityId: before.id,
      summary: `Updated product "${after.name}" on ${before.campaign_name}`,
      before, after,
    }, ['name', 'code', 'value', 'sort_order', 'active']);

    // Same rule as ranks, and worth saying out loud for the same reason: the
    // value is copied onto a lead when it closes, so repricing here cannot
    // reprice a deal that is already done.
    req.flash('success', 'Product saved. Deals already closed keep the price they closed at.');
    return res.redirect(`/admin/campaigns/${before.campaign_id}#products`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'A product with that name already exists on this campaign.');
      return next();
    }
    return next(err);
  }
});

// ===========================================================================
// Commission profiles (ranks)
// ===========================================================================

function readProfileBody(body) {
  const autoPromote = util.bool(body.auto_promote);
  const afterDeals = util.text(body.promote_after_deals)
    ? Math.max(1, util.num(body.promote_after_deals, 1))
    : null;
  const afterAmount = util.text(body.promote_after_amount)
    ? Math.max(0.01, util.num(body.promote_after_amount, 0))
    : null;

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
    // Blank means inherit the campaign's deal value. Deliberately not zero:
    // a rank that overrides the campaign with 0 earns nothing on percentages,
    // and that should require typing a 0, not leaving a box empty.
    deal_value: util.text(body.deal_value) === '' || body.deal_value === undefined
      ? null
      : util.num(body.deal_value, 0),
    rank_order: util.num(body.rank_order, 0),
    is_default: util.bool(body.is_default),
    status: body.status === 'archived' ? 'archived' : 'active',
    // A rank that promotes automatically but names no condition would promote
    // everyone the first time the job ran. The database refuses to store one,
    // so switch the flag off rather than hand it a row it will reject.
    auto_promote: autoPromote && (afterDeals !== null || afterAmount !== null),
    promote_after_deals: afterDeals,
    promote_after_amount: afterAmount,
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
         recurring_value, recurring_months, payout_day, deal_value, currency, status,
         auto_promote, promote_after_deals, promote_after_amount)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning *`,
      [
        req.tenant.id, campaign.id, data.name, data.description, data.is_default,
        data.rank_order, data.initial_type, data.initial_value, data.recurring_enabled,
        data.recurring_type, data.recurring_value, data.recurring_months,
        // Currency follows the campaign — it is not a rank-level choice. Two
        // ranks disagreeing about the currency of one campaign made the totals,
        // which sum without grouping, silently wrong.
        data.payout_day, data.deal_value, campaign.currency, data.status,
        data.auto_promote, data.promote_after_deals, data.promote_after_amount,
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
         recurring_months=$11, payout_day=$12, deal_value=$13, status=$14,
         auto_promote=$15, promote_after_deals=$16, promote_after_amount=$17,
         currency = (select currency from campaigns where id = commission_profiles.campaign_id)
       where id=$1 returning *`,
      [
        before.id, data.name, data.description, data.is_default, data.rank_order,
        data.initial_type, data.initial_value, data.recurring_enabled, data.recurring_type,
        data.recurring_value, data.recurring_months, data.payout_day, data.deal_value,
        data.status, data.auto_promote, data.promote_after_deals, data.promote_after_amount,
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
      'deal_value', 'status', 'auto_promote', 'promote_after_deals', 'promote_after_amount',
    ]);

    // Worth saying out loud every time, because the alternative behaviour is
    // what most systems do and what people expect: this edit reaches nothing
    // that already exists. Leads already referred keep the terms they came in
    // under, and running recurring accounts keep theirs.
    req.flash('success', `Rank updated. It applies to leads referred from now on — `
      + 'anything already in flight keeps the terms it came in under.');
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

    // When the change takes effect, as distinct from when you clicked. "Senior
    // as of 1 August" is an ordinary thing to want to say, and the audit log
    // alone cannot express it — it only knows the moment of the click.
    const effectiveFrom = util.text(req.body.rank_effective_from, 10) || null;

    await db.query(
      `update campaign_members
          set commission_profile_id = $2,
              rank_effective_from = coalesce($3::date, current_date),
              rank_set_by = 'admin'
        where id = $1`,
      [member.id, newProfile ? newProfile.id : null, effectiveFrom]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'member.profile_changed',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${member.full_name || member.email} moved to "${newProfile ? newProfile.name : 'no rank'}" on ${member.campaign_name}`,
      before: { commission_profile: member.current_profile_name || null },
      after: {
        commission_profile: newProfile ? newProfile.name : null,
        effective_from: effectiveFrom || 'today',
      },
    });

    // Say what this does and does not touch. The natural assumption is that
    // moving someone to Senior makes their open leads pay Senior rates; it does
    // not, and finding that out from a payslip is the wrong way to learn it.
    req.flash('success', 'Commission rank updated. It applies to leads referred from now on — '
      + 'leads already in hand keep the rank they were referred under.');
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
