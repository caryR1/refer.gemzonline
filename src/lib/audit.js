'use strict';

/**
 * Append-only audit trail.
 *
 * Covers the four areas agreed in the spec:
 *   - commission profile and rank changes
 *   - payment and commission status changes
 *   - lead status, appointment and consent changes (including prospect actions)
 *   - account, login and campaign membership events
 *
 * Never throws into the caller: a failed audit write is logged loudly but must
 * not roll back the business action that succeeded.
 */

const db = require('./db');

/** Only these keys are ever diffed, so we never log a password or token. */
const REDACT = new Set(['access_token', 'password', 'pass', 'token', 'secret']);

function clean(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (REDACT.has(k)) return;
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v !== undefined) out[k] = v;
  });
  return out;
}

/**
 * Return only the fields that actually changed, as { before, after }.
 * Keeps the log readable instead of dumping whole rows.
 */
function diff(before, after, fields) {
  const keys = fields || Array.from(new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]));
  const b = {};
  const a = {};
  keys.forEach((key) => {
    if (REDACT.has(key)) return;
    let bv = before ? before[key] : undefined;
    let av = after ? after[key] : undefined;
    if (bv instanceof Date) bv = bv.toISOString();
    if (av instanceof Date) av = av.toISOString();
    if (bv === undefined && av === undefined) return;
    if (String(bv ?? '') === String(av ?? '')) return;
    b[key] = bv ?? null;
    a[key] = av ?? null;
  });
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

/**
 * Write an audit entry.
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {object} [opts.req]        express request — pulls actor, IP, UA
 * @param {object} [opts.actor]      explicit actor { id, full_name, role }
 * @param {string} opts.action       e.g. 'commission.status_changed'
 * @param {string} opts.entityType   e.g. 'commission'
 * @param {string} [opts.entityId]
 * @param {string} [opts.summary]    human sentence for the audit list
 * @param {object} [opts.before]
 * @param {object} [opts.after]
 */
async function log(opts) {
  try {
    const req = opts.req;
    const actor = opts.actor || (req && req.user) || null;

    let actorType = opts.actorType;
    if (!actorType) {
      if (actor && actor.role === 'admin') actorType = 'admin';
      else if (actor && actor.role === 'agent') actorType = 'agent';
      else actorType = opts.prospect ? 'prospect' : 'system';
    }

    await db.query(
      `insert into audit_log
         (tenant_id, actor_id, actor_name, actor_type, action, entity_type,
          entity_id, summary, before, after, ip_address, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        opts.tenantId,
        actor && actor.id ? actor.id : null,
        opts.actorName || (actor ? actor.full_name || actor.email : null) || 'System',
        actorType,
        opts.action,
        opts.entityType,
        opts.entityId || null,
        opts.summary || null,
        opts.before ? JSON.stringify(clean(opts.before)) : null,
        opts.after ? JSON.stringify(clean(opts.after)) : null,
        opts.ip || (req ? req.ip : null),
        opts.userAgent || (req ? req.get('user-agent') : null),
      ]
    );
  } catch (err) {
    console.error('[audit] failed to write entry:', err.message, opts && opts.action);
  }
}

/** Convenience: log only if something actually changed. */
async function logDiff(opts, fields) {
  const d = diff(opts.before, opts.after, fields);
  if (!d.changed) return;
  await log({ ...opts, before: d.before, after: d.after });
}

/** Read the log with filters, for the admin screen. */
async function list(tenantId, { action, entityType, entityId, actorId, limit = 100, offset = 0 } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];

  if (action) { params.push(`%${action}%`); where.push(`action ilike $${params.length}`); }
  if (entityType) { params.push(entityType); where.push(`entity_type = $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`entity_id = $${params.length}`); }
  if (actorId) { params.push(actorId); where.push(`actor_id = $${params.length}`); }

  params.push(limit, offset);
  return db.all(
    `select * from audit_log where ${where.join(' and ')}
     order by created_at desc limit $${params.length - 1} offset $${params.length}`,
    params
  );
}

async function count(tenantId, { action, entityType, entityId, actorId } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  if (action) { params.push(`%${action}%`); where.push(`action ilike $${params.length}`); }
  if (entityType) { params.push(entityType); where.push(`entity_type = $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`entity_id = $${params.length}`); }
  if (actorId) { params.push(actorId); where.push(`actor_id = $${params.length}`); }
  const row = await db.one(`select count(*)::int as n from audit_log where ${where.join(' and ')}`, params);
  return row ? row.n : 0;
}

/** Actions that get a friendly label in the UI. */
const ACTION_LABELS = {
  'auth.signup': 'Account created',
  'auth.login': 'Signed in',
  'auth.password_changed': 'Password changed',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.role_changed': 'Role changed',
  'auth.status_changed': 'Account status changed',
  'member.joined': 'Joined campaign',
  'member.left': 'Left campaign',
  'member.removed': 'Removed from campaign',
  'member.profile_changed': 'Commission rank changed',
  'commission_profile.created': 'Commission profile created',
  'commission_profile.updated': 'Commission profile updated',
  'commission_profile.deleted': 'Commission profile deleted',
  'commission.created': 'Commission created',
  'commission.status_changed': 'Commission status changed',
  'commission.adjusted': 'Commission adjusted',
  'lead.created': 'Lead created',
  'lead.status_changed': 'Lead status changed',
  'lead.consent_given': 'Consent captured',
  'lead.appointment_changed': 'Appointment changed',
  'lead.rescheduled': 'Appointment rescheduled by prospect',
  'lead.cancelled': 'Cancelled by prospect',
  'lead.relation_changed': 'Relation updated',
  'lead.account_toggled': 'Recurring account toggled',
  'prefs.admin_changed': 'Notification preferences changed by admin',
  'campaign.created': 'Campaign created',
  'campaign.updated': 'Campaign updated',
};

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

module.exports = { log, logDiff, diff, list, count, actionLabel, ACTION_LABELS };
