'use strict';

/**
 * Flash messages in a signed cookie.
 *
 * Replaces express-session + connect-flash, which we only ever used to carry a
 * sentence across a redirect. The default MemoryStore is explicitly not for
 * production — it leaks memory and cannot span more than one process — and
 * pulling in a database-backed session store to hold "Profile saved." would be
 * a lot of machinery for very little.
 *
 * The API is identical to connect-flash, so routes need no changes:
 *
 *   req.flash('success', 'Saved.')   // queue for the next request
 *   req.flash('success')             // read and clear
 */

const config = require('../config');

const COOKIE = 'rg_flash';
const MAX_BYTES = 3800;          // browsers cap a cookie at ~4KB
const TTL_MS = 5 * 60 * 1000;    // a redirect is immediate; 5 minutes is generous

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    signed: true,
    path: '/',
    maxAge: TTL_MS,
  };
}

function flash(req, res, next) {
  let incoming = {};

  const raw = req.signedCookies ? req.signedCookies[COOKIE] : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') incoming = parsed;
    } catch (_) {
      incoming = {};
    }
    // Consume it. If this request queues new messages, the Set-Cookie below
    // is written later in the response and takes precedence.
    res.clearCookie(COOKIE, { path: '/' });
  }

  const pending = {};

  req.flash = function reqFlash(type, message) {
    // Read mode: hand back what arrived, and clear it.
    if (message === undefined) {
      if (type === undefined) {
        const all = incoming;
        incoming = {};
        return all;
      }
      const messages = incoming[type] || [];
      delete incoming[type];
      return messages;
    }

    // Write mode: queue for the next request.
    pending[type] = pending[type] || [];
    pending[type].push(String(message));

    const payload = JSON.stringify(pending);
    if (payload.length <= MAX_BYTES) {
      res.cookie(COOKIE, payload, cookieOptions());
    } else {
      // Something is queueing far too much. Drop it rather than emit a cookie
      // the browser will silently refuse.
      console.warn('[flash] message payload too large, dropped');
    }

    return pending[type];
  };

  return next();
}

module.exports = flash;
