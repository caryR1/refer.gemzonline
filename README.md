# refer.GemzOnline

**Referral and lead management for GemzOnline.**

Independent agents refer people they know into campaigns and earn commission on
what closes. This is the whole path: a public referral page, lead capture,
acknowledgement and consent, appointment scheduling the prospect can change
themselves, a pipeline, commission tracking, and notifications by email and
WhatsApp.

Built primarily for internal use, structured so it can be sold to external
clients later without a data migration.

Live at **[refer.GemzOnline.com](https://refer.gemzonline.com)**.

---

## What it does

### For the prospect

Arrives on a referral link, sees who referred them, fills in a short form, then
picks a **primary and backup appointment time in their own timezone** and gives
consent. They never create an account. A link in their welcome email lets them
**change or cancel the appointment** whenever they like — no login, no phone
call.

### For the agent

Signs up with Google or an email address, browses campaigns and **joins the ones
they want to promote** — instantly, no approval queue. Each campaign gives them
a referral link. They work their own leads, add notes, and record **how they
know each prospect**, which is what the caller opens with. Earnings, pending
commission and payout dates are all visible to them.

### For the admin

Owns campaigns, commission ranks, who sits on which rank, the pipeline, the
money, and the message templates. Closing a lead is admin-only, because closing
is what creates a commission.

---

## The parts worth understanding

**Campaigns hold ranks, not agents.** A campaign defines one or more named
commission profiles — think ranks: "Standard", "Senior", "Partner". Each carries
its own initial rate, optional recurring rate, payout day, and deal value. An
agent joining a campaign lands on its default rank, and can be moved between
ranks later. A database constraint enforces **one rank per agent per campaign**;
an agent can be on as many campaigns as they like.

**The rank's deal value is authoritative.** Percentage commissions calculate
from it. There is deliberately no per-lead override and no "type the real
figure" box at closing. Changing what a deal is worth means editing the rank or
moving the agent — and both are written to the audit log.

**Notification preferences resolve asymmetrically.** Users choose what reaches
them, per event, per channel. Admins can override. The rule:

| Admin setting | Effect |
|---|---|
| **Off** | Hard block. The user cannot switch it back on. |
| **On** | A default. The user may mute it for themselves. |

In short: an admin can suppress, but cannot compel.

**WhatsApp works differently from email.** Email templates are yours to word
however you like. WhatsApp does not permit free-form business-initiated
messages — every one must use a template Meta has pre-approved. So a WhatsApp
template here is a reference to an approved template name plus an ordered
variable mapping. The wording lives in Meta's console. The channel is off by
default and the app runs perfectly well without it.

**Timezones are handled explicitly.** Everything is stored in UTC. Staff see
their own timezone, defaulting to Jamaica (UTC-5, no DST). Prospects see, and
book in, theirs. Any email mentioning a time shows **both**, so nobody has to do
the arithmetic at 7am.

**Multi-tenancy is built in but switched off.** Every table carries a tenant
column and every unique constraint is scoped per tenant. The app runs as a
single organisation with no tenant UI. Selling it to external clients later is
product work — signup, billing, branding — not a data migration.

---

## Running it

Requires Node 18+, a PostgreSQL database and a Supabase project.

```bash
git clone https://github.com/caryR1/refer.gemzonline.git
cd refer.gemzonline
npm install

cp .env.example .env      # fill this in — see the comments in the file
npm run db:push           # tables, indexes, RLS policies
npm run db:seed           # relationship options, sample campaign, email templates
npm run create:admin      # your first login

npm run dev               # http://localhost:3000
```

The first account created on an empty install automatically becomes an admin,
so a fresh deployment can never lock you out.

**Running it locally:** see [LOCAL-DEV.md](LOCAL-DEV.md) — including a test run
worth doing before you trust it.

**Staging vs production:** see [ENVIRONMENTS.md](ENVIRONMENTS.md) — two Supabase
projects, one codebase, and how to promote a change safely.

**Deploying to Hostinger:** see [DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md),
which covers both a VPS and hPanel's Node.js hosting.

**The full requirements:** see [SPEC.md](SPEC.md).

---

## Tests

```bash
npm test              # unit tests + every template compiled
npm run db:verify     # schema constraints, against a real database
```

`npm test` covers the commission arithmetic, the recurring-accrual window, input
handling and the preference-resolution rule; compiles all 56 templates; and
checks that every route renders a view that exists and every include resolves —
the mistakes that are otherwise invisible until someone clicks the page.

`db:verify` proves the rules the app depends on are enforced by the database
rather than merely by convention: one rank per agent per campaign, one default
rank per campaign, no double-paying a lead for the same period, no sending the
same reminder twice, and per-tenant uniqueness. It runs inside a transaction and
rolls back, so it leaves nothing behind.

---

## Layout

```
src/
  config.js            all environment configuration, with validation
  server.js            express app, middleware, error handling
  lib/
    db.js              postgres pool, query helpers, transactions
    tenant.js          the single place that decides which tenant a request is
    supabase.js        auth clients (anon + service role)
    tz.js              timezone handling and dual-timezone formatting
    util.js            input parsing, slugs, money, pagination
    events.js          the catalogue of notification events
    notify.js          the dispatcher — resolves recipients, channels, prefs
    mailer.js          email channel (Nodemailer over Hostinger SMTP)
    whatsapp.js        WhatsApp channel (Meta Cloud API, provider-agnostic)
    templates.js       {{variable}} rendering and the email shell
    commission-math.js pure money arithmetic, no I/O
    commissions.js     creating and accruing commission
    relations.js       how an agent knows a prospect
    audit.js           the append-only trail
    users.js           profile provisioning, including Google self-registration
  middleware/auth.js   sessions, role guards
  routes/
    auth.js            sign in, sign up, Google SSO, password reset
    public.js          referral funnel and prospect self-service
    agent.js           the agent portal
    admin*.js          the admin console, split by area
  jobs/scheduler.js    reminders, monthly accrual, statements, alerts
db/
  schema.sql           tables, indexes, constraints
  policies.sql         row level security (Supabase only)
  verify.sql           schema self-test
views/                 EJS templates — no build step
public/                CSS, JS, SVG illustration
```

---

## Notes

**No build step.** Server-rendered EJS, plain CSS, vanilla JavaScript. Deploying
is `git pull && npm ci && restart`. Nothing to compile, nothing to break between
your machine and the server.

**Payment is tracked, not processed.** Commissions move through pending →
approved → paid, and every transition is audited. No money moves through this
system.

**The audit log is append-only.** There is no update or delete path, in the
application or in the RLS policies.
