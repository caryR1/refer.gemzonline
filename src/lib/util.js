'use strict';

const crypto = require('crypto');

const SLUG_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l/1/0/o

/** URL-safe slug from arbitrary text. */
function slugify(input, fallback = '') {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Short random token, e.g. for referral slugs. */
function token(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

/** Human-friendly lead reference, e.g. GZ-8F3K2Q. */
function reference(prefix = 'GZ') {
  return `${prefix}-${token(6).toUpperCase()}`;
}

/** Trim a string, returning null when empty. */
function str(value, max = 5000) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Trim a string, returning '' when empty. */
function text(value, max = 5000) {
  return str(value, max) || '';
}

/**
 * Read a number out of user input, tolerating currency symbols and thousands
 * separators. Input with no digits at all returns the fallback — otherwise
 * "nonsense" would silently become 0, which is a different and wrong answer.
 */
function num(value, fallback = 0) {
  const cleaned = String(value ?? '').replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return fallback;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase());
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/** HTML-escape for anywhere we inject text into markup ourselves. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Money formatting for display. */
function money(amount, currency = 'USD') {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 2,
    }).format(value);
  } catch (_) {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Percentage / fixed rate label, e.g. "15%" or "$250.00". */
function rateLabel(type, value, currency = 'USD') {
  return type === 'fixed' ? money(value, currency) : `${Number(value || 0)}%`;
}

const LEAD_STATUSES = [
  { value: 'new', label: 'New', tone: 'slate' },
  { value: 'contacted', label: 'Contacted', tone: 'blue' },
  { value: 'appointment_set', label: 'Appointment set', tone: 'violet' },
  { value: 'closed_won', label: 'Closed / won', tone: 'green' },
  { value: 'closed_lost', label: 'Closed / lost', tone: 'red' },
];

function statusMeta(value) {
  return LEAD_STATUSES.find((s) => s.value === value) || { value, label: value, tone: 'slate' };
}

const TRIGGER_EVENTS = [
  { value: '', label: 'Manual only — never sent automatically' },
  { value: 'lead_created', label: 'Lead created (form submitted)' },
  { value: 'consent_given', label: 'Acknowledgement / consent completed' },
  { value: 'appointment_set', label: 'Appointment set' },
  { value: 'contacted', label: 'Status → contacted' },
  { value: 'closed_won', label: 'Status → closed / won' },
  { value: 'closed_lost', label: 'Status → closed / lost' },
  { value: 'account_dropped', label: 'Recurring account dropped' },
  { value: 'monthly_report', label: 'Monthly commission report' },
];

/** Split a comma/semicolon/whitespace separated recipient list. */
function emailList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(isEmail);
}

/** Build a paginated slice description. */
function paginate(totalRows, page, perPage) {
  const total = Number(totalRows) || 0;
  const per = Math.max(1, Number(perPage) || 25);
  const pages = Math.max(1, Math.ceil(total / per));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return {
    total, perPage: per, pages, page: current,
    offset: (current - 1) * per,
    hasPrev: current > 1,
    hasNext: current < pages,
    from: total === 0 ? 0 : (current - 1) * per + 1,
    to: Math.min(total, current * per),
  };
}

/** Preserve the current query string while changing one parameter. */
function withQuery(query, changes) {
  const params = new URLSearchParams();
  Object.entries({ ...query, ...changes }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  const s = params.toString();
  return s ? `?${s}` : '';
}

module.exports = {
  slugify, token, reference, str, text, num, bool, isEmail, escapeHtml,
  money, rateLabel, LEAD_STATUSES, statusMeta, TRIGGER_EVENTS, emailList,
  paginate, withQuery,
};
