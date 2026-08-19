'use strict';

/** Admin: agents — list, detail, role and status, memberships, preferences. */

const express = require('express');

const config = require('../config');
const db = require('../lib/db');
const tz = require('../lib/tz');
const util = require('../lib/util');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const events = require('../lib/events');
const users = require('../lib/users');
const commissions = require('../lib/commissions');
const { getAdminClient } = require('../lib/supabase');

const router = express.Router();

router.get('/agents', async (req, res, next) => {
  try {
    const filters = {
      search: util.text(req.query.q, 120),
      role: ['admin', 'agent'].includes(req.query.role) ? req.query.role : null,
      status: ['active', 'suspended'].includes(req.query.status) ? req.query.status : null,
    };

    const total = await users.countAgents(req.tenant.id, filters);
    const page = util.paginate(total, req.query.page, 30);
    const agents = await users.listAgents(req.tenant.id, {
      ...filters, limit: page.perPage, offset: page.offset,
    });

    res.render('admin/agents', {
      title: 'Agents',
      agents,
      page,
      basePath: '/admin/agents',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/agents/new', (req, res) => {
  res.render('admin/agent-new', { title: 'Add an agent', narrow: true, timezones: tz.COMMON_TIMEZONES, defaultTimezone: config.staffTimezone });
});

router.post('/agents', async (req, res, next) => {
  try {
    const email = util.text(req.body.email, 200).toLowerCase();
    const fullName = util.text(req.body.full_name, 120);
    const password = String(req.body.password || '');
    const role = req.body.role === 'admin' ? 'admin' : 'agent';
    const timezone = tz.safeZone(req.body.timezone, config.staffTimezone);

    if (!util.isEmail(email) || password.length < 8) {
      req.flash('error', 'A valid email and a password of at least 8 characters are required.');
      return res.redirect('/admin/agents/new');
    }

    const supabase = getAdminClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });

    if (error) {
      req.flash('error', /already|exists|registered/i.test(error.message)
        ? 'Someone already has an account with that email.'
        : error.message);
      return res.redirect('/admin/agents/new');
    }

    await db.query(
      `insert into profiles (id, tenant_id, email, full_name, role, timezone, status)
       values ($1,$2,$3,$4,$5,$6,'active')
       on conflict (id) do update set role = excluded.role, full_name = excluded.full_name`,
      [data.user.id, req.tenant.id, email, fullName, role, timezone]
    );

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'auth.signup',
      entityType: 'profile',
      entityId: data.user.id,
      summary: `${req.user.full_name} created an account for ${email} as ${role}`,
      after: { email, full_name: fullName, role },
    });

    req.flash('success', `${fullName || email} can now sign in.`);
    return res.redirect(`/admin/agents/${data.user.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/agents/:id', async (req, res, next) => {
  try {
    const agent = await db.one('select * from profiles where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!agent) return next();

    const [memberships, totals, leadStats, availableCampaigns, prefs, recentLeads] = await Promise.all([
      db.all(
        `select cm.*, c.name as campaign_name, c.id as campaign_id,
                cp.name as profile_name, cp.id as profile_id, rl.slug as link_slug,
                (select count(*) from leads l where l.campaign_id = cm.campaign_id and l.agent_id = cm.agent_id)::int as lead_count
           from campaign_members cm
           join campaigns c on c.id = cm.campaign_id
           left join commission_profiles cp on cp.id = cm.commission_profile_id
           left join referral_links rl on rl.member_id = cm.id
          where cm.agent_id = $1 and cm.status = 'active'
          order by c.name`,
        [agent.id]
      ),
      commissions.agentTotals(req.tenant.id, agent.id),
      db.all('select status, count(*)::int as n from leads where agent_id = $1 group by status', [agent.id]),
      db.all(
        `select c.id, c.name,
                (select json_agg(json_build_object('id', cp.id, 'name', cp.name) order by cp.rank_order, cp.name)
                   from commission_profiles cp where cp.campaign_id = c.id and cp.status = 'active') as profiles
           from campaigns c
          where c.tenant_id = $1 and c.status = 'active'
          order by c.name`,
        [req.tenant.id]
      ),
      notify.prefsFor(req.tenant.id, agent.id),
      db.all(
        `select l.*, c.name as campaign_name from leads l join campaigns c on c.id = l.campaign_id
          where l.agent_id = $1 order by l.created_at desc limit 10`,
        [agent.id]
      ),
    ]);

    res.render('admin/agent-detail', {
      title: agent.full_name || agent.email,
      agent,
      memberships,
      totals,
      counts: Object.fromEntries(leadStats.map((r) => [r.status, r.n])),
      availableCampaigns,
      prefs,
      recentLeads,
      whatsappLive: config.whatsapp.configured,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/agents/:id/role', async (req, res, next) => {
  try {
    const agent = await db.one('select * from profiles where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!agent) return next();

    const role = req.body.role === 'admin' ? 'admin' : 'agent';

    // Never let the last admin demote themselves out of the building.
    if (agent.role === 'admin' && role === 'agent') {
      const admins = await db.one(
        "select count(*)::int as n from profiles where tenant_id = $1 and role = 'admin' and status = 'active'",
        [req.tenant.id]
      );
      if (admins.n <= 1) {
        req.flash('error', 'This is the only active admin. Promote someone else first.');
        return res.redirect(`/admin/agents/${agent.id}`);
      }
    }

    await db.query('update profiles set role = $2 where id = $1', [agent.id, role]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'auth.role_changed',
      entityType: 'profile',
      entityId: agent.id,
      summary: `${agent.full_name || agent.email}: ${agent.role} → ${role}`,
      before: { role: agent.role }, after: { role },
    });

    req.flash('success', 'Role updated.');
    return res.redirect(`/admin/agents/${agent.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/agents/:id/status', async (req, res, next) => {
  try {
    const agent = await db.one('select * from profiles where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!agent) return next();

    const status = req.body.status === 'suspended' ? 'suspended' : 'active';

    if (agent.id === req.user.id && status === 'suspended') {
      req.flash('error', 'You cannot suspend your own account.');
      return res.redirect(`/admin/agents/${agent.id}`);
    }

    await db.query('update profiles set status = $2 where id = $1', [agent.id, status]);

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'auth.status_changed',
      entityType: 'profile',
      entityId: agent.id,
      summary: `${agent.full_name || agent.email} ${status === 'suspended' ? 'suspended' : 'reactivated'}`,
      before: { status: agent.status }, after: { status },
    });

    req.flash('success', status === 'suspended' ? 'Account suspended.' : 'Account reactivated.');
    return res.redirect(`/admin/agents/${agent.id}`);
  } catch (err) {
    next(err);
  }
});

/** Put an agent onto a campaign directly, on a chosen rank. */
router.post('/agents/:id/memberships', async (req, res, next) => {
  try {
    const agent = await db.one('select * from profiles where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!agent) return next();

    const campaignId = util.text(req.body.campaign_id);
    const profileId = util.text(req.body.commission_profile_id) || null;

    const campaign = await db.one('select * from campaigns where id = $1 and tenant_id = $2', [campaignId, req.tenant.id]);
    if (!campaign) {
      req.flash('error', 'Choose a campaign.');
      return res.redirect(`/admin/agents/${agent.id}`);
    }

    let profile = null;
    if (profileId) {
      profile = await db.one('select * from commission_profiles where id = $1 and campaign_id = $2', [profileId, campaign.id]);
    }
    if (!profile) {
      profile = await db.one("select * from commission_profiles where campaign_id = $1 and is_default and status = 'active'", [campaign.id]);
    }

    const member = await db.one(
      `insert into campaign_members (tenant_id, campaign_id, agent_id, commission_profile_id, status)
       values ($1,$2,$3,$4,'active')
       on conflict (campaign_id, agent_id)
       do update set status='active', left_at=null, commission_profile_id=excluded.commission_profile_id
       returning *`,
      [req.tenant.id, campaign.id, agent.id, profile ? profile.id : null]
    );

    const existingLink = await db.one('select * from referral_links where member_id = $1', [member.id]);
    if (!existingLink) {
      const base = util.slugify(`${(agent.full_name || agent.email).split(' ')[0]}-${campaign.slug}`, 'ref');
      let slug = `${base}-${util.token(4)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const clash = await db.one('select 1 from referral_links where tenant_id = $1 and slug = $2', [req.tenant.id, slug]);
        if (!clash) break;
        slug = `${base}-${util.token(5)}`;
      }
      await db.query(
        'insert into referral_links (tenant_id, member_id, campaign_id, agent_id, slug) values ($1,$2,$3,$4,$5)',
        [req.tenant.id, member.id, campaign.id, agent.id, slug]
      );
    } else if (!existingLink.active) {
      await db.query('update referral_links set active = true where id = $1', [existingLink.id]);
    }

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'member.joined',
      entityType: 'campaign_member',
      entityId: member.id,
      summary: `${req.user.full_name} added ${agent.full_name || agent.email} to ${campaign.name}`,
      after: { campaign: campaign.name, commission_profile: profile ? profile.name : null },
    });

    req.flash('success', `Added to ${campaign.name}${profile ? ` on the ${profile.name} rank` : ''}.`);
    return res.redirect(`/admin/agents/${agent.id}`);
  } catch (err) {
    next(err);
  }
});

/**
 * Admin control of another user's notification preferences.
 * Unchecking here is a HARD BLOCK — the user cannot switch it back on.
 */
router.post('/agents/:id/notifications', async (req, res, next) => {
  try {
    const agent = await db.one('select * from profiles where id = $1 and tenant_id = $2', [req.params.id, req.tenant.id]);
    if (!agent) return next();

    const changed = [];
    for (const evt of events.staffEvents()) {
      for (const channel of ['email', 'whatsapp']) {
        const allowed = util.bool(req.body[`${evt.key}__${channel}`]);
        await notify.setAdminPref(req.tenant.id, agent.id, evt.key, channel, allowed);
        if (!allowed) changed.push(`${evt.label} (${channel})`);
      }
    }

    await audit.log({
      tenantId: req.tenant.id, req,
      action: 'prefs.admin_changed',
      entityType: 'profile',
      entityId: agent.id,
      summary: changed.length
        ? `${req.user.full_name} blocked ${changed.length} notification channel${changed.length === 1 ? '' : 's'} for ${agent.full_name || agent.email}`
        : `${req.user.full_name} unblocked all notification channels for ${agent.full_name || agent.email}`,
      after: { blocked: changed },
    });

    req.flash('success', 'Notification permissions saved. Anything you unticked is now blocked for this user.');
    return res.redirect(`/admin/agents/${agent.id}#notifications`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
