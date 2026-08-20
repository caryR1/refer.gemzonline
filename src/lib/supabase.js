'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const noStore = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};

let anonClient = null;
let adminClient = null;

/** Client using the public anon key — used for sign-in / password reset flows. */
function getAnonClient() {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).');
  }
  if (!anonClient) {
    anonClient = createClient(config.supabase.url, config.supabase.anonKey, noStore);
  }
  return anonClient;
}

/** Client using the service role key — SERVER ONLY. Used for user admin ops. */
function getAdminClient() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error('Supabase service role is not configured (SUPABASE_SERVICE_ROLE_KEY).');
  }
  if (!adminClient) {
    adminClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, noStore);
  }
  return adminClient;
}

function isConfigured() {
  return Boolean(config.supabase.url && config.supabase.anonKey);
}

/**
 * Check that the keys actually belong to the project SUPABASE_URL names.
 *
 * Worth its own check: a key from a *different* Supabase project is accepted by
 * the client library without complaint and only fails later, at sign-in, with
 * "Invalid API key" — which reads like a typo rather than a mismatched
 * environment. Running two projects makes this easy to do and hard to spot.
 */
async function verify() {
  if (!config.supabase.url) return { ok: false, error: 'SUPABASE_URL is not set.' };
  if (!config.supabase.anonKey) return { ok: false, error: 'No publishable/anon key is set.' };

  const ref = config.supabase.projectRef || 'unknown';

  if (!config.supabase.serviceRoleKey) {
    return { ok: false, error: `No secret/service-role key set for project ${ref}.` };
  }

  try {
    // Any admin call proves the URL and the secret key belong together.
    const { error } = await getAdminClient().auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      const invalid = /invalid|jwt|api key|unauthor/i.test(error.message);
      return {
        ok: false,
        error: invalid
          ? `The secret key does not belong to project ${ref}. Take the URL and both keys from the same project. (${error.message})`
          : error.message,
      };
    }
    return { ok: true, note: `Keys verified against project ${ref}.` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getAnonClient, getAdminClient, isConfigured, verify };
