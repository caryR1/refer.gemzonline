'use strict';

/**
 * Agent payout details, in the shape international payment providers ask for.
 *
 * Wise, Payoneer, Remitly and every bank's wire form want the same three
 * things, in this order:
 *
 *   1. WHO is being paid   — legal name exactly as the bank has it, and
 *                            whether the account is personal or business
 *   2. WHERE               — the recipient's own address, which most cross
 *                            border corridors require for compliance
 *   3. HOW                 — the account identifiers, and those differ by
 *                            country: IBAN in Europe, routing + account in the
 *                            US, sort code in the UK, institution + transit in
 *                            Canada, plain SWIFT everywhere else
 *
 * Asking for "account number" as one free-text box, as this app did before,
 * guarantees the details arrive in a format nobody can pay from. So the form
 * picks a scheme and asks only for that scheme's fields, with the validation
 * each one actually has.
 *
 * The identifiers are encrypted (see lib/crypto). Everything else — name,
 * country, currency, address — stays in plain columns so admins can search,
 * sort and export a payment run without a decryption key in the loop.
 */

const crypto = require('./crypto');
const util = require('./util');

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

/**
 * `sensitive: true` means the value is encrypted at rest and masked in lists.
 * Bank names and branch descriptions are not — they identify an institution,
 * not an account, and being able to read them makes reconciling a payment run
 * far easier.
 */
