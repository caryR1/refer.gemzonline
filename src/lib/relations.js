'use strict';

/**
 * How the referring agent knows the prospect.
 *
 * Set by the agent, never asked of the prospect. It exists so a caller can open
 * with "your sister Marcia suggested we speak" rather than a cold introduction.
 * The list is admin-editable; these are the defaults seeded on install.
 */

const db = require('./db');

const DEFAULTS = [
  { code: 'brother', label: 'Brother' },
  { code: 'sister', label: 'Sister' },
  { code: 'parent', label: 'Parent' },
  { code: 'child', label: 'Son / daughter' },
  { code: 'spouse', label: 'Spouse / partner' },
  { code: 'cousin', label: 'Cousin' },
  { code: 'other_family', label: 'Other family' },
  { code: 'close_friend', label: 'Close friend' },
  { code: 'friend', label: 'Friend' },
  { code: 'neighbour', label: 'Neighbour' },
  { code: 'coworker', label: 'Co-worker' },
  { code: 'former_coworker', label: 'Former co-worker' },
  { code: 'business_associate', label: 'Business associate' },
  { code: 'client', label: 'Client' },
  { code: 'church_member', label: 'Church member' },
  { code: 'teammate', label: 'Teammate' },
  { code: 'classmate', label: 'Classmate' },
  { code: 'acquaintance', label: 'Acquaintance' },
  { code: 'other', label: 'Other' },
];

/** Active options in display order. */
async function list(tenantId, { includeInactive = false } = {}) {
  return db.all(
    `select * from relation_options
      where tenant_id = $1 ${includeInactive ? '' : 'and active'}
      order by sort_order, label`,
    [tenantId]
  );
}

/** A code → label map, for rendering a lead row without a join. */
async function labelMap(tenantId) {
  const rows = await list(tenantId, { includeInactive: true });
  return Object.fromEntries(rows.map((r) => [r.code, r.label]));
}

async function labelFor(tenantId, code) {
  if (!code) return '';
  const row = await db.one(
    'select label from relation_options where tenant_id = $1 and code = $2',
    [tenantId, code]
  );
  return row ? row.label : code;
}

/** Seed the defaults. Idempotent. */
async function seedDefaults(tenantId) {
  for (let i = 0; i < DEFAULTS.length; i += 1) {
    const { code, label } = DEFAULTS[i];
    await db.query(
      `insert into relation_options (tenant_id, code, label, sort_order)
       values ($1,$2,$3,$4)
       on conflict (tenant_id, code) do nothing`,
      [tenantId, code, label, i * 10]
    );
  }
}

module.exports = { DEFAULTS, list, labelMap, labelFor, seedDefaults };
