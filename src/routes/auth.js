'use strict';

/**
 * Sign in, sign up, Google SSO, password change and reset.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../lib/db');
const audit = require('../lib/audit');
const users = require('../lib/users');
const { getAnonClient, getAdminClient, isConfigured } = require('../lib/supabase');
const { setSession, clearSession, requireUser } = require('../middleware/auth');
const { isEmail, text } = require('../lib/util');
const { COMMON_TIMEZONES, safeZone } = require('../lib/tz');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Wait a few minutes and try again.',
});

function safeNext(value) {
  const next = String(value || '');
  // Only allow internal paths — never an absolute URL.
  return /^\/[^/\\]/.test(next) ? next : null;
}

function landingFor(profile) {
  return profile && profile.role === 'admin' ? '/admin' : '/agent';
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user));
  res.render('auth/login', {
    title: 'Sign in',
    layout: 'layouts/bare',
    next: safeNext(req.query.next) || '',
    googleEnabled: config.supabase.googleEnabled && isConfigured(),
    notice: req.query.notice || '',
  });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  const email = text(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);

  const rerender = (error) => res.status(401).render('auth/login', {
    title: 'Sign in',
    layout: 'layouts/bare',
    error,
    email,
    next: nextUrl || '',
    googleEnabled: config.supabase.googleEnabled && isConfigured(),
  });

  if (!isEmail(email) || !password) {
    return rerender('Enter your email address and password.');
  }

  try {
    const { data, error } = await getAnonClient().auth.signInWithPassword({ email, password });
    if (error || !data || !data.session) {
      return rerender('That email and password combination did not work.');
    }

    const { profile } = await users.ensureProfile(data.user, req.tenant.id, {
      provider: 'password',
      req,
    });

    if (profile.status !== 'active') {
      clearSession(res);
      return res.status(403).render('auth/suspended', { title: 'Account suspended', layout: 'layouts/bare' });
    }

    setSession(res, data.session);
    await users.recordLogin(profile, req.tenant.id, req, 'password');

    return res.redirect(nextUrl || landingFor(profile));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Sign up (email + password). Google SSO is the other route in.
// ---------------------------------------------------------------------------

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user));
  res.render('auth/signup', {
    title: 'Create your agent account',
    layout: 'layouts/bare',
    googleEnabled: config.supabase.googleEnabled && isConfigured(),
    timezones: COMMON_TIMEZONES,
    defaultTimezone: config.staffTimezone,
  });
});

router.post('/signup', loginLimiter, async (req, res, next) => {
  const email = text(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const fullName = text(req.body.full_name, 120);
  const timezone = safeZone(req.body.timezone, config.staffTimezone);

  const rerender = (error) => res.status(400).render('auth/signup', {
    title: 'Create your agent account',
    layout: 'layouts/bare',
    error,
    email,
    fullName,
    googleEnabled: config.supabase.googleEnabled && isConfigured(),
    timezones: COMMON_TIMEZONES,
    defaultTimezone: timezone,
  });

  if (!isEmail(email)) return rerender('Enter a valid email address.');
  if (password.length < 8) return rerender('Choose a password of at least 8 characters.');
  if (!fullName) return rerender('Tell us your name.');

  try {
    const admin = getAdminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (error) {
      if (/already|exists|registered|duplicate/i.test(error.message)) {
        return rerender('An account with that email already exists. Try signing in instead.');
      }
      return rerender(error.message);
    }

    const { profile } = await users.ensureProfile(data.user, req.tenant.id, {
      provider: 'password',
      timezone,
      req,
    });

    await db.query('update profiles set timezone = $1, full_name = $2 where id = $3',
      [timezone, fullName, profile.id]);

    const { data: signIn } = await getAnonClient().auth.signInWithPassword({ email, password });
    if (signIn && signIn.session) setSession(res, signIn.session);

    return res.redirect('/agent/campaigns?welcome=1');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Google SSO
// ---------------------------------------------------------------------------

router.get('/auth/google', async (req, res, next) => {
  if (!config.supabase.googleEnabled) return res.redirect('/login');
  try {
    const nextUrl = safeNext(req.query.next);
    const redirectTo = `${config.appUrl}/auth/callback${nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : ''}`;

    const { data, error } = await getAnonClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (error || !data || !data.url) {
      return res.redirect('/login?notice=' + encodeURIComponent('Google sign-in is unavailable right now.'));
    }
    return res.redirect(data.url);
  } catch (err) {
    return next(err);
  }
});

/**
 * Supabase returns the session in the URL fragment, which never reaches the
 * server. This page reads it in the browser and POSTs it back.
 */
router.get('/auth/callback', (req, res) => {
  res.render('auth/callback', {
    title: 'Signing you in…',
    layout: 'layouts/bare',
    next: safeNext(req.query.next) || '',
  });
});