const SCHEMES = [
  {
    code: 'iban',
    label: 'IBAN — Europe, and most of the world',
    hint: 'One long number beginning with a two-letter country code. If your bank gave you an IBAN, use this.',
    fields: [
      {
        key: 'iban',
        label: 'IBAN',
        placeholder: 'GB29 NWBK 6016 1331 9268 19',
        required: true,
        sensitive: true,
        transform: 'compact-upper',
        pattern: /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/,
        error: 'An IBAN is two letters, two digits, then up to 30 more letters and digits.',
      },
      {
        key: 'bic',
        label: 'BIC / SWIFT code',
        placeholder: 'NWBKGB2L',
        help: 'Optional for most European banks — required for a few.',
        sensitive: false,
        transform: 'compact-upper',
        pattern: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
        error: 'A BIC is 8 or 11 letters and digits.',
      },
    ],
  },
  {
    code: 'aba',
    label: 'United States — routing and account number',
    hint: 'The nine-digit routing number is on the bottom left of a cheque.',
    fields: [
      {
        key: 'routing_number',
        label: 'Routing number (ACH)',
        placeholder: '026009593',
        required: true,
        sensitive: false,
        transform: 'digits',
        pattern: /^\d{9}$/,
        error: 'A US routing number is exactly 9 digits.',
      },
      {
        key: 'account_number',
        label: 'Account number',
        required: true,
        sensitive: true,
        transform: 'compact',
        pattern: /^[0-9A-Za-z]{4,20}$/,
        error: 'An account number is 4 to 20 letters or digits.',
      },
      {
        key: 'us_account_kind',
        label: 'Account type',
        type: 'select',
        options: [['checking', 'Checking'], ['savings', 'Savings']],
        required: true,
        sensitive: false,
      },
    ],
  },
  {
    code: 'sort_code',
    label: 'United Kingdom — sort code and account number',
    fields: [
      {
        key: 'sort_code',
        label: 'Sort code',
        placeholder: '60-16-13',
        required: true,
        sensitive: false,
        transform: 'digits',
        pattern: /^\d{6}$/,
        error: 'A sort code is 6 digits, with or without the dashes.',
      },
      {
        key: 'account_number',
        label: 'Account number',
        placeholder: '31926819',
        required: true,
        sensitive: true,
        transform: 'digits',
        pattern: /^\d{8}$/,
        error: 'A UK account number is 8 digits.',
      },
    ],
  },
  {
    code: 'canada',
    label: 'Canada — institution, transit and account number',
    fields: [
      {
        key: 'institution_number',
        label: 'Institution number',
        placeholder: '003',
        required: true,
        sensitive: false,
        transform: 'digits',
        pattern: /^\d{3}$/,
        error: 'An institution number is 3 digits.',
      },
      {
        key: 'transit_number',
        label: 'Transit number',
        placeholder: '00123',
        required: true,
        sensitive: false,
        transform: 'digits',
        pattern: /^\d{5}$/,
        error: 'A transit number is 5 digits.',
      },
      {
        key: 'account_number',
        label: 'Account number',
        required: true,
        sensitive: true,
        transform: 'compact',
        pattern: /^[0-9A-Za-z]{5,20}$/,
        error: 'A Canadian account number is 5 to 20 characters.',
      },
    ],
  },
  {
    code: 'swift',
    label: 'International wire (SWIFT)',
    hint: 'Use this for Jamaica, the wider Caribbean, and anywhere without a local scheme of its own.',
    fields: [
      {
        key: 'bank_name',
        label: 'Bank name',
        placeholder: 'National Commercial Bank Jamaica',
        required: true,
        sensitive: false,
      },
      {
        key: 'swift_bic',
        label: 'SWIFT / BIC code',
        placeholder: 'JNCBJMKX',
        required: true,
        sensitive: false,
        transform: 'compact-upper',
        pattern: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
        error: 'A SWIFT code is 8 or 11 letters and digits.',
      },
      {
        key: 'account_number',
        label: 'Account number',
        required: true,
        sensitive: true,
        transform: 'compact',
        pattern: /^[0-9A-Za-z-]{4,34}$/,
        error: 'An account number is 4 to 34 letters, digits or dashes.',
      },
      {
        key: 'branch',
        label: 'Branch',
        help: 'Optional. Some banks route faster with it.',
        sensitive: false,
      },
    ],
  },
  {
    code: 'wise',
    label: 'Wise account — email or Wisetag',
    hint: 'The fastest option if you already have Wise. We send to your Wise account and you choose where it lands.',
    fields: [
      {
        key: 'wise_identifier',
        label: 'Wise email or @Wisetag',
        placeholder: 'you@example.com  or  @yourtag',
        required: true,
        sensitive: true,
        pattern: /^(@[A-Za-z0-9._-]{2,}|[^@\s]+@[^@\s]+\.[A-Za-z]{2,})$/,
        error: 'Enter the email address on your Wise account, or your @Wisetag.',
      },
    ],
  },
  {
    code: 'paypal',
    label: 'PayPal',
    fields: [
      {
        key: 'paypal_email',
        label: 'PayPal email address',
        required: true,
        sensitive: true,
        transform: 'lower',
        pattern: /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/,
        error: 'Enter the email address on your PayPal account.',
      },
    ],
  },
  {
    code: 'other',
    label: 'Something else',
    hint: 'Mobile money, a local wallet, or an arrangement we have agreed separately.',
    fields: [
      {
        key: 'other_details',
        label: 'How to pay you',
        type: 'textarea',
        placeholder: 'Tell us the service and the details we need.',
        required: true,
        sensitive: true,
      },
    ],
  },
];

const SCHEME_CODES = SCHEMES.map((s) => s.code);

/** Currencies we are realistically asked to pay in. Free text is not offered — a
 *  typo here is a failed transfer, and the list is easy to extend. */
const CURRENCIES = [
  'USD', 'JMD', 'GBP', 'EUR', 'CAD', 'TTD', 'BBD', 'XCD', 'BSD', 'BZD', 'GYD',
  'HTG', 'DOP', 'AUD', 'NZD', 'ZAR', 'NGN', 'KES', 'GHS', 'INR', 'PHP', 'MXN',
  'BRL', 'COP', 'SGD', 'HKD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'AED',
];

