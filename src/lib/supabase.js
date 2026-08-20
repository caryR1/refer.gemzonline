'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

/**
 * No client-side session storage: this is a server, and the signed-in session
 * lives in an httpOnly cookie we set ourselves.
 *
 * `flowType: 'implicit'` is deliberate and load-bearing. supabase-js defaults to
 * PKCE, where Supabase returns `?code=` and expects a later exchange using a
 * code verifier the library stashed in its own storage. On a server with
 * `persistSession: false` there is no storage to stash it in, and the request
 * that starts a sign-in is not the one that finishes it — so the exchange can
 * never complete. It fails *after* the Google account picker, which reads like a
 * dashboard misconfiguration and is not one.
 *
 * Implicit returns the tokens in the URL fragment instead, which is what
 * `views/auth/callback` is built to read: the browser posts them straight back,
 * they go into an httpOnly cookie, and the fragment is discarded. Fragments are
 * never sent to servers, so the tokens stay out of every access log on the way.
 *
 * The stronger option is PKCE with the verifier held in a short-lived signed
 * cookie, which would remove the fragment and the relay page entirely. Worth
 * doing — but it is a different callback contract, not a one-line change.
 */
const noStore = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
    flowType: 'implicit',
  },
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
