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

module.exports = { getAnonClient, getAdminClient, isConfigured };
