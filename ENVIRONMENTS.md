# Environments

Two Supabase projects, one codebase.

| | Staging | Production |
|---|---|---|
| Runs on | your machine, `npm run dev` | Hostinger |
| URL | `http://localhost:3000` | `https://rportal.gemzonline.com` |
| Supabase project | the test project | the live project |
| `NODE_ENV` | `development` | `production` |
| Config lives in | `.env` (never committed) | Hostinger environment variables |
| Email | `SMTP_ENABLED=false` — logged, not sent | live |
| Scheduler | `ENABLE_CRON=false` | `ENABLE_CRON=true` |
| Data | disposable | real people |

---

## The rule that matters

**Every Supabase value must come from the same project.** The URL, the keys and
the connection string are four separate things and it is easy to update one and
forget another — which produces accounts in one project and their profile rows
in another. It half-works, which makes it hard to spot.

The app now refuses to start if `SUPABASE_URL` and `DATABASE_URL` name different
projects, and prints the project ref on every boot:

```
  Environment: DEVELOPMENT
  Supabase project: chqaqjyjglpehmlvwtom
  Tenant: GemzOnline (gemzonline)
```

Every non-production page also carries an orange banner showing the environment
and project. If you see it on rportal.gemzonline.com, `NODE_ENV` is wrong there.

---

## Making a change

**1. Change it locally.** Edit code, run `npm run dev`, click through it.

**2. If the schema changed**, edit `db/schema.sql` and apply to staging:

```powershell
npm run db:push
```

The file is idempotent — additive changes (new table, new column, new index)
apply cleanly to a database that already has data. Destructive changes are not
handled automatically; see below.

**3. Prove it still holds together:**

```powershell
npm test          # unit tests, template compilation, route wiring
npm run db:verify # the database really enforces the rules (needs psql)
```

**4. Commit and push:**

```powershell
git add -A
git commit -m "what changed and why"
git push
```

**5. Deploy.** In hPanel → Advanced → Node.js, pull the new commit and
**Restart**.

**6. If the schema changed, apply it to production too.** This is the step that
is easy to forget and produces confusing errors when missed — the code expects a
column the live database does not have. Either:

- run `npm run db:push` locally with `DATABASE_URL` temporarily pointed at
  production (it will make you type the project ref to confirm), or
- paste the changed part of `db/schema.sql` into the **production** Supabase SQL
  Editor.

**7. Check production is healthy:** `https://rportal.gemzonline.com/healthz`
should report `"status":"ok"` and `"database":true`.

---

## Schema changes that need care

`db/schema.sql` uses `create table if not exists` and `create index if not
exists`, so it is safe to re-run. That covers most changes:

| Change | Safe to just re-run? |
|---|---|
| New table | Yes |
| New index | Yes |
| New column | **No** — `create table if not exists` skips the whole table |
| Renaming or dropping anything | No |
| Changing a column type | No |

For those, add an explicit statement to `db/schema.sql`, written so it is also
idempotent:

```sql
alter table leads add column if not exists referral_note text;
```

Put such statements after the table definitions, so they apply to databases
created before the change as well as fresh ones.

---

## Keeping staging honest

Staging drifts from production over time — different campaigns, different data,
schema applied in a different order. Two habits keep it useful:

**Reset it when it gets messy.** In the **staging** Supabase SQL Editor:

```sql
drop schema public cascade;
create schema public;
```

Then `npm run db:push` and `npm run db:seed -- --sample`. Takes a minute, and it
proves your schema still builds from nothing — which is exactly what a new
deployment does.

**Never point staging at production data.** Copying real leads into staging puts
real people's contact details somewhere with weaker controls and looser habits.
If you need realistic volume, generate it.

---

## Switching your local `.env` between projects

Keep both sets of values, with one commented out:

```
# --- STAGING (active) ---
SUPABASE_URL=https://chqaqjyjglpehmlvwtom.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
DATABASE_URL=postgresql://postgres.chqaqjyjglpehmlvwtom:...@aws-0-us-east-2.pooler.supabase.com:5432/postgres

# --- PRODUCTION (commented out) ---
# SUPABASE_URL=https://fqqqwizdjbkrtdxlanww.supabase.co
# SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
# SUPABASE_SECRET_KEY=sb_secret_...
# DATABASE_URL=postgresql://postgres.fqqqwizdjbkrtdxlanww:...@aws-0-us-east-2.pooler.supabase.com:5432/postgres
```

Switch all four together, never one at a time. The startup line tells you which
you are on; if it disagrees with what you expected, stop before doing anything
else.