/** Offered as a datalist, so anywhere else can still be typed in. */
const COMMON_COUNTRIES = [
  'Jamaica', 'United States', 'Canada', 'United Kingdom', 'Trinidad and Tobago',
  'Barbados', 'Guyana', 'Bahamas', 'Belize', 'Dominican Republic', 'Haiti',
  'Antigua and Barbuda', 'Saint Lucia', 'Grenada', 'Cayman Islands',
  'Ireland', 'Germany', 'France', 'Spain', 'Portugal', 'Netherlands', 'Belgium',
  'Italy', 'Poland', 'Sweden', 'Norway', 'Denmark', 'Switzerland',
  'Australia', 'New Zealand', 'South Africa', 'Nigeria', 'Ghana', 'Kenya',
  'India', 'Philippines', 'Mexico', 'Brazil', 'Colombia', 'Singapore',
  'Hong Kong', 'United Arab Emirates',
];

const HOLDER_TYPES = [['personal', 'Personal account'], ['business', 'Business account']];

function scheme(code) {
  return SCHEMES.find((s) => s.code === code) || null;
}

/** The columns stored in the clear, in the order the form presents them. */
const PLAIN_COLUMNS = [
  'payout_method', 'payout_holder_name', 'payout_holder_type',
  'payout_bank_country', 'payout_currency',
  'payout_addr_line1', 'payout_addr_line2', 'payout_addr_city',
  'payout_addr_region', 'payout_addr_postal_code', 'payout_addr_country',
];

// ---------------------------------------------------------------------------
// Reading the form
// ---------------------------------------------------------------------------

function applyTransform(value, transform) {
  const str = String(value == null ? '' : value).trim();
  switch (transform) {
    case 'compact': return str.replace(/[\s-]/g, '');
    case 'compact-upper': return str.replace(/[\s-]/g, '').toUpperCase();
    case 'digits': return str.replace(/\D/g, '');
    case 'lower': return str.toLowerCase();
    default: return str.replace(/\s+/g, ' ');
  }
}

/**
 * Turn submitted form fields into what we will store.
 *
 * Returns `{ plain, secrets, errors, cleared }`. `cleared` is true when the
 * agent chose "no payout method yet", which wipes the details rather than
 * leaving a half-filled record that looks payable.
 */
function fromForm(body = {}) {
  const errors = [];
  const code = util.text(body.payout_method, 30);

  if (!code) {
    return {
      cleared: true,
      errors,
      plain: Object.fromEntries(PLAIN_COLUMNS.map((c) => [c, ''])),
      secrets: {},
    };
  }

  if (!SCHEME_CODES.includes(code)) {
    errors.push('Choose how you would like to be paid.');
    return { cleared: false, errors, plain: {}, secrets: {} };
  }

  const def = scheme(code);

  const plain = {
    payout_method: code,
    payout_holder_name: util.text(body.payout_holder_name, 140),
    payout_holder_type: HOLDER_TYPES.some(([v]) => v === body.payout_holder_type)
      ? body.payout_holder_type
      : 'personal',
    payout_bank_country: util.text(body.payout_bank_country, 80),
    payout_currency: util.text(body.payout_currency, 3).toUpperCase(),
    payout_addr_line1: util.text(body.payout_addr_line1, 160),
    payout_addr_line2: util.text(body.payout_addr_line2, 160),
    payout_addr_city: util.text(body.payout_addr_city, 80),
    payout_addr_region: util.text(body.payout_addr_region, 80),
    payout_addr_postal_code: util.text(body.payout_addr_postal_code, 24),
    payout_addr_country: util.text(body.payout_addr_country, 80),
  };

  // Who is being paid. Every provider rejects a transfer where the name does
  // not match the account, so this is worth insisting on.
  if (!plain.payout_holder_name) {
    errors.push('Enter the account holder name exactly as your bank has it.');
  }
  if (plain.payout_currency && !CURRENCIES.includes(plain.payout_currency)) {
    errors.push(`We cannot pay in ${plain.payout_currency}. Choose a currency from the list.`);
  }
  if (!plain.payout_currency) errors.push('Choose the currency you want to be paid in.');

  // Wise and correspondent banks ask for the account's country separately from
  // the recipient's address; they are frequently different.
  const banked = ['iban', 'aba', 'sort_code', 'canada', 'swift'].includes(code);
  if (banked && !plain.payout_bank_country) {
    errors.push('Tell us which country the account is held in.');
  }

  const secrets = {};
  def.fields.forEach((field) => {
    const raw = body[`payout_${field.key}`];
    const value = applyTransform(raw, field.transform);

    if (!value) {
      if (field.required) errors.push(`${field.label} is required.`);
      return;
    }
    if (field.type === 'select' && Array.isArray(field.options)
        && !field.options.some(([v]) => v === value)) {
      errors.push(`Choose a valid ${field.label.toLowerCase()}.`);
      return;
    }
    if (field.pattern && !field.pattern.test(value)) {
      errors.push(field.error || `${field.label} does not look right.`);
      return;
    }
    secrets[field.key] = value;
  });

  return { cleared: false, errors, plain, secrets };
}

