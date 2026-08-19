#!/usr/bin/env node
'use strict';

/**
 * Applies db/schema.sql (and db/policies.sql when the target is a Supabase
 * database) to DATABASE_URL. Idempotent — run it after every deploy.
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/lib/db');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const policiesPath = path.join(__dirname, '..', 'db', 'policies.sql');

  console.log('→ applying db/schema.sql');
  await db.query(fs.readFileSync(schemaPath, 'utf8'));
  console.log('  ok');

  const hasAuth = await db.one(
    "select 1 as ok from pg_namespace where nspname = 'auth' limit 1"
  );

  if (hasAuth) {
    console.log('→ Supabase auth schema detected, applying db/policies.sql');
    await db.query(fs.readFileSync(policiesPath, 'utf8'));
    console.log('  ok');
  } else {
    console.log('→ no `auth` schema found — skipping RLS policies (not a Supabase database)');
  }

  const tables = await db.all(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`
  );
  console.log(`\nTables in public: ${tables.map((t) => t.table_name).join(', ')}`);
  console.log('\nSchema is up to date.');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
