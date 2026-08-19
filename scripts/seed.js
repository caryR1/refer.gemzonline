#!/usr/bin/env node
'use strict';

/**
 * Starter data: the tenant, relationship options, the default message
 * templates, and optionally a sample campaign.
 *
 *   npm run db:seed
 *   npm run db:seed -- --sample     (also creates the demo campaign)
 *
 * Idempotent. The same work is available without a terminal from
 * Admin → Settings → Install defaults, which is the route to use on hosting
 * that gives you no shell.
 */

const db = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const setup = require('../src/lib/setup');
const config = require('../src/config');

async function main() {
  const withSample = process.argv.includes('--sample');

  const t = await tenant.current();
  console.log(`Tenant: ${t.name} (${t.slug})`);

  const before = await setup.status(t.id);
  const result = await setup.installAll(t.id, { sampleCampaign: withSample });
  const after = await setup.status(t.id);

  console.log(`Relationship options: ${after.relations.installed} (${result.relations} added)`);
  console.log(`Message templates:    ${after.templates.installed} (${result.templates} added)`);

  if (withSample) {
    console.log(result.campaign
      ? `Sample campaign:      created — ${config.appUrl}/r/${setup.CAMPAIGN.slug}`
      : 'Sample campaign:      already present');
  } else {
    console.log('Sample campaign:      skipped (pass --sample to create it)');
  }

  if (before.needsSetup && !after.needsSetup) {
    console.log('\nFirst-run setup complete.');
  } else {
    console.log('\nUp to date.');
  }

  console.log('\nSign in at ' + config.appUrl + '/login — the first account created becomes an admin.');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