// ---------------------------------------------------------------------------
// Storing and reading back
// ---------------------------------------------------------------------------

/** The identifier we show a masked version of — the one a human recognises. */
function primaryKeyFor(code) {
  switch (code) {
    case 'iban': return 'iban';
    case 'wise': return 'wise_identifier';
    case 'paypal': return 'paypal_email';
    case 'other': return 'other_details';
    default: return 'account_number';
  }
}

/**
 * Encrypt the sensitive half. The whole set goes into a single ciphertext:
 * one value to store, one to rotate, and no way for the fields to drift out of
 * step with each other.
 */
function encryptSecrets(code, secrets) {
  const def = scheme(code);
  if (!def) return { payout_secrets: null, payout_last4: '' };

  const sensitive = {};
  const plainExtras = {};
  def.fields.forEach((field) => {
    const value = secrets[field.key];
    if (value === undefined) return;
    if (field.sensitive) sensitive[field.key] = value;
    else plainExtras[field.key] = value;
  });

  // Bank name, sort code, routing number and the like are not secret, but they
  // belong with the account, so they ride in the same blob. Keeping them
  // readable would mean five more columns for no benefit.
  const payload = { ...plainExtras, ...sensitive };
  const primary = secrets[primaryKeyFor(code)] || '';

  return {
    payout_secrets: Object.keys(payload).length ? crypto.encrypt(JSON.stringify(payload)) : null,
    payout_last4: crypto.lastFour(primary),
  };
}

/**
 * Decrypt an agent's identifiers. Returns `{}` when there is nothing stored.
 * Throws only if the ciphertext fails authentication, which means the key is
 * wrong or the row was tampered with — both worth surfacing, not swallowing.
 */
function reveal(profile) {
  if (!profile || !profile.payout_secrets) return {};
  const json = crypto.decrypt(profile.payout_secrets);
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * What to show without decrypting anything: the method, who it pays, and the
 * last four digits. Safe for lists, exports and the audit trail.
 */
function summary(profile) {
  const code = profile && profile.payout_method;
  const def = scheme(code);
  if (!def) {
    return { configured: false, label: 'Not set up', holder: '', masked: '', currency: '' };
  }
  return {
    configured: Boolean(profile.payout_secrets),
    code,
    label: def.label,
    holder: profile.payout_holder_name || '',
    currency: profile.payout_currency || '',
    country: profile.payout_bank_country || '',
    masked: profile.payout_last4 ? `•••• ${profile.payout_last4}` : '',
  };
}

/** Field-by-field, decrypted and labelled, for the one screen entitled to it. */
function detailRows(profile) {
  const def = scheme(profile && profile.payout_method);
  if (!def) return [];
  const values = reveal(profile);
  return def.fields
    .filter((f) => values[f.key])
    .map((f) => ({
      key: f.key,
      label: f.label,
      value: values[f.key],
      masked: f.sensitive ? crypto.mask(values[f.key]) : values[f.key],
      sensitive: Boolean(f.sensitive),
    }));
}

module.exports = {
  SCHEMES, SCHEME_CODES, CURRENCIES, COMMON_COUNTRIES, HOLDER_TYPES, PLAIN_COLUMNS,
  scheme, fromForm, encryptSecrets, reveal, summary, detailRows, primaryKeyFor,
  applyTransform,
};
