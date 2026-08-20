#!/usr/bin/env node
'use strict';

/**
 * Applies db/schema.sql (and db/policies.sql on Supabase) to DATABASE_URL.
 * Idempotent — run it after every deploy.
 *
 *   npm run db:push
 *   npm run db:push -- --yes     (skip the confirmation)
 *
 * It prints which project it is about to touch and, when that looks like
 * production, waits for you to confirm. Running a migration against the wrong
 * database is the expensive mistake in a two-environment setup, and it is
 * almost always caught by simply being made to look.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const db = require('../src/lib/db');
const config = require('../src/config');

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const skipPrompt = process.argv.includes('--yes') || process.argv.includes('-y');

  const target = config.db.projectRef || '(unrecognised host)';
  const host = (config.db.url.match(/@([^/:]+)/) || [])[1] || 'unknown host';

  console.log('');
  console.log(`  Environment : ${config.env}`);
  console.log(`  Project     : ${target}`);
  console.log(`  Host        : ${host}`);
  console.log('');

  const problems = config.validate();
  const mismatch = problems.find((p) => p.includes('different projects'));
  if (mismatch) {
    console.error(`  REFUSING TO RUN\n  ${mismatch}\n`);
    process.exit(1);
  }

  // Anything that is not obviously a local development run gets a confirmation.
  if (config.isProd && !skipPrompt) {
    console.log('  This looks like PRODUCTION (NODE_ENV=production).');
    const answer = await confirm(`  Type the project ref "${target}" to continue: `);
    if (answer !== String(target).toLowerCase()) {
      console.error('\n  Did not match. Nothing was changed.\n');
      process.exit(1);
    }
    console.log('');
  }

  console.log('→ applying db/schema.sql');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  console.log('  ok');

  // Everything added after the baseline lives in db/migrations, applied in
  // filename order. Each file is written to be idempotent, so this runs the
  // same way on a fresh database and on one that is already up to date — no
  // version table to get out of step with reality.
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      console.log(`→ applying db/migrations/${file}`);
      await db.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      console.log('  ok');
    }
    if (!files.length) console.log('→ no migrations to apply');
  }

  const hasAuth = await db.one("select 1 as ok from pg_namespace where nspname = 'auth' limit 1");

  if (hasAuth) {
    console.log('→ Supabase auth schema detected, applying db/policies.sql');
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'policies.sql'), 'utf8'));
    console.log('  ok');
  } else {
    console.log('→ no `auth` schema found — skipping RLS policies (not a Supabase database)');
  }

  const tables = await db.all(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`
  );
  console.log(`\n${tables.length} tables in public: ${tables.map((t) => t.table_name).join(', ')}`);
  console.log('\nSchema is up to date.');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
