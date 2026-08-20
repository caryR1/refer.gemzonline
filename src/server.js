'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');

const config = require('./config');
const db = require('./lib/db');
const tz = require('./lib/tz');
const util = require('./lib/util');
const ranks = require('./lib/ranks');
const tenant = require('./lib/tenant');
const flash = require('./middleware/flash');
const { attachUser } = require('./middleware/auth');

const app = express();

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------
if (config.trustProxy) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/app');
app.set('layout extractScripts', true);
app.set('layout extractStyles', true);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'https://www.google-analytics.com', 'https://*.analytics.google.com'],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(morgan(config.isProd ? 'combined' : 'dev', {
  skip: (req) => req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/img'),
}));

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(config.sessionSecret));

// Flash messages ride in a signed cookie rather than a server-side session.
// express-session's default MemoryStore is explicitly not for production: it
// leaks memory and cannot span processes, and a database-backed store is a lot
// of machinery for carrying one sentence across a redirect.
app.use(flash);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  etag: true,
}));

// ---------------------------------------------------------------------------
// View helpers available to every template
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.locals.config = config;
  res.locals.appName = config.appName;
  res.locals.appUrl = config.appUrl;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.tz = tz;
  res.locals.util = util;
  res.locals.ranks = ranks;
  res.locals.money = util.money;
  res.locals.statusMeta = util.statusMeta;
  res.locals.LEAD_STATUSES = util.LEAD_STATUSES;
  res.locals.ga4Id = '';               // public pages opt in explicitly
  res.locals.title = config.appName;
  res.locals.bodyClass = '';
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
  };
  // Times are rendered in the signed-in user's own zone, prospects in theirs.
  res.locals.viewerZone = config.staffTimezone;
  next();
});

app.use(attachUser);

