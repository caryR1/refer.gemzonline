'use strict';

/**
 * Authentication middleware.
 *
 * Sessions are Supabase Auth tokens held in a signed, HTTP-only cookie. The
 * access token is verified locally with the project's JWT secret when one is
 * configured (fast, no network hop) and falls back to asking Supabase when it
 * is not. Expired tokens are refreshed transparently.
 */

const jwt = require('jsonwebtoken');
const db = require('./../lib/db');
const config = require('../config');
const tenant = require('../lib/tenant');
const { getAnonClient } = require('../lib/supabase');

const COOKIE = 'rg_session';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  signed: true,
  maxAge: 1000 * 60 * 60 * 24 * 30,   // 30 days
  path: '/',
};

function setSession(res, session) {
  if (!session) return;
  res.cookie(COOKIE, JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  }), COOKIE_OPTS);
}

function clearSession(res) {
  res.clearCookie(COOKIE, { ...COOKIE_OPTS, maxAge: undefined });
}

function readSession(req) {
  const raw = req.signedCookies ? req.signedCookies[COOKIE] : null;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** Verify an access token and return its subject id, or null. */
async function verifyToken(accessToken) {
  if (!accessToken) return null;

  if (config.supabase.jwtSecret) {
    try {
      const payload = jwt.verify(accessToken, config.supabase.jwtSecret, { algorithms: ['HS256'] });
      return payload.sub || null;
    } catch (err) {
      if (err.name === 'TokenExpiredError') return null;
      // Falls through to the network check — some projects sign with a key
      // that is rotated out of band.
    }
  }

  try {
    const { data, error } = await getAnonClient().auth.getUser(accessToken);
    if (error || !data || !data.user) return null;
    return data.user.id;
  } catch (_) {
    return null;
  }
}

/**
 * Populates req.user (the profile row) and req.tenant on every request.
 * Never blocks — guards below decide what to do about an anonymous request.
 */
async function attachUser(req, res, next) {
  res.locals.user = null;
  req.user = null;

  try {
    req.tenant = await tenant.resolve(req);
    res.locals.tenant = req.tenant;
  } catch (err) {
    // The database may be unreachable; let the error page handle it.
    return next();
  }

  const session = readSession(req);
  if (!session) return next();

  let userId = await verifyToken(session.access_token);

  // Expired — try the refresh token before giving up.
  if (!userId && session.refresh_token) {
    try {
      const { data, error } = await getAnonClient().auth.refreshSession({
        refresh_token: session.refresh_token,
      });
      if (!error && data && data.session) {
        setSession(res, data.session);
        userId = data.session.user ? data.session.user.id : await verifyToken(data.session.access_token);
      }
    } catch (_) { /* fall through to signed-out */ }
  }

  if (!userId) {
    clearSession(res);
    return next();
  }

  try {
    const profile = await db.one(
      'select * from profiles where id = $1 and tenant_id = $2',
      [userId, req.tenant.id]
    );
    if (profile && profile.status === 'active') {
      req.user = profile;
      res.locals.user = profile;
    } else if (profile) {
      req.suspended = true;
      res.locals.suspended = true;
    }
  } catch (err) {
    console.error('[auth] could not load profile:', err.message);
  }

  return next();
}

/** Require any signed-in staff member. */
function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.suspended) {
    return res.status(403).render('auth/suspended', { title: 'Account suspended', layout: 'layouts/bare' });
  }
  const target = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${target}`);
}

/** Require an admin. */
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (req.user) {
    return res.status(403).render('errors/403', { title: 'Not permitted' });
  }
  const target = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${target}`);
}

/** Require an agent (admins are allowed through — they can see everything). */
function requireAgent(req, res, next) {
  if (req.user) return next();
  const target = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${target}`);
}

module.exports = {
  COOKIE, COOKIE_OPTS,
  attachUser, requireUser, requireAdmin, requireAgent,
  setSession, clearSession, readSession, verifyToken,
};
