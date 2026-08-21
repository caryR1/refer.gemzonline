'use strict';

/**
 * The agent portal.
 *
 * Agents self-select campaigns (joining is instant), get a referral link per
 * campaign, work their own leads, set the relation that gives the call its
 * credibility, and watch their earnings. They can move a lead as far as
 * "appointment set" — closing is an admin action, because closing creates a
 * commission.
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
const relations = require('../lib/relations');
const commissions = require('../lib/commissions');
const ranks = require('../lib/ranks');
const payouts = require('../lib/payouts');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireUser);

/** Statuses an agent is allowed to set. Closing is admin-only. */
const AGENT_STATUSES = ['new', 'contacted', 'appointment_set'];

/** Load a lead the current user is allowed to see. */
async function loadLead(req, id) {
  const lead = await db.one('select * from leads where id = $1 and tenant_id = $2', [id, req.tenant.id]);
  if (!lead) return null;
  if (req.user.role !== 'admin' && lead.agent_id !== req.user.id) return null;
  return lead;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const agentId = req.user.id;

    const [pipeline, totals, memberships, recentLeads, upcoming] = await Promise.all([
      db.all(
        `select status, count(*)::int as n from leads
          where tenant_id = $1 and agent_id = $2 group by status`,
        [req.tenant.id, agentId]
      ),
      commissions.agentTotals(req.tenant.id, agentId),
      db.all(
        `select cm.*, c.name as campaign_name, c.slug as campaign_slug,
                cp.name as profile_name, rl.slug as link_slug
           from campaign_members cm
           join campaigns c on c.id = cm.campaign_id
           left join commission_profiles cp on cp.id = cm.commission_profile_id
           left join referral_links rl on rl.member_id = cm.id
          where cm.tenant_id = $1 and cm.agent_id = $2 and cm.status = 'active'
          order by c.name`,
        [req.tenant.id, agentId]
      ),
      db.all(
        `select l.*, c.name as campaign_name from leads l
           join campaigns c on c.id = l.campaign_id
          where l.tenant_id = $1 and l.agent_id = $2
          order by l.created_at desc limit 6`,
        [req.tenant.id, agentId]
      ),
      db.all(
        `select l.*, c.name as campaign_name from leads l
           join campaigns c on c.id = l.campaign_id
          where l.tenant_id = $1 and l.agent_id = $2
            and l.appointment_primary_at is not null
            and l.appointment_primary_at > now()
            and l.status not in ('closed_won','closed_lost')
          order by l.appointment_primary_at asc limit 5`,
        [req.tenant.id, agentId]
      ),
    ]);

    const counts = Object.fromEntries(pipeline.map((r) => [r.status, r.n]));
    const totalLeads = pipeline.reduce((sum, r) => sum + r.n, 0);
    const won = counts.closed_won || 0;

    res.render('agent/dashboard', {
      title: 'Dashboard',
      counts,
      totalLeads,
      won,
      conversion: totalLeads ? Math.round((won / totalLeads) * 100) : 0,
      totals,
      memberships,
      recentLeads,
      upcoming,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Campaigns — browse and join
// ---------------------------------------------------------------------------

router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await db.all(
      `select c.*,
              cm.id as membership_id, cm.status as membership_status,
              cm.rank_effective_from,
              cp.id as profile_id, cp.name as profile_name, cp.rank_order,
              cp.initial_type, cp.initial_value,
              cp.recurring_enabled, cp.recurring_type, cp.recurring_value,
              cp.recurring_months, cp.payout_day,
              -- Aliased on purpose: c.* already yields a deal_value, and an
              -- unaliased cp.deal_value would shadow it -- losing the campaign
              -- value in exactly the case that matters, where the rank inherits.
              cp.deal_value as rank_deal_value,
              rl.slug as link_slug,
              (select count(*) from commission_profiles x
                where x.campaign_id = c.id and x.status = 'active')::int as profile_count
         from campaigns c
         left join campaign_members cm
           on cm.campaign_id = c.id and cm.agent_id = $2 and cm.status = 'active'
         left join commission_profiles cp on cp.id = cm.commission_profile_id
         left join referral_links rl on rl.member_id = cm.id
        where c.tenant_id = $1 and c.status = 'active'
        order by (cm.id is not null) desc, c.name`,
      [req.tenant.id, req.user.id]
    );

    // What the next rank is, and how far off it is.
    //
    // A rank nobody can see the requirements for is decoration. Showing the
    // target and the current count is the whole reason for making promotion
    // automatic rather than a favour an admin remembers to do.
    await Promise.all(campaigns.map(async (c) => {
      c.deal_value_effective = (c.rank_deal_value === null || c.rank_deal_value === undefined)
        ? Number(c.deal_value || 0)
        : Number(c.rank_deal_value);

      if (!c.membership_id) return;

      const campaignRanks = await db.all(
        "select * from commission_profiles where campaign_id = $1 and status = 'active' order by rank_order",
        [c.id]
      );
      const promotable = campaignRanks.filter((r) => r.auto_promote
        && (Number(r.rank_order) || 0) > (Number(c.rank_order) || 0));
      if (!promotable.length) return;

      const stats = await commissions.agentCampaignStats(req.tenant.id, req.user.id, c.id);
      const next = promotable[0];

      c.progress = {
        name: next.name,
        requirement: ranks.requirementLabel(next, (n) => util.money(n, c.currency)),
        deals: { have: stats.closedDeals, need: next.promote_after_deals || null },
        earned: { have: stats.earned, need: next.promote_after_amount || null },
        rate: util.rateLabel(next.initial_type, next.initial_value, c.currency),
      };
    }));

    res.render('agent/campaigns', {
      title: 'Campaigns',
      campaigns,
      welcome: req.query.welcome === '1',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns/:id/join', async (req, res, next) => {
  try {
    const campaign = await db.one(
      "select * from campaigns where id = $1 and tenant_id = $2 and status = 'active'",
      [req.params.id, req.tenant.id]
    );
    if (!campaign) {
      req.flash('error', 'That campaign is not available.');
      return res.redirect('/agent/campaigns');
    }

    // Joining is instant. The campaign's default rank is assigned automatically.
    //
    // If no rank is marked default, fall back to the most junior active one
    // rather than leaving the agent unranked. An unranked agent can refer leads
    // perfectly well and then earns nothing, and nobody discovers it until the
    // deal closes — long after the work is done and much too late to be fair
    // about. Least seniority is the safe guess; an admin can raise it.
    const defaultProfile = await db.one(
      `select * from commission_profiles
        where campaign_id = $1 and status = 'active'
        order by is_default desc, rank_order asc, created_at asc
        limit 1`,
      [campaign.id]
    );

    const member = await db.one(
      `insert into campaign_members
         (tenant_id, campaign_id, agent_id, commission_profile_id, status,
          rank_effective_from, rank_set_by)
       values ($1,$2,$3,$4,'active', current_date, 'join')
       on conflict (campaign_id, agent_id)
       do update set status = 'active', left_at = null,
                     commission_profile_id = coalesce(campaign_members.commission_profile_id, excluded.commission_profile_id),
                     rank_effective_from = coalesce(campaign_members.rank_effective_from, current_date)
       returning *`,
      [req.tenant.id, campaign.id, req.user.id, defaultProfile ? defaultProfile.id : null]
    );

    // One referral link per membership, created on first join and reused after.
    const existingLink = await db.one('select * from referral_links where member_id = $1', [member.id]);
    if (!existingLink) {
      const base = util.slugify(`${(req.user.full_name || req.user.email).split(' ')[0]}-${campaign.slug}`, 'ref');
      let slug = `${base}-${util.token(4)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const clash = await db.one('select 1 from referral_links where tenant_id = $1 and slug = $2', [req.tenant.id, slug]);
        if (!clash) break;
        slug = `${base}-${util.token(5)}`;
      }
      await db.query(
        `insert into referral_links (tenant_id, member_id, campaign_id, agent_id, slug)
         values ($1,$2,$3,$4,$5)`,
        [req.tenant.id, member.id, campaign.id, req.user.id, slug]
      );
    } else if (!existingLink.active) {
      await db.query('update referral_links set active = true where id = $1', [existingLink.id]);
    }

    await audit.log({
      tenantId: req.tenant.id,
      req,
      action: 'member.joined',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${req.user.full_name || req.user.email} joined ${campaign.name}`,
      after: { campaign: campaign.name, commission_profile: defaultProfile ? defaultProfile.name : null },
    });

    if (!defaultProfile) {
      req.flash('info', `You have joined ${campaign.name}. An admin still needs to set your commission rank before anything can be earned.`);
    } else {
      req.flash('success', `You have joined ${campaign.name} on the ${defaultProfile.name} rank. Your link is ready.`);
    }
    return res.redirect('/agent/links');
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns/:id/leave', async (req, res, next) => {
  try {
    const member = await db.one(
      'select cm.*, c.name as campaign_name from campaign_members cm join campaigns c on c.id = cm.campaign_id where cm.campaign_id = $1 and cm.agent_id = $2 and cm.tenant_id = $3',
      [req.params.id, req.user.id, req.tenant.id]
    );
    if (!member) return res.redirect('/agent/campaigns');

    await db.query("update campaign_members set status = 'left', left_at = now() where id = $1", [member.id]);
    await db.query('update referral_links set active = false where member_id = $1', [member.id]);

    await audit.log({
      tenantId: req.tenant.id,
      req,
      action: 'member.left',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${req.user.full_name || req.user.email} left ${member.campaign_name}`,
    });

    req.flash('success', `You have left ${member.campaign_name}. Your existing leads and earnings are unaffected.`);
    return res.redirect('/agent/campaigns');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Referral links
// ---------------------------------------------------------------------------

router.get('/links', async (req, res, next) => {
  try {
    const links = await db.all(
      `select rl.*, c.name as campaign_name, c.slug as campaign_slug,
              c.landing_page_url, cp.name as profile_name,
              (select count(*) from leads l where l.referral_link_id = rl.id)::int as lead_count
         from referral_links rl
         join campaigns c on c.id = rl.campaign_id
         join campaign_members cm on cm.id = rl.member_id
         left join commission_profiles cp on cp.id = cm.commission_profile_id
        where rl.tenant_id = $1 and rl.agent_id = $2 and cm.status = 'active'
        order by c.name`,
      [req.tenant.id, req.user.id]
    );

    res.render('agent/links', { title: 'My links', links, appUrl: config.appUrl });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

router.get('/leads', async (req, res, next) => {
  try {
    const where = ['l.tenant_id = $1', 'l.agent_id = $2'];
    const params = [req.tenant.id, req.user.id];

    if (req.query.status) { params.push(req.query.status); where.push(`l.status = $${params.length}`); }
    if (req.query.campaign) { params.push(req.query.campaign); where.push(`l.campaign_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(l.first_name ilike $${params.length} or l.last_name ilike $${params.length}
                   or l.email ilike $${params.length} or l.reference ilike $${params.length})`);
    }

    const clause = where.join(' and ');
    const countRow = await db.one(`select count(*)::int as n from leads l where ${clause}`, params);
    const page = util.paginate(countRow.n, req.query.page, 25);

    params.push(page.perPage, page.offset);
    const leads = await db.all(
      `select l.*, c.name as campaign_name
         from leads l join campaigns c on c.id = l.campaign_id
        where ${clause}
        order by l.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params
    );

    const campaigns = await db.all(
      `select distinct c.id, c.name from campaigns c
         join campaign_members cm on cm.campaign_id = c.id
        where cm.agent_id = $1 order by c.name`,
      [req.user.id]
    );

    res.render('agent/leads', {
      title: 'My leads',
      leads,
      campaigns,
      page,
      relationMap: await relations.labelMap(req.tenant.id),
      basePath: '/agent/leads',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/leads/:id', async (req, res, next) => {
  try {
    const lead = await loadLead(req, req.params.id);
    if (!lead) return next();

    const [campaign, notes, messages, relationOptions, commissionRows] = await Promise.all([
      db.one('select * from campaigns where id = $1', [lead.campaign_id]),
      db.all('select * from lead_notes where lead_id = $1 order by created_at desc', [lead.id]),
      db.all('select * from notification_log where lead_id = $1 order by created_at desc limit 20', [lead.id]),
      relations.list(req.tenant.id),
      db.all('select * from commissions where lead_id = $1 order by period desc', [lead.id]),
    ]);

    res.render('agent/lead-detail', {
      title: `${lead.first_name} ${lead.last_name}`.trim() || lead.email,
      lead,
      campaign,
      notes,
      messages,
      relationOptions,
      commissionRows,
      agentStatuses: AGENT_STATUSES,
      isAdmin: req.user.role === 'admin',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/note', async (req, res, next) => {
  try {
    const lead = await loadLead(req, req.params.id);
    if (!lead) return next();

    const body = util.text(req.body.body, 4000);
    const kind = ['note', 'call', 'meeting'].includes(req.body.kind) ? req.body.kind : 'note';
    if (!body) {
      req.flash('error', 'Write something before saving the note.');
      return res.redirect(`/agent/leads/${lead.id}`);
    }

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,$5,$6)`,
      [req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email, kind, body]
    );

    if (kind === 'call' || kind === 'meeting') {
      await db.query('update leads set last_contacted_at = now() where id = $1', [lead.id]);
    }

    req.flash('success', 'Note added.');
    return res.redirect(`/agent/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/status', async (req, res, next) => {
  try {
    const lead = await loadLead(req, req.params.id);
    if (!lead) return next();

    const status = String(req.body.status || '');
    if (!AGENT_STATUSES.includes(status)) {
      req.flash('error', 'Closing a lead is an admin action. Leave a note and an admin will pick it up.');
      return res.redirect(`/agent/leads/${lead.id}`);
    }
    if (status === lead.status) return res.redirect(`/agent/leads/${lead.id}`);

    const updated = await db.one(
      // $2 is bound as TEXT and cast to the enum where it is assigned. Without
      // the cast Postgres deduces it two ways in one statement and refuses the
      // query with "inconsistent types deduced for parameter $2".
      `update leads set status = $2::lead_status,
              last_contacted_at = case when $2 = 'contacted' then now() else last_contacted_at end
        where id = $1::uuid returning *`,
      [lead.id, status]
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
      tenantId: req.tenant.id,
      req,
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `${lead.email}: ${lead.status} → ${status}`,
      before: { status: lead.status },
      after: { status },
    });

    if (status === 'contacted') {
      const campaign = await db.one('select * from campaigns where id = $1', [lead.campaign_id]);
      notify.fire('contacted', { tenantId: req.tenant.id, lead: updated, agent: req.user, campaign })
        .catch((err) => console.error('[notify] contacted failed:', err.message));
    }

    req.flash('success', 'Status updated.');
    return res.redirect(`/agent/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:id/relation', async (req, res, next) => {
  try {
    const lead = await loadLead(req, req.params.id);
    if (!lead) return next();

    const code = util.text(req.body.relation_code, 60) || null;
    const note = util.text(req.body.relation_note, 500) || null;

    await db.query('update leads set relation_code = $2, relation_note = $3 where id = $1',
      [lead.id, code, note]);

    const label = code ? await relations.labelFor(req.tenant.id, code) : 'not set';

    await db.query(
      `insert into lead_notes (tenant_id, lead_id, author_id, author_name, kind, body)
       values ($1,$2,$3,$4,'system',$5)`,
      [
        req.tenant.id, lead.id, req.user.id, req.user.full_name || req.user.email,
        `Relation set to "${label}".${note ? ` Context: ${note}` : ''}`,
      ]
    );

    await audit.log({
      tenantId: req.tenant.id,
      req,
      action: 'lead.relation_changed',
      entityType: 'lead',
      entityId: lead.id,
      summary: `Relation for ${lead.email} set to ${label}`,
      before: { relation_code: lead.relation_code, relation_note: lead.relation_note },
      after: { relation_code: code, relation_note: note },
    });

    req.flash('success', 'Relation saved — it will show on the call sheet.');
    return res.redirect(`/agent/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

router.get('/earnings', async (req, res, next) => {
  try {
    const [totals, rows, byPeriod] = await Promise.all([
      commissions.agentTotals(req.tenant.id, req.user.id),
      db.all(
        `select cm.*, c.name as campaign_name, l.reference, l.first_name, l.last_name
           from commissions cm
           join campaigns c on c.id = cm.campaign_id
           left join leads l on l.id = cm.lead_id
          where cm.tenant_id = $1 and cm.agent_id = $2
          order by cm.period desc, cm.created_at desc
          limit 300`,
        [req.tenant.id, req.user.id]
      ),
      db.all(
        `select period,
                sum(amount) filter (where status <> 'void') as total,
                sum(amount) filter (where status = 'paid') as paid,
                count(*)::int as entries
           from commissions
          where tenant_id = $1 and agent_id = $2
          group by period order by period desc limit 12`,
        [req.tenant.id, req.user.id]
      ),
    ]);

    res.render('agent/earnings', { title: 'Earnings', totals, rows, byPeriod });
  } catch (err) {
    next(err);
  }
});

router.get('/earnings.csv', async (req, res, next) => {
  try {
    const rows = await db.all(
      `select cm.period, c.name as campaign, l.reference, cm.kind, cm.amount,
              cm.currency, cm.rate_label, cm.status, cm.payout_date, cm.created_at
         from commissions cm
         join campaigns c on c.id = cm.campaign_id
         left join leads l on l.id = cm.lead_id
        where cm.tenant_id = $1 and cm.agent_id = $2
        order by cm.period desc`,
      [req.tenant.id, req.user.id]
    );

    const csv = stringify(
      rows.map((r) => ({
        Period: tz.periodLabel(r.period),
        Campaign: r.campaign,
        Reference: r.reference || '',
        Type: r.kind,
        Amount: Number(r.amount).toFixed(2),
        Currency: r.currency,
        Rate: r.rate_label || '',
        Status: r.status,
        'Payout date': r.payout_date ? tz.fmtDate(r.payout_date) : '',
        Created: tz.fmtShort(r.created_at, req.user.timezone),
      })),
      { header: true }
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="earnings-${tz.isoDate()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function profileView(req, extra = {}) {
  return {
    title: 'My profile',
    timezones: tz.COMMON_TIMEZONES,
    narrow: true,
    payoutSchemes: payouts.SCHEMES,
    currencies: payouts.CURRENCIES,
    payoutCountries: payouts.COMMON_COUNTRIES,
    holderTypes: payouts.HOLDER_TYPES,
    // The agent's own details, decrypted — this is the one screen entitled to
    // show them in full, because they are the person they belong to.
    payoutValues: payouts.reveal(req.user),
    payoutReady: config.payouts.keyPresent,
    payoutErrors: [],
    ...extra,
  };
}

router.get('/profile', (req, res) => {
  res.render('agent/profile', profileView(req));
});

router.post('/profile', async (req, res, next) => {
  try {
    const before = req.user;
    const after = {
      full_name: util.text(req.body.full_name, 120) || before.full_name,
      phone: util.text(req.body.phone, 40),
      whatsapp_number: util.text(req.body.whatsapp_number, 40),
      company: util.text(req.body.company, 120),
      country: util.text(req.body.country, 80),
      timezone: tz.safeZone(req.body.timezone, before.timezone),
    };

    await db.query(
      `update profiles set full_name = $2, phone = $3, whatsapp_number = $4,
              company = $5, country = $6, timezone = $7
        where id = $1`,
      [
        before.id, after.full_name, after.phone, after.whatsapp_number,
        after.company, after.country, after.timezone,
      ]
    );

    await audit.logDiff({
      tenantId: req.tenant.id,
      req,
      action: 'profile.updated',
      entityType: 'profile',
      entityId: before.id,
      summary: `${after.full_name} updated their profile`,
      before,
      after,
    }, ['full_name', 'phone', 'whatsapp_number', 'company', 'country', 'timezone']);

    req.flash('success', 'Profile saved.');
    return res.redirect('/agent/profile');
  } catch (err) {
    next(err);
  }
});

/**
 * "How should we pay you" — saved on its own, not as part of the profile form.
 *
 * Separate because the failure modes are different. A mistyped phone number is
 * a nuisance; a mistyped account number is a payment that goes somewhere else.
 * Its own submit means its own validation errors, its own audit entry, and no
 * chance of a rejected IBAN silently discarding an unrelated timezone change.
 */
router.post('/profile/payout', async (req, res, next) => {
  try {
    if (!config.payouts.keyPresent) {
      req.flash('error', 'Payout details cannot be saved yet — the server is missing its encryption key. Please tell an administrator.');
      return res.redirect('/agent/profile#payout');
    }

    const parsed = payouts.fromForm(req.body);

    if (parsed.errors.length) {
      // Re-render rather than redirect, so nothing typed is lost. The values
      // come back from the submission, not the database — they were never saved.
      return res.status(400).render('agent/profile', profileView(req, {
        payoutErrors: parsed.errors,
        payoutValues: Object.fromEntries(
          Object.entries(req.body)
            .filter(([k]) => k.startsWith('payout_'))
            .map(([k, v]) => [k.replace(/^payout_/, ''), v])
        ),
        payoutDraft: parsed.plain,
      }));
    }

    const before = payouts.summary(req.user);

    if (parsed.cleared) {
      await db.query(
        `update profiles
            set payout_method = null, payout_holder_name = null,
                payout_holder_type = 'personal', payout_bank_country = null,
                payout_currency = null, payout_addr_line1 = null,
                payout_addr_line2 = null, payout_addr_city = null,
                payout_addr_region = null, payout_addr_postal_code = null,
                payout_addr_country = null, payout_secrets = null,
                payout_last4 = null, payout_updated_at = now()
          where id = $1`,
        [req.user.id]
      );

      await audit.log({
        tenantId: req.tenant.id, req,
        action: 'payout.cleared',
        entityType: 'profile',
        entityId: req.user.id,
        summary: `${req.user.full_name || req.user.email} removed their payout details`,
        before,
      });

      req.flash('success', 'Payout details removed.');
      return res.redirect('/agent/profile#payout');
    }

    const { payout_secrets: secrets, payout_last4: last4 } =
      payouts.encryptSecrets(parsed.plain.payout_method, parsed.secrets);
    const p = parsed.plain;

    await db.query(
      `update profiles
          set payout_method = $2, payout_holder_name = $3, payout_holder_type = $4,
              payout_bank_country = $5, payout_currency = $6,
              payout_addr_line1 = $7, payout_addr_line2 = $8, payout_addr_city = $9,
              payout_addr_region = $10, payout_addr_postal_code = $11,
              payout_addr_country = $12, payout_secrets = $13, payout_last4 = $14,
              payout_updated_at = now()
        where id = $1`,
      [
        req.user.id, p.payout_method, p.payout_holder_name, p.payout_holder_type,
        p.payout_bank_country, p.payout_currency,
        p.payout_addr_line1, p.payout_addr_line2, p.payout_addr_city,
        p.payout_addr_region, p.payout_addr_postal_code, p.payout_addr_country,
        secrets, last4,
      ]
    );

    // Record THAT the details changed and to what method — never the numbers.
    // An audit log that quotes an account number is a second place to leak one.
    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'payout.updated',
      entityType: 'profile',
      entityId: req.user.id,
      summary: `${req.user.full_name || req.user.email} updated their payout details`,
      before,
      after: {
        method: p.payout_method,
        holder: p.payout_holder_name,
        currency: p.payout_currency,
        country: p.payout_bank_country,
        ends_with: last4 ? `••••${last4}` : '',
      },
    });

    req.flash('success', 'Payout details saved. Only you and an administrator can see them.');
    return res.redirect('/agent/profile#payout');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

router.get('/notifications', async (req, res, next) => {
  try {
    const prefs = await notify.prefsFor(req.tenant.id, req.user.id);
    res.render('agent/notifications', {
      title: 'Notifications',
      prefs,
      whatsappLive: config.whatsapp.configured,
      narrow: true,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/notifications', async (req, res, next) => {
  try {
    const body = req.body || {};
    let blockedAttempts = 0;

    for (const evt of events.staffEvents()) {
      for (const channel of ['email', 'whatsapp']) {
        const wanted = util.bool(body[`${evt.key}__${channel}`]);
        const result = await notify.setUserPref(req.tenant.id, req.user.id, evt.key, channel, wanted);
        if (!result.ok && result.blocked && wanted) blockedAttempts += 1;
      }
    }

    if (blockedAttempts) {
      req.flash('info', 'Some switches are turned off by an administrator and cannot be turned back on.');
    }
    req.flash('success', 'Notification preferences saved.');
    return res.redirect('/agent/notifications');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
