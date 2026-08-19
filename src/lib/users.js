'use strict';

/**
 * Profile provisioning.
 *
 * Google SSO is open self-registration: any Google account that signs in gets
 * an active agent profile with no campaigns. The first ever user of a fresh
 * install becomes the admin, so a new deployment is never locked out.
 */

const db = require('./db');
const config = require('../config');
const audit = require('./audit');
const { safeZone } = require('./tz');

/**
 * Find the profile for an authenticated Supabase user, creating it on first
 * sign-in.
 *
 * @param {object} authUser  Supabase auth user
 * @param {string} tenantId
 * @param {object} [opts]    { provider, req }
 */
async function ensureProfile(authUser, tenantId, opts = {}) {
  if (!authUser || !authUser.id) throw new Error('No authenticated user.');

  const existing = await db.one('select * from profiles where id = $1', [authUser.id]);
  if (existing) {
    await db.query('update profiles set last_login_at = now() where id = $1', [authUser.id]);
    return { profile: existing, created: false };
  }

  const meta = authUser.user_metadata || {};
  const email = authUser.email || meta.email || '';
  const fullName = meta.full_name || meta.name
    || [meta.given_name, meta.family_name].filter(Boolean).join(' ')
    || (email ? email.split('@')[0] : '');

  // First user on a fresh install becomes admin — otherwise nobody could ever
  // sign in to promote anyone.
  const staffCount = await db.one('select count(*)::int as n from profiles where tenant_id = $1', [tenantId]);
  const role = staffCount && staffCount.n === 0 ? 'admin' : 'agent';

  const profile = await db.one(
    `insert into profiles
       (id, tenant_id, email, full_name, role, avatar_url, auth_provider, timezone, status, last_login_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'active',now())
     on conflict (id) do update set last_login_at = now()
     returning *`,
    [
      authUser.id, tenantId, email, fullName, role,
      meta.avatar_url || meta.picture || null,
      opts.provider || 'password',
      safeZone(opts.timezone, config.staffTimezone),
    ]
  );

  await audit.log({
    tenantId,
    req: opts.req,
    actor: profile,
    actorType: role === 'admin' ? 'admin' : 'agent',
    action: 'auth.signup',
    entityType: 'profile',
    entityId: profile.id,
    summary: `${fullName || email} signed up via ${opts.provider || 'password'}${role === 'admin' ? ' and became the first admin' : ''}`,
    after: { email, full_name: fullName, role, auth_provider: opts.provider || 'password' },
  });

  return { profile, created: true };
}

/** Record a sign-in in the audit trail. */
async function recordLogin(profile, tenantId, req, provider) {
  await db.query('update profiles set last_login_at = now() where id = $1', [profile.id]);
  await audit.log({
    tenantId,
    req,
    actor: profile,
    action: 'auth.login',
    entityType: 'profile',
    entityId: profile.id,
    summary: `${profile.full_name || profile.email} signed in${provider ? ` via ${provider}` : ''}`,
  });
}

/** Agents with their campaign counts — the admin list. */
async function listAgents(tenantId, { search, role, status, limit = 50, offset = 0 } = {}) {
  const where = ['p.tenant_id = $1'];
  const params = [tenantId];

  if (search) {
    params.push(`%${search}%`);
    where.push(`(p.full_name ilike $${params.length} or p.email ilike $${params.length})`);
  }
  if (role) { params.push(role); where.push(`p.role = $${params.length}`); }
  if (status) { params.push(status); where.push(`p.status = $${params.length}`); }

  params.push(limit, offset);
  return db.all(
    `select p.*,
            (select count(*) from campaign_members cm
              where cm.agent_id = p.id and cm.status = 'active')::int as campaign_count,
            (select count(*) from leads l where l.agent_id = p.id)::int as lead_count,
            (select coalesce(sum(c.amount), 0) from commissions c
              where c.agent_id = p.id and c.status <> 'void')::numeric as earned
       from profiles p
      where ${where.join(' and ')}
      order by p.created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
}

async function countAgents(tenantId, { search, role, status } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(full_name ilike $${params.length} or email ilike $${params.length})`);
  }
  if (role) { params.push(role); where.push(`role = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const row = await db.one(`select count(*)::int as n from profiles where ${where.join(' and ')}`, params);
  return row ? row.n : 0;
}

module.exports = { ensureProfile, recordLogin, listAgents, countAgents };
