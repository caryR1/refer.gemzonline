#!/usr/bin/env node
'use strict';

/**
 * Create or promote an admin.
 *
 *   npm run create:admin -- you@example.com "Your Name" "StrongPassword123!"
 *
 * Creates the Supabase Auth user with the email already confirmed, then writes
 * the matching profile with role = admin. Re-running with an existing email
 * promotes that user instead of failing.
 */

const readline = require('readline');
const db = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const config = require('../src/config');
const { getAdminClient } = require('../src/lib/supabase');

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      const onData = () => {
        process.stdout.write(`\x1B[2K\x1B[200D${question}${'*'.repeat(rl.line.length)}`);
      };
      process.stdin.on('data', onData);
      rl.on('close', () => process.stdin.removeListener('data', onData));
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function findAuthUser(supabase, email) {
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = (data.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (!data.users || data.users.length < 200) return null;
    page += 1;
  }
}

async function main() {
  let [email, fullName, password] = process.argv.slice(2);

  if (!email) email = await ask('Admin email: ');
  if (!fullName) fullName = await ask('Full name: ');
  if (!password) password = await ask('Password (min 8 chars): ', { silent: true });

  if (!email || !password || password.length < 8) {
    throw new Error('An email and a password of at least 8 characters are required.');
  }

  const t = await tenant.current();
  const supabase = getAdminClient();

  let userId = null;
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName || '' },
  });

  if (createError) {
    if (!/already|exists|registered|duplicate/i.test(createError.message)) throw createError;
    console.log('That email already exists in Supabase Auth — updating it instead.');
    userId = await findAuthUser(supabase, email);
    if (!userId) throw new Error(`Could not locate the existing auth user for ${email}.`);
    await supabase.auth.admin.updateUserById(userId, { password, email_confirm: true });
  } else {
    userId = created.user.id;
  }

  await db.query(
    `insert into profiles (id, tenant_id, email, full_name, role, timezone, status)
     values ($1,$2,$3,$4,'admin',$5,'active')
     on conflict (id) do update
       set role = 'admin',
           status = 'active',
           tenant_id = excluded.tenant_id,
           email = excluded.email,
           full_name = coalesce(nullif(excluded.full_name, ''), profiles.full_name)`,
    [userId, t.id, email, fullName || '', config.staffTimezone]
  );

  console.log(`\nAdmin ready: ${email}`);
  console.log(`Tenant: ${t.name} (${t.slug})`);
  console.log(`Sign in at ${config.appUrl}/login`);
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
