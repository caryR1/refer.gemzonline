'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');

const config = require('./config');
const db = require('./lib/db');
const tz = require('./lib/tz');
const util = require('./lib/util');
const tenant = require('./lib/tenant');
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

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'rg_flash',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 30,
  },
}));
app.use(flash());

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
app.get('/healthz', async (req, res) => {
  const health = await db.healthcheck();
  res.status(health.ok ? 200 : 503).json({
    status: health.ok ? 'ok' : 'degraded',
    database: health.ok,
    error: health.error,
    uptime: Math.round(process.uptime()),
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
  res.status(404).render('errors/404', { title: 'Page not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).render('errors/500', {
    title: 'Something went wrong',
    message: config.isProd ? null : (err.stack || err.message),
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  const problems = config.validate();
  if (problems.length) {
    console.warn('\n  Configuration warnings:');
    problems.forEach((p) => console.warn(`   • ${p}`));
    console.warn('');
  }

  try {
    const t = await tenant.current();
    console.log(`  Tenant: ${t.name} (${t.slug})`);
  } catch (err) {
    console.error(`  Could not reach the database: ${err.message}`);
    console.error('  The app will start, but every page will show an error until DATABASE_URL works.');
  }

  if (config.cron.enabled) {
    try {
      require('./jobs/scheduler').start();
    } catch (err) {
      console.error('  Scheduler failed to start:', err.message);
    }
  }

  const server = app.listen(config.port, () => {
    console.log(`\n  ${config.appName} listening on port ${config.port}`);
    console.log(`  ${config.appUrl}\n`);
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

if (require.main === module) {
  start();
}

module.exports = { app, start };
