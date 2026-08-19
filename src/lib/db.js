'use strict';

const { Pool } = require('pg');
const config = require('../config');

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!config.db.url) {
    throw new Error('DATABASE_URL is not configured.');
  }
  pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  });
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * Turn the two connection failures people actually hit into advice rather than
 * a bare errno. Both look like typos and are not.
 */
function explain(err) {
  if (!err || !err.message) return err;

  if (err.code === 'ENOTFOUND' && /db\..*\.supabase\.co/.test(err.message)) {
    err.message = `${err.message}\n\n`
      + '  That hostname is Supabase\'s DIRECT connection, which is IPv6-only\n'
      + '  unless you have their IPv4 add-on. On an IPv4-only network it has no\n'
      + '  address at all, hence ENOTFOUND.\n\n'
      + '  Use the SESSION POOLER string instead — Supabase dashboard ->\n'
      + '  Project Settings -> Database -> Connection string -> Session pooler.\n'
      + '  It looks like:\n'
      + '    postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n'
      + '  Note the username gains the project ref. Avoid the transaction pooler\n'
      + '  (port 6543): it does not support the prepared statements pg uses.';
  }

  if (err.code === '28P01') {
    err.message = `${err.message}\n\n`
      + '  Password rejected. If yours contains @ : / ? # or %, it must be\n'
      + '  URL-encoded inside DATABASE_URL (@ becomes %40).';
  }

  return err;
}

/** Run a query. Returns the pg result. */
async function query(text, params = []) {
  const started = Date.now();
  try {
    const res = await getPool().query(text, params);
    const ms = Date.now() - started;
    if (ms > 1000) console.warn(`[db] slow query (${ms}ms): ${text.slice(0, 120)}`);
    return res;
  } catch (err) {
    throw explain(err);
  }
}

/** Run a query and return all rows. */
async function all(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}

/** Run a query and return the first row (or null). */
async function one(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/** Run a set of statements inside a transaction. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  try {
    await query('select 1 as ok');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, all, one, tx, healthcheck, close, getPool };
