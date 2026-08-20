'use strict';

/**
 * Authenticated encryption for the small amount of genuinely sensitive data
 * this app stores — today, agents' bank account identifiers.
 *
 * Row level security keeps one tenant out of another's rows, but it does
 * nothing about a leaked backup, a misconfigured read replica, or anyone who
 * ends up with the database password. Account numbers are the one field here
 * where that difference matters, so they are encrypted before they are written
 * and decrypted only when someone entitled to see them asks.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a ciphertext that has
 * been altered fails to decrypt rather than returning plausible rubbish. The
 * purpose string is bound in as additional authenticated data, so a value
 * lifted from one column cannot be replayed into another.
 *
 * Envelope, all base64url, dot-separated so it is safe in JSON, URLs and logs:
 *
 *   v1.<iv>.<auth tag>.<ciphertext>
 *
 * The version prefix is what makes a future key rotation or algorithm change
 * possible without a flag day — read both, write the new one.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;          // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;         // AES-256

let cachedKey;
let cachedKeyError;

/**
 * Read the key from the environment.
 *
 * Accepts 64 hex characters or 44 base64 characters, which is what
 * `openssl rand -hex 32` and `openssl rand -base64 32` produce respectively —
 * whichever one an operator reaches for should work.
 */
function loadKey() {
  if (cachedKey || cachedKeyError) return cachedKey;

  const raw = (process.env.PAYOUT_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    cachedKeyError = 'PAYOUT_ENCRYPTION_KEY is not set.';
    return null;
  }

  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === KEY_BYTES) buf = decoded;
    } catch (_) {
      buf = null;
    }
  }

  if (!buf || buf.length !== KEY_BYTES) {
    cachedKeyError = 'PAYOUT_ENCRYPTION_KEY must be 32 bytes — 64 hex characters '
      + '(openssl rand -hex 32) or 44 base64 characters (openssl rand -base64 32).';
    return null;
  }

  cachedKey = buf;
  return cachedKey;
}

/** True when a usable key is present. Callers degrade rather than crash. */
function isConfigured() {
  return Boolean(loadKey());
}

/** Why the key is unusable, or null when it is fine. */
function keyProblem() {
  loadKey();
  return cachedKey ? null : cachedKeyError;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Encrypt a string. Returns null for empty input so an absent value stays
 * absent rather than becoming an encrypted empty string.
 *
 * @param {string} plaintext
 * @param {string} purpose  bound into the ciphertext; must match on decrypt
 */
function encrypt(plaintext, purpose = 'payout') {
  const text = plaintext === null || plaintext === undefined ? '' : String(plaintext);
  if (!text) return null;

  const key = loadKey();
  if (!key) throw new Error(keyProblem());

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join('.');
}

/**
 * Decrypt an envelope produced by `encrypt`.
 *
 * Returns null rather than throwing when the value is empty or unrecognisable,
 * so one bad row cannot take down a page that lists many. A value that IS a
 * valid envelope but fails authentication does throw — that means tampering or
 * the wrong key, and silently showing nothing would hide a real problem.
 */
function decrypt(envelope, purpose = 'payout') {
  if (!envelope) return null;

  const parts = String(envelope).split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  const key = loadKey();
  if (!key) throw new Error(keyProblem());

  const iv = fromB64url(parts[1]);
  const tag = fromB64url(parts[2]);
  const ciphertext = fromB64url(parts[3]);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** True if the value looks like one of our envelopes. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/**
 * Show enough of an identifier to recognise it, and no more.
 *
 *   mask('GB29NWBK60161331926819') -> '•••• 6819'
 *
 * Email-shaped values are masked differently, since the last four characters of
 * a domain identify nobody: 'ca••@gmail.com'.
 */
function mask(value, keep = 4) {
  const str = String(value || '').trim();
  if (!str) return '';

  const at = str.indexOf('@');
  if (at > 0) {
    const local = str.slice(0, at);
    const domain = str.slice(at);
    const shown = local.slice(0, Math.min(2, local.length));
    return `${shown}${'•'.repeat(Math.max(2, local.length - shown.length))}${domain}`;
  }

  const compact = str.replace(/\s+/g, '');
  if (compact.length <= keep) return '•'.repeat(compact.length);
  return `•••• ${compact.slice(-keep)}`;
}

/** Last N characters, stored alongside the ciphertext so lists need no key. */
function lastFour(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  return compact ? compact.slice(-4) : '';
}

/** Test seam — forget a key read earlier in the process. */
function resetKeyCache() {
  cachedKey = undefined;
  cachedKeyError = undefined;
}

module.exports = {
  encrypt, decrypt, isEncrypted, isConfigured, keyProblem,
  mask, lastFour, resetKeyCache,
};
