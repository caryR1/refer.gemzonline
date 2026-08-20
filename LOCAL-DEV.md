# Running it locally

Worth doing before you touch production again — everything is faster to fix
when you can see the error on your own screen.

About 20 minutes the first time.

---

## 1. Install Node

Check whether you already have it:

```powershell
node --version
```

If that errors, or shows anything below 18:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

**Close PowerShell and open a new one** — the PATH only updates in a fresh
terminal. Then confirm:

```powershell
node --version    # v20.x or higher
npm --version
```

---

## 2. A database to develop against

**Do not point local development at your production Supabase project.** You will
be creating test leads, closing them, and generating commissions — none of which
you want mixed into real data, and the audit log makes it permanent.

Create a **second free Supabase project** called something like
`refer-gemzonline-dev`. Free tier is plenty. From **Project Settings**, collect
the same four values as production: the URL, anon key, service role key, and the
database connection string.

**When you copy the connection string, choose "Session pooler" — not "Direct
connection".** Direct connections are IPv6-only unless you pay for Supabase's
IPv4 add-on, and most home and office networks are IPv4-only. You will get:

```
FAILED: getaddrinfo ENOTFOUND db.xxxxxxxx.supabase.co
```

which looks like a typo but means the hostname genuinely has no IPv4 address.
The session pooler host works everywhere. It differs in three ways:

| | Direct | Session pooler |
|---|---|---|
| Host | `db.<ref>.supabase.co` | `aws-0-<region>.pooler.supabase.com` |
| Username | `postgres` | `postgres.<ref>` |
| Port | 5432 | 5432 |

Avoid the **transaction** pooler (port 6543) — it does not support prepared
statements, which node-postgres uses, so you get intermittent failures rather
than a clean error.

---

## 3. Configure

```powershell
cd C:\Users\Cary\source\repos\refer.gemzonline
copy .env.example .env
notepad .env
```

The settings that differ from production:

```
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000

# Point at the DEV Supabase project, not production
SUPABASE_URL=https://your-dev-project.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
# Session pooler string — note the username carries the project ref
DATABASE_URL=postgresql://postgres.your-dev-ref:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres

# Do not send real email while testing
SMTP_ENABLED=false

# The scheduler is noisy in development; turn it on only when testing reminders
ENABLE_CRON=false

# No analytics on localhost
GA4_MEASUREMENT_ID=

# Encrypts payout details. Use a throwaway key here, NOT production's.
PAYOUT_ENCRYPTION_KEY=
```

Generate the session secret (96 hex characters):

```powershell
-join ((1..96) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

And the payout encryption key (64 hex characters — it must be exactly 32 bytes):

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Without that key the "How should we pay you" section on an agent's profile is
closed, and says so. Everything else works.

With `SMTP_ENABLED=false`, nothing is sent — every message is written to the
notification log as `skipped`, so you can still see exactly what *would* have
gone out, to whom, with the real rendered content. That is usually better for
testing than a real inbox.

---

## 4. Install and set up

```powershell
npm install
npm test
npm run db:push
npm run db:seed -- --sample
```

`npm test` runs the unit tests, compiles every template and checks every route's
view wiring. It needs no database and takes a few seconds. If it fails, stop
there — the app will not run either.

---

## 5. Google sign-in on localhost (optional)

If you want to test Google SSO locally, add to your **dev** Supabase project
under **Authentication → URL Configuration**:

- Site URL: `http://localhost:3000`
- Redirect URLs: `http://localhost:3000/auth/callback` and
  `http://localhost:3000/reset-password`

Or skip it and use email/password at `/signup` — the first account on an empty
database becomes an admin either way.

---

## 6. Run it

```powershell
npm run dev
```

`--watch` is on, so saving a file restarts the server. Open:

```
http://localhost:3000/healthz
```

You want `{"status":"ok","database":true,...}`. Then go to
**http://localhost:3000/signup** and create your account — first one in becomes
admin.

---

## 7. A test run worth doing

This exercises the parts that only break in combination:

1. **Admin → Settings** — press *Install defaults*. Confirm templates land.
2. **Admin → Campaigns** — open the sample campaign. Set a landing page URL.
   Add a second commission rank with recurring enabled.
3. **Agent side** — sign out, create a *second* account (this one will be an
   agent), join the campaign, copy the referral link.
4. **As a prospect** — open the referral link in a private window. Submit the
   form. Pick a timezone *different from Jamaica* — this is where timezone bugs
   surface. Complete the acknowledgement.
5. **Check the times** — the thank-you page should show your chosen time in the
   prospect's zone, and Jamaica time underneath. The agent's pipeline should
   show it in the agent's zone.
6. **Edit the appointment** from the prospect's link. Then cancel from it.
   Confirm the lead closed as lost and a note appeared on the timeline.
7. **Back as admin** — take a different lead to *closed / won*. Confirm a
   commission appears with the right amount for that rank.
8. **Admin → Notification log** — every message should be listed as `skipped`
   with its full rendered body. Open one and read it.
9. **Admin → Audit log** — the rank change, the close, the cancellation and the
   commission should all be there with before/after values.

If something breaks, the terminal running `npm run dev` has the stack trace.
Paste it and I will fix it.

---

## Testing the scheduler

Reminders normally wait for real time to pass. To test without waiting, set
`ENABLE_CRON=true`, set a reminder slot to fire *2 days* before, and book an
appointment about a day and a half out — the slot is due immediately.

You can also run any job by hand:

```powershell
node -e "require('./src/jobs/scheduler').runReminders().then(r => console.log(r)).then(() => process.exit())"
node -e "require('./src/jobs/scheduler').runMonthlyAccrual().then(r => console.log(r)).then(() => process.exit())"
node -e "require('./src/jobs/scheduler').runAccountReview().then(r => console.log(r)).then(() => process.exit())"
node -e "require('./src/jobs/scheduler').runStaleLeads().then(r => console.log(r)).then(() => process.exit())"
```

Each returns a summary of what it did and writes to `job_runs`, visible in
**Admin → Settings**.

---

## Checking the schema itself

If you have `psql` installed:

```powershell
npm run db:verify
```

Fifteen checks that the database really enforces the rules the app relies on —
one rank per agent per campaign, no double-paying a lead, no duplicate
reminders. Runs in a transaction and rolls back, so it leaves nothing behind.

---

## Resetting

To start from clean, run this in the **dev** Supabase SQL Editor, then re-run
`db:push` and `db:seed`:

```sql
drop schema public cascade;
create schema public;
```

Obviously never on production.