app.use((req, res, next) => {
  if (req.user && req.user.timezone) res.locals.viewerZone = req.user.timezone;
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * Health check.
 *
 * Deliberately returns 200 whenever the process is alive, even if the database
 * is unreachable — it reports that in the body instead. That way a 503 from
 * this URL means one thing only: the app is not running or not reachable on the
 * expected port. Mixing "app down" and "database down" into the same status
 * code makes a deployment problem much harder to diagnose.
 */
app.get('/healthz', async (req, res) => {
  const health = await db.healthcheck();
  res.status(200).json({
    status: health.ok ? 'ok' : 'degraded',
    database: health.ok,
    error: health.error,
    uptime: Math.round(process.uptime()),
    node: process.version,
    port: config.port,
    version: require('../package.json').version,
  });
});

app.use(require('./routes/auth'));
app.use(require('./routes/public'));
app.use('/agent', require('./routes/agent'));
app.use('/admin', require('./routes/admin'));

app.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/agent');
  return res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('errors/404', {
    title: 'Page not found',
    layout: 'layouts/bare',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  const status = err.status || 500;

  // The error page is the last thing standing between a fault and the user, so
  // it must not be able to fail. When rendering it throws — a missing partial,
  // a template mistake — Express hands that second error back to this same
  // handler and the response ends as a bare stack trace about the error page,
  // with the ORIGINAL error nowhere in sight. Catch it and fall back to plain
  // text, which needs nothing but the socket.
  res.status(status).render('errors/500', {
    title: 'Something went wrong',
    layout: 'layouts/bare',
    message: config.isProd ? null : (err.stack || err.message),
  }, (renderErr, html) => {
    if (!renderErr) return res.send(html);

    console.error('[error] the error page itself failed to render:', renderErr.stack || renderErr.message);
    return res.type('text/plain').send(
      config.isProd
        ? 'Something went wrong. The problem has been logged.'
        : `Something went wrong.\n\nOriginal error:\n${err.stack || err.message}\n\n`
          + `Then the error page failed to render:\n${renderErr.stack || renderErr.message}\n`
    );
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
/**
 * Diagnostics that touch the network or the database.
 *
 * Deliberately run AFTER listen(), never before. Managed hosts give the process
 * a few seconds to bind a port — Hostinger allows three — and a Supabase round
 * trip plus a first database connection can easily exceed that on a cold start.
 * Blocking the listen on them gets the app killed at boot with a message about
 * listen() that points nowhere near the real cause.
 */
async function reportStatus() {
  const problems = config.validate();
  if (problems.length) {
    console.warn('\n  Configuration warnings:');
    problems.forEach((p) => console.warn(`   • ${p}`));
    console.warn('');
  }

  // Say plainly which environment and which Supabase project this process is
  // talking to. Confusing staging for production is the expensive mistake in a
  // two-environment setup, and it is almost always preventable by looking.
  console.log(`  Environment: ${config.env.toUpperCase()}`);
  if (config.supabase.projectRef || config.db.projectRef) {
    console.log(`  Supabase project: ${config.db.projectRef || config.supabase.projectRef || 'unknown'}`);
  }

  // The public address, said out loud. Every link this app emails is built from
  // it, and a production process still carrying a development APP_URL is
  // invisible until a prospect reports a dead link.
  console.log(`  Public address: ${config.appUrl}${config.linksUsable ? '' : '  ← NOT REACHABLE — outbound email is being held back'}`);

  // Prove the keys belong to the project the URL names. A key from the other
  // project is accepted silently and only fails at sign-in, which reads like a
  // typo rather than a mismatched environment.
  try {
    const supabase = require('./lib/supabase');
    if (supabase.isConfigured()) {
      const check = await supabase.verify();
      console.log(check.ok ? '  Supabase keys: verified' : `  Supabase keys: ${check.error}`);
    }
  } catch (err) {
    console.log(`  Supabase keys: could not verify (${err.message})`);
  }

  try {
    const secrets = require('./lib/crypto');
    if (!secrets.isConfigured()) {
      console.log('  Payout encryption: no key — agents cannot save bank details');
    } else {
      const probe = 'boot-probe';
      const ok = secrets.decrypt(secrets.encrypt(probe)) === probe;
      console.log(`  Payout encryption: ${ok ? 'ready' : 'key present but unusable'}`);
    }
  } catch (err) {
    console.log(`  Payout encryption: unusable (${err.message})`);
  }

  try {
    const t = await tenant.current();
    console.log(`  Tenant: ${t.name} (${t.slug})`);
  } catch (err) {
    console.error(`  Could not reach the database: ${err.message}`);
    console.error('  The app is up, but every page will error until DATABASE_URL works.');
  }

  if (config.cron.enabled) {
    try {
      require('./jobs/scheduler').start();
    } catch (err) {
      console.error('  Scheduler failed to start:', err.message);
    }
  }
}

function start() {
  // Without these, a stray rejection kills the process with no explanation and
  // the host serves 503 while you guess. Log loudly, then exit so the
  // supervisor restarts us cleanly.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err.stack || err.message);
    process.exit(1);
  });

  // Listen FIRST. Nothing above this line may await.
  //
  // Bind explicitly to all interfaces: Node does this by default when the host
  // is omitted, but managed hosts route to the container's external interface
  // and an implicit bind is one more thing to wonder about at 2am.
  const server = app.listen(config.port, config.host, () => {
    console.log(`\n  ${config.appName} listening on ${config.host}:${config.port}`);
    console.log(`  ${config.appUrl}`);
    console.log(`  node ${process.version} · ${config.env}\n`);

    // Now that the port is bound, take as long as we need.
    reportStatus().catch((err) => {
      console.error('  Status check failed:', err.message);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${config.port} is already in use. Another copy of the app is probably running.`);
    } else if (err.code === 'EACCES') {
      console.error(`  Not permitted to bind port ${config.port}. Use the port your host assigns via PORT.`);
    } else {
      console.error('  Server failed to start:', err.message);
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    console.log(`\n  ${signal} received — shutting down.`);
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start unconditionally.
//
// The usual `if (require.main === module)` guard breaks on hosts that *require*
// the entry file rather than executing it as the main module — Hostinger's
// Node.js hosting does exactly that, so the guard is false, listen() is never
// called, and the platform kills the app with "did not call listen() within 3
// seconds". Nothing in this project imports server.js, so there is no reason
// for the guard to exist.
start();

module.exports = { app, start };
