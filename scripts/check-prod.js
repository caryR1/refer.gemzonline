#!/usr/bin/env node
'use strict';

/**
 * Production readiness check.
 *
 *   npm run check:prod
 *
 * Answers one question: if this configuration were serving real traffic right
 * now, what would be wrong with it?
 *
 * Run it against the environment you are about to deploy — locally with the
 * production values loaded, or on the server itself. It reads configuration and
 * makes at most one round trip each to the database, Supabase and SMTP. It
 * changes nothing.
 *
 * Exit code 1 if anything would actually break, 0 otherwise. Warnings do not
 * fail the run — a deployment without WhatsApp configured is perfectly valid,
 * a deployment that emails links to localhost is not.
 */

const config = require('../src/config');

const results = [];

function record(level, title, detail) {
  results.push({ level, title, detail });
}

const pass = (title, detail) => record('pass', title, detail);
const warn = (title, detail) => record('warn', title, detail);
const fail = (title, detail) => record('fail', title, detail);

async function main() {
  const prod = config.isProd;

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------
  if (prod) pass('NODE_ENV', 'production');
  else {
    warn('NODE_ENV', `"${config.env}" — this check is most useful with the production values loaded. `
      + 'In development, stack traces are shown to visitors and cookies are not marked secure.');
  }

  // -------------------------------------------------------------------------
  // Public address — the one that silently ruins outbound email
  // -------------------------------------------------------------------------
  if (!config.appUrlExplicit) {
    (prod ? fail : warn)('APP_URL', `not set, falling back to ${config.appUrl}. `
      + 'Every referral and appointment link emailed to a prospect is built from this.');
  } else if (config.appUrlIsLocal) {
    (prod ? fail : pass)('APP_URL', `${config.appUrl}${prod ? ' — a development address. Emailed links would be dead.' : ''}`);
  } else if (!config.appUrl.startsWith('https://')) {
    warn('APP_URL', `${config.appUrl} — not https. Links will work but are insecure.`);
  } else {
    pass('APP_URL', config.appUrl);
  }

  if (config.linksUsable) pass('Outbound links', 'reachable from outside this server');
  else fail('Outbound links', 'the mailer will refuse to send rather than post dead links to prospects');

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------
  if (config.sessionSecret === 'insecure-dev-secret-change-me') {
    (prod ? fail : warn)('SESSION_SECRET', 'still the built-in default. Generate one: openssl rand -hex 48');
  } else if (config.sessionSecret.length < 32) {
    warn('SESSION_SECRET', `only ${config.sessionSecret.length} characters — use at least 64.`);
  } else {
    pass('SESSION_SECRET', `set, ${config.sessionSecret.length} characters`);
  }

  const cryptoLib = require('../src/lib/crypto');
  if (!cryptoLib.isConfigured()) {
    fail('PAYOUT_ENCRYPTION_KEY', `${cryptoLib.keyProblem()} Agents cannot save bank details without it.`);
  } else {
    // Prove it actually works rather than merely being present and the right
    // length — a truncated paste passes a length check and fails at use.
    try {
      const probe = 'readiness-probe';
      if (cryptoLib.decrypt(cryptoLib.encrypt(probe)) !== probe) throw new Error('round trip mismatch');
      pass('PAYOUT_ENCRYPTION_KEY', 'set, and encrypts and decrypts correctly');
    } catch (err) {
      fail('PAYOUT_ENCRYPTION_KEY', `present but unusable: ${err.message}`);
    }
  }

  if (prod && !config.trustProxy) {
    fail('TRUST_PROXY', 'off behind a reverse proxy — secure cookies, rate limiting and audit IPs all misbehave');
  } else {
    pass('TRUST_PROXY', config.trustProxy ? 'on' : 'off (correct only with no proxy in front)');
  }

  // -------------------------------------------------------------------------
  // Supabase and the database must be the same project
  // -------------------------------------------------------------------------
  const authRef = config.supabase.projectRef;
  const dataRef = config.db.projectRef;

  if (!config.supabase.url) fail('SUPABASE_URL', 'not set — nobody can sign in');
  else if (authRef && dataRef && authRef !== dataRef) {
    fail('Supabase project', `auth is "${authRef}" but the database is "${dataRef}" — take every value from one project`);
  } else {
    pass('Supabase project', dataRef || authRef || 'set');
  }

  if (!config.db.url) {
    fail('DATABASE_URL', 'not set — every page will error');
  } else if (/:6543\//.test(config.db.url)) {
    fail('DATABASE_URL', 'port 6543 is the transaction pooler, which cannot do prepared statements. Use the session pooler on 5432.');
  } else if (/@db\.[a-z0-9]+\.supabase\./.test(config.db.url)) {
    warn('DATABASE_URL', 'a direct Supabase connection — IPv6 only unless you have the IPv4 add-on. The session pooler is safer.');
  } else {
    pass('DATABASE_URL', `${(config.db.url.match(/@([^/:]+)/) || [])[1] || 'set'}${config.db.ssl ? ' (SSL on)' : ''}`);
  }

  if (!config.supabase.anonKey) fail('Supabase publishable key', 'not set — sign-in will not work');
  if (!config.supabase.serviceRoleKey) fail('Supabase secret key', 'not set — accounts cannot be created');

  if (config.supabase.anonKey && config.supabase.serviceRoleKey) {
    try {
      const supabase = require('../src/lib/supabase');
      const check = await supabase.verify();
      if (check.ok) pass('Supabase keys', 'verified against the project the URL names');
      else fail('Supabase keys', check.error);
    } catch (err) {
      warn('Supabase keys', `could not check: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Database reachability
  // -------------------------------------------------------------------------
  if (config.db.url) {
    const db = require('../src/lib/db');
    const health = await db.healthcheck();
    if (health.ok) pass('Database', 'reachable');
    else fail('Database', health.error);
    await db.close().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Email
  // -------------------------------------------------------------------------
  if (!config.smtp.configured) {
    (prod ? fail : warn)('SMTP', 'not fully configured — no welcome mail, no reminders, no commission alerts');
  } else {
    try {
      const mailer = require('../src/lib/mailer');
      const check = await mailer.verify();
      if (check.ok) pass('SMTP', `${config.smtp.host} as ${config.smtp.user}`);
      else fail('SMTP', check.error);
      mailer.close();
    } catch (err) {
      warn('SMTP', `could not check: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Optional, and fine to be off
  // -------------------------------------------------------------------------
  if (config.whatsapp.enabled && !config.whatsapp.configured) {
    fail('WhatsApp', 'enabled but the credentials are incomplete — sends will be skipped silently');
  } else {
    pass('WhatsApp', config.whatsapp.configured ? `${config.whatsapp.provider}, configured` : 'off');
  }

  pass('Scheduled jobs', config.cron.enabled ? `on, daily at ${config.cron.jobHour}:00 ${config.staffTimezone}` : 'OFF — no reminders will be sent');
  if (!config.cron.enabled && prod) {
    warn('Scheduled jobs', 'ENABLE_CRON is off in production, so appointment reminders never fire');
  }

  pass('Analytics', config.analytics.ga4Id || 'not set (public referral pages only)');

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const mark = { pass: ' ok ', warn: 'warn', fail: 'FAIL' };
  const width = Math.max(...results.map((r) => r.title.length));

  console.log(`\n  refer.GemzOnline — production readiness\n`);
  results.forEach((r) => {
    console.log(`  [${mark[r.level]}]  ${r.title.padEnd(width)}  ${r.detail}`);
  });

  const failures = results.filter((r) => r.level === 'fail');
  const warnings = results.filter((r) => r.level === 'warn');

  console.log('');
  if (failures.length) {
    console.log(`  ${failures.length} problem${failures.length === 1 ? '' : 's'} would break this deployment.`);
    if (warnings.length) console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} worth a look.`);
    console.log('');
    process.exit(1);
  }

  console.log(warnings.length
    ? `  Ready to serve, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.\n`
    : '  Ready to serve.\n');
}

main().catch((err) => {
  console.error('\n  The check itself failed:', err.stack || err.message, '\n');
  process.exit(1);
});
