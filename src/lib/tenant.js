'use strict';

/**
 * Tenant resolution.
 *
 * The app runs single-tenant today, but every query is scoped through this
 * module. That means there is exactly ONE place that decides which tenant a
 * request belongs to — so turning this into a multi-tenant product later means
 * changing `resolve()` (to read a subdomain, a header, or the session) rather
 * than auditing a hundred queries.
 */

const db = require('./db');
const config = require('../config');

let cached = null;

/** The active tenant, created on first use. */
async function current() {
  if (cached) return cached;

  let row = await db.one('select * from tenants where slug = $1', [config.tenantSlug]);

  if (!row) {
    row = await db.one(
      `insert into tenants (name, slug) values ($1, $2)
       on conflict (slug) do update set name = excluded.name
       returning *`,
      [config.tenantName, config.tenantSlug]
    );
  }

  cached = row;
  return cached;
}

/** The active tenant id — the value every query filters on. */
async function currentId() {
  const t = await current();
  return t.id;
}

/**
 * Resolve the tenant for a request. Single-tenant today; the signature already
 * takes the request so multi-tenant routing drops in here.
 */
async function resolve(_req) {
  return current();
}

function clearCache() {
  cached = null;
}

module.exports = { current, currentId, resolve, clearCache };
