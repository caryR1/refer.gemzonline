'use strict';

require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const port = int(process.env.PORT, 3000);

const config = {
  env: process.env.NODE_ENV || 'development',
  port,
  // Managed hosts route to the container's external interface, so bind to all
  // of them rather than loopback. Override with HOST if you need to.
  host: process.env.HOST || '0.0.0.0',
  appUrl: (process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  appName: process.env.APP_NAME || 'refer.GemzOnline',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  trustProxy: bool(process.env.TRUST_PROXY, true),

  // Single-tenant today; every query is still scoped by this tenant slug so
  // going multi-tenant later is product work, not a data migration.
  tenantSlug: process.env.TENANT_SLUG || 'gemzonline',
  tenantName: process.env.TENANT_NAME || 'GemzOnline',

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET || '',
    googleEnabled: bool(process.env.GOOGLE_SSO_ENABLED, true),
  },

  db: {
    url: process.env.DATABASE_URL || '',
    ssl: bool(process.env.DATABASE_SSL, true),
    poolMax: int(process.env.DATABASE_POOL_MAX, 10),
  },

  smtp: {
    enabled: bool(process.env.SMTP_ENABLED, true),
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: int(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.MAIL_FROM_NAME || process.env.APP_NAME || 'refer.GemzOnline',
    fromEmail: process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER || '',
    adminAlertEmail: process.env.ADMIN_ALERT_EMAIL || process.env.SMTP_USER || '',
  },

  // WhatsApp stays dormant until credentials are present. The adapter is
  // provider-agnostic; `provider` selects the implementation.
  whatsapp: {
    enabled: bool(process.env.WHATSAPP_ENABLED, false),
    provider: process.env.WHATSAPP_PROVIDER || 'meta',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    defaultLanguage: process.env.WHATSAPP_DEFAULT_LANGUAGE || 'en_US',
    // Twilio (only read when provider === 'twilio')
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM || '',
  },

  analytics: {
    ga4Id: process.env.GA4_MEASUREMENT_ID || '',
  },

  staffTimezone: process.env.STAFF_TIMEZONE || 'America/Jamaica',

  cron: {
    enabled: bool(process.env.ENABLE_CRON, true),
    jobHour: Math.min(23, Math.max(0, int(process.env.JOB_HOUR, 7))),
    monthlyReportDay: Math.min(28, Math.max(1, int(process.env.MONTHLY_REPORT_DAY, 1))),
    reminderIntervalMinutes: Math.max(5, int(process.env.REMINDER_INTERVAL_MINUTES, 15)),
    staleLeadDays: Math.max(1, int(process.env.STALE_LEAD_DAYS, 14)),
  },
};

config.isProd = config.env === 'production';
config.whatsapp.configured = Boolean(
  config.whatsapp.enabled &&
  (config.whatsapp.provider === 'meta'
    ? config.whatsapp.phoneNumberId && config.whatsapp.accessToken
    : config.whatsapp.twilioAccountSid && config.whatsapp.twilioAuthToken && config.whatsapp.twilioFrom)
);
config.smtp.configured = Boolean(config.smtp.enabled && config.smtp.host && config.smtp.user && config.smtp.pass);

/**
 * Human-readable configuration problems. The app boots regardless so an
 * operator can sign in and read the diagnostics page instead of staring at a
 * crashed process.
 */
config.validate = function validate() {
  const problems = [];
  if (!config.db.url) problems.push('DATABASE_URL is not set — the app cannot read or write data.');
  if (!config.supabase.url) problems.push('SUPABASE_URL is not set — sign-in will not work.');
  if (!config.supabase.anonKey) problems.push('SUPABASE_ANON_KEY is not set — sign-in will not work.');
  if (!config.supabase.serviceRoleKey) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set — creating users will not work.');
  if (!config.smtp.configured) problems.push('SMTP is not fully configured — outbound email is disabled.');
  if (config.whatsapp.enabled && !config.whatsapp.configured) {
    problems.push('WHATSAPP_ENABLED is on but the provider credentials are incomplete — WhatsApp sends will be skipped.');
  }
  if (config.isProd && config.sessionSecret === 'insecure-dev-secret-change-me') {
    problems.push('SESSION_SECRET is still the default value — set a long random string.');
  }
  if (config.isProd && config.appUrl.startsWith('http://')) {
    problems.push('APP_URL is not https — referral and appointment links will be insecure.');
  }
  return problems;
};

module.exports = config;