router.post('/auth/callback', async (req, res, next) => {
  const accessToken = String(req.body.access_token || '');
  const refreshToken = String(req.body.refresh_token || '');
  const nextUrl = safeNext(req.body.next);

  if (!accessToken) return res.status(400).json({ ok: false, error: 'Missing token.' });

  try {
    const { data, error } = await getAnonClient().auth.getUser(accessToken);
    if (error || !data || !data.user) {
      return res.status(401).json({ ok: false, error: 'That sign-in could not be verified.' });
    }

    const { profile, created } = await users.ensureProfile(data.user, req.tenant.id, {
      provider: 'google',
      req,
    });

    if (profile.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'This account is suspended.', redirect: '/login' });
    }

    setSession(res, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    if (!created) await users.recordLogin(profile, req.tenant.id, req, 'google');

    const redirect = nextUrl || (created ? '/agent/campaigns?welcome=1' : landingFor(profile));
    return res.json({ ok: true, redirect });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

router.post('/logout', (req, res) => {
  clearSession(res);
  res.redirect('/login?notice=' + encodeURIComponent('You have been signed out.'));
});

router.get('/logout', (req, res) => {
  clearSession(res);
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', { title: 'Reset your password', layout: 'layouts/bare' });
});

router.post('/forgot-password', loginLimiter, async (req, res) => {
  const email = text(req.body.email, 200).toLowerCase();

  // Always the same answer, so this page cannot be used to discover accounts.
  const done = () => res.render('auth/forgot', {
    title: 'Reset your password',
    layout: 'layouts/bare',
    sent: true,
    email,
  });

  if (!isEmail(email)) return done();

  try {
    await getAnonClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${config.appUrl}/reset-password`,
    });
    const profile = await db.one(
      'select * from profiles where tenant_id = $1 and lower(email) = $2',
      [req.tenant.id, email]
    );
    if (profile) {
      await audit.log({
        tenantId: req.tenant.id,
        req,
        actor: profile,
        actorType: profile.role,
        action: 'auth.password_reset_requested',
        entityType: 'profile',
        entityId: profile.id,
        summary: `Password reset requested for ${email}`,
      });
    }
  } catch (err) {
    console.error('[auth] reset request failed:', err.message);
  }

  return done();
});

router.get('/reset-password', (req, res) => {
  res.render('auth/reset', { title: 'Choose a new password', layout: 'layouts/bare' });
});

router.post('/reset-password', loginLimiter, async (req, res) => {
  const accessToken = String(req.body.access_token || '');
  const password = String(req.body.password || '');

  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Choose a password of at least 8 characters.' });
  }
  if (!accessToken) {
    return res.status(400).json({ ok: false, error: 'This reset link is invalid or has already been used.' });
  }

  try {
    const { data, error } = await getAnonClient().auth.getUser(accessToken);
    if (error || !data || !data.user) {
      return res.status(401).json({ ok: false, error: 'This reset link has expired. Request a new one.' });
    }

    const { error: updateError } = await getAdminClient().auth.admin.updateUserById(
      data.user.id, { password }
    );
    if (updateError) return res.status(400).json({ ok: false, error: updateError.message });

    const profile = await db.one('select * from profiles where id = $1', [data.user.id]);
    if (profile) {
      await audit.log({
        tenantId: req.tenant.id,
        req,
        actor: profile,
        actorType: profile.role,
        action: 'auth.password_changed',
        entityType: 'profile',
        entityId: profile.id,
        summary: `${profile.full_name || profile.email} reset their password`,
      });
    }

    return res.json({ ok: true, redirect: '/login?notice=' + encodeURIComponent('Password updated — sign in with your new password.') });
  } catch (err) {
    console.error('[auth] reset failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

// ---------------------------------------------------------------------------
// Change password while signed in
// ---------------------------------------------------------------------------

router.post('/account/password', requireUser, async (req, res, next) => {
  const current = String(req.body.current_password || '');
  const password = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');
  const back = req.user.role === 'admin' ? '/admin/profile' : '/agent/profile';

  try {
    if (password.length < 8) {
      req.flash('error', 'Choose a password of at least 8 characters.');
      return res.redirect(back);
    }
    if (password !== confirm) {
      req.flash('error', 'The two new passwords do not match.');
      return res.redirect(back);
    }

    // Google-only accounts have no password to verify against.
    if (req.user.auth_provider !== 'google') {
      const { error } = await getAnonClient().auth.signInWithPassword({
        email: req.user.email,
        password: current,
      });
      if (error) {
        req.flash('error', 'Your current password was not correct.');
        return res.redirect(back);
      }
    }

    const { error: updateError } = await getAdminClient().auth.admin.updateUserById(
      req.user.id, { password }
    );
    if (updateError) {
      req.flash('error', updateError.message);
      return res.redirect(back);
    }

    await audit.log({
      tenantId: req.tenant.id,
      req,
      action: 'auth.password_changed',
      entityType: 'profile',
      entityId: req.user.id,
      summary: `${req.user.full_name || req.user.email} changed their password`,
    });

    req.flash('success', 'Password updated.');
    return res.redirect(back);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
