# Deploying to Hostinger

Two paths, depending on what you bought. Read the first section either way —
the Supabase and SMTP setup is the same for both.

- **VPS** (full Linux box) → [Path A](#path-a--hostinger-vps). Recommended: the
  scheduler runs reliably, and you control restarts.
- **Shared / Business hosting** with hPanel's Node.js app manager → [Path B](#path-b--hpanel-nodejs-hosting).

Set aside about 45 minutes for a first deploy.

---

## 1. Before you start

You will need:

- A Supabase project (free tier is fine to begin with)
- A Hostinger mailbox for outbound email, e.g. `no-reply@gemzonline.com`
- The domain `rportal.gemzonline.com` pointing at your Hostinger hosting

### 1.1 Supabase

1. Create a project at supabase.com. Note the database password — you cannot
   see it again.
2. **Project Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` **(server only — never put
     this anywhere a browser can read)**
3. **Project Settings → API → JWT Settings**, copy the JWT Secret →
   `SUPABASE_JWT_SECRET`. This lets the app verify sessions locally instead of
   making a network call on every request. Worth doing.
4. **Project Settings → Database → Connection string** → choose **Session
   pooler**, copy it → `DATABASE_URL`. Replace `[YOUR-PASSWORD]` with the
   password from step 1.

   **Not the direct connection.** `db.<ref>.supabase.co` is IPv6-only unless you
   buy Supabase's IPv4 add-on, and most networks and hosts are IPv4-only — the
   hostname has no A record, so you get `getaddrinfo ENOTFOUND`, which reads
   like a typo but is not. The session pooler host
   (`aws-0-<region>.pooler.supabase.com`) has IPv4 and works everywhere.

   Note the username changes too: `postgres` becomes `postgres.<project-ref>`.

   **Not the transaction pooler either** (port 6543) — it does not support
   prepared statements, which node-postgres uses. Session pooler is port 5432.

   If your password contains `@ : / ? #` or `%`, URL-encode it (`@` → `%40`).
5. **Authentication → URL Configuration** — this is the list of places Supabase
   is allowed to send someone back to after signing in. Needed for password
   resets whether or not you use Google.
   - Site URL: `https://rportal.gemzonline.com`
   - Redirect URLs: add `https://rportal.gemzonline.com/auth/callback` and
     `https://rportal.gemzonline.com/reset-password`

   Anything not on this list is silently ignored and Supabase falls back to the
   Site URL — which reads as "sign-in worked but sent me to the wrong page"
   rather than as an error.
6. **Google sign-in** — see 1.5 below. It touches three places and the order
   matters, so it has a section of its own.

### 1.2 Hostinger email

In hPanel → **Emails → Email Accounts**, create the mailbox you will send from.
The SMTP settings are:

| Setting | Value |
|---|---|
| Host | `smtp.hostinger.com` |
| Port | `465` (SSL) or `587` (STARTTLS) |
| Security | SSL for 465, STARTTLS for 587 |
| Username | the full email address |
| Password | the mailbox password |

Set `SMTP_SECURE=true` for port 465, `false` for 587.

**Set up SPF and DKIM** in hPanel → Emails → DNS settings, or your welcome
emails will land in spam. This matters more than it sounds: the whole funnel
depends on the acknowledgement email arriving.

### 1.3 Google Analytics (optional)

Create a GA4 property, copy the Measurement ID (`G-XXXXXXXXXX`) into
`GA4_MEASUREMENT_ID`. It fires on public referral pages only — the admin and
agent portals are deliberately untagged so internal traffic never pollutes your
funnel reports.

### 1.4 WhatsApp (optional, later)

WhatsApp can be left off entirely; the app runs fine without it and logs
WhatsApp sends as `skipped`. When you are ready:

1. Create a Meta Business account and verify your business.
2. Add WhatsApp to a Meta app, attach a dedicated phone number (it cannot be a
   number already registered to a personal WhatsApp account).
3. **Submit your message templates for approval.** WhatsApp does not allow
   free-form business-initiated messages — every notification must use a
   template Meta has approved. Approval usually takes minutes to a day.
4. Copy the Phone Number ID and a permanent access token into
   `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`, set
   `WHATSAPP_ENABLED=true`.
5. In the app, create a WhatsApp template that references the approved template
   name and maps each `{{1}}`, `{{2}}` slot to a variable.

Start the business verification early if you want WhatsApp near launch — it is
on Meta's clock, not yours.

---

### 1.5 Google sign-in

Skip this if you only want email and password. Nothing else depends on it.

The thing that catches everyone: **Google does not point at your app.** It points
at Supabase, and Supabase then points at your app.

```
Google    →  https://<project-ref>.supabase.co/auth/v1/callback    Google's redirect URI
Supabase  →  https://rportal.gemzonline.com/auth/callback          Supabase's redirect list
```

Put this app's URL into Google's redirect field and you get
`redirect_uri_mismatch` forever, because Google is never the one talking to us.

**Google Cloud Console** — console.cloud.google.com

1. **APIs & Services → OAuth consent screen.** Choose **External**. Fill in the
   app name, your support email and the developer contact. Leave the scopes
   alone: this app reads only the signed-in person's email and name, so it needs
   nothing sensitive and therefore needs no verification review from Google.

2. **Credentials → Create credentials → OAuth client ID → Web application.**

   *Authorised JavaScript origins*
   ```
   https://rportal.gemzonline.com
   http://localhost:3000
   ```

   *Authorised redirect URIs* — Supabase's callbacks, not this app's. One Google
   client can serve both projects, which saves maintaining two:
   ```
   https://<production-ref>.supabase.co/auth/v1/callback
   https://<staging-ref>.supabase.co/auth/v1/callback
   ```

   Copy the **Client ID** and **Client secret**.

3. **Publish the consent screen.** While it says *Testing*, only email addresses
   explicitly listed as test users can sign in, capped at 100 — so agents
   self-registering will simply be refused. With only the default scopes,
   **Publish app** takes effect immediately; there is no review queue.

**Supabase** — in each project separately, because they are separate projects

4. **Authentication → Providers → Google.** Switch it on, paste the Client ID and
   secret, save. The page shows you its callback URL — check it matches what you
   gave Google character for character, including `https` and the absence of a
   trailing slash.

5. **Authentication → URL Configuration.** Already covered in 1.1 for production.
   For the staging project use `http://localhost:3000` for both the Site URL and
   the `/auth/callback` redirect.

**The app**

6. Nothing to do beyond `GOOGLE_SSO_ENABLED=true`, which is the default. The
   "Continue with Google" button only renders when that is on *and* the Supabase
   keys are present — so if the button is missing, the keys are the problem, not
   Google.

One dependency worth knowing: the app builds its `redirectTo` from `APP_URL`. If
production is still carrying a development `APP_URL`, Google will faithfully
send your agents to their own machines. Get `APP_URL` right first.

## Path A — Hostinger VPS

### A1. Prepare the server

SSH in as root, then:

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git nginx certbot python3-certbot-nginx
npm install -g pm2

# A non-root user to run the app
adduser --disabled-password --gecos "" refer
usermod -aG sudo refer
```

### A2. Get the code

```bash
su - refer
git clone https://github.com/caryR1/refer.gemzonline.git app
cd app
npm ci --omit=dev        # or: npm install --omit=dev
```

### A3. Configure

```bash
cp .env.example .env
nano .env
```

Fill in every value from section 1. Generate the session secret with:

```bash
openssl rand -hex 48
```

Lock the file down — it holds your service role key:

```bash
chmod 600 .env
```

### A4. Create the schema and seed

```bash
npm run db:push      # creates tables, indexes and RLS policies
npm run db:seed      # relationship options, a sample campaign, email templates
npm run create:admin -- you@gemzonline.com "Your Name" "a-strong-password"
```

Optional but reassuring — run the schema self-test:

```bash
npm run db:verify
```

### A5. Start it

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # run the command it prints, as root
```

Check it is alive:

```bash
curl localhost:3000/healthz
```

### A6. Nginx and SSL

Create `/etc/nginx/sites-available/rportal.gemzonline.com`:

```nginx
server {
    listen 80;
    server_name rportal.gemzonline.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        'upgrade';
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass                 $http_upgrade;
        proxy_read_timeout                 60s;
    }

    client_max_body_size 5M;
}
```

Then:

```bash
ln -s /etc/nginx/sites-available/rportal.gemzonline.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d rportal.gemzonline.com
```

Certbot handles the HTTPS redirect and sets up renewal.

`TRUST_PROXY=true` in `.env` is what makes the app read the real visitor IP from
`X-Forwarded-For` — important, because consent records store the IP.

### A7. Deploying updates

```bash
cd ~/app
git pull
npm ci --omit=dev
npm run db:push          # safe to run every time; it is idempotent
pm2 restart refer-gemzonline
```

---

## Path B — hPanel Node.js hosting

> **Use the right Git screen.** hPanel has two, and they are not
> interchangeable. **Websites → Git** serves files exactly as committed, runs no
> build step, and per Hostinger's own documentation does **not** support Node.js
> applications — connecting this repo there returns a 403. The one you want is
> **Advanced → Node.js → Import Git Repository**, which authorises GitHub
> separately and installs dependencies before starting the app.
>
> If GitHub authorisation still 403s on the Node.js screen, the Hostinger GitHub
> App does not have access to the repo. Grant it at
> **github.com/settings/installations → Hostinger → Repository access**.

Hostinger's Business and Cloud plans include a Node.js app manager. It works,
with two caveats worth knowing up front:

- **The scheduler only runs while the app process is alive.** Shared hosting may
  idle your app out. If reminders stop firing, that is why — see B7.
- You get less control over restarts and logs than on a VPS.

### B1. Create the application

hPanel → **Advanced → Node.js** → Create application:

| Field | Value |
|---|---|
| Node version | 20.x (or the highest offered) |
| Source | **Import Git Repository** → `caryR1/refer.gemzonline`, branch `main` |
| Application root | `refer-gemzonline` |
| Application URL | `rportal.gemzonline.com` |
| Application startup file | `src/server.js` |
| Build / install command | `npm install` |

### B2. Get the code up

The Git import in B1 handles this. If you would rather not connect GitHub,
upload the files over SFTP into the application root instead — but do not upload
`node_modules`; let hPanel install them.

### B3. Environment variables

In the Node.js app screen, add every variable from `.env.example` as an
environment variable. There is no `.env` file on this path — hPanel injects them.

Set `PORT` to whatever hPanel tells you to use (often it sets this itself —
leave it alone if so).

Five of them decide whether this is a working production deployment or a
development one that happens to be on the internet. Get these right first:

| Variable | Production value | What goes wrong otherwise |
|---|---|---|
| `NODE_ENV` | `production` | Stack traces are shown to visitors; cookies are not marked secure |
| `APP_URL` | `https://rportal.gemzonline.com` | Every referral and appointment link **emailed to a prospect** points at the server itself. The app refuses to send mail rather than post dead links, so email simply stops |
| `TRUST_PROXY` | `true` | Behind Hostinger's proxy, secure cookies are unreliable, rate limiting counts every visitor as one client, and the audit log records the proxy's IP for everyone |
| `SESSION_SECRET` | `openssl rand -hex 48` | Signed cookies are forgeable |
| `PAYOUT_ENCRYPTION_KEY` | `openssl rand -hex 32` | Agents cannot save bank details at all — the section is closed |

`PAYOUT_ENCRYPTION_KEY` is worth a second look. It encrypts agents' account
numbers before they are written. **Changing it does not re-encrypt what is
already stored** — every agent would have to enter their details again — so
treat it like a database password: back it up, and use a different one in
staging than in production.

Before you hit Restart, if you have a terminal:

```
npm run check:prod
```

It reads the configuration, makes one round trip each to the database, Supabase
and SMTP, and tells you exactly what would break. It changes nothing. Without a
terminal, **Admin → Settings** shows the same information once you are signed in.

### B4. Create the database schema

**No terminal needed.** Open the Supabase **SQL Editor** and run, in order:

1. the contents of `db/schema.sql`
2. every file in `db/migrations/`, in filename order
3. the contents of `db/policies.sql`

All of them are idempotent — re-run them after any upgrade that changes the
schema. `db/migrations/` is where everything added after the first release
lives; skipping it is why a column would be "missing" on an otherwise healthy
install.

If your plan does give you SSH or an hPanel terminal, `npm run db:push` does the
same thing in one command.

### B5. Sign in and finish setup

There is no `create:admin` step on this path, and none is needed: **the first
account created on an empty install automatically becomes an admin.** Visit
`/signup`, or sign in with Google, and you are in.

Then go to **Admin → Settings → First-run setup** and press **Install
defaults**. That installs the relationship options and the fifteen default
message templates — the thing that makes email actually send, since events with
no matching template send nothing. Tick "also create the sample campaign" if you
want something to click through before building your own.

The action is idempotent, so it is also how you restore a default template you
later delete by mistake.

### B6. Start it

Hit **Restart** in the Node.js app screen. Visit
`https://rportal.gemzonline.com/healthz` — you want `{"status":"ok"}`.

Enable SSL in hPanel → **Security → SSL** if it is not already on.

### B7. Keeping the scheduler alive

If the app idles out and reminders stop, the fix is an external ping. Any free
uptime monitor hitting `https://rportal.gemzonline.com/healthz` every 5 minutes
will keep it warm. That endpoint is cheap — one `select 1`.

If reminders still prove unreliable, move to a VPS. Scheduled work on shared
hosting is always a bit of a fight.

---

## 2. After deploying — a checklist

Work through this once; it catches most of what goes wrong.

- [ ] `https://rportal.gemzonline.com/healthz` returns `{"status":"ok"}`
- [ ] You can sign in at `/login` with the admin you created
- [ ] **Admin → Settings** shows database, email and (if configured) WhatsApp green
- [ ] **Admin → Settings → First-run setup** shows templates and relationship
      options installed (press **Install defaults** if not)
- [ ] Send yourself a test email from that page and it **arrives, not in spam**
- [ ] Google sign-in works from a browser you are not already signed into
- [ ] **Admin → Campaigns** shows the sample campaign, if you installed it;
      open `/r/automation-starter`
- [ ] Submit the form as a test prospect end to end: form → acknowledgement →
      thank you → the appointment link in your email
- [ ] The welcome email arrives with a working "edit appointment" link
- [ ] Cancel from that link, and check the lead closed as lost and the agent was told
- [ ] **Admin → Audit log** shows the actions you just took

Then set it up for real:

1. **Admin → Campaigns** — create your real campaign, set its landing page URL,
   write the consent wording, add any extra form questions.
2. **Commission ranks** — set the deal value and rates on each rank. Remember
   the rank's deal value is what percentages calculate from; there is no
   per-lead override anywhere.
3. **Reminders** — switch on the slots you want, pick channels and recipients.
4. **Templates** — review the seeded emails and make them sound like you.
5. **Agents** — let them sign up with Google, or add them yourself.

---

## 3. When something is wrong

**The site returns 503 on hPanel Node.js hosting.**
The process is not running, or is not reachable on the port Hostinger assigned.
A 503 *during* a deployment is normal — the app is down while dependencies
install and it restarts. If it persists:

- Check the app's **Logs** in hPanel → Advanced → Node.js. Startup now prints
  the node version, the bound host and port; a crash prints a stack trace.
- Confirm the **startup file is `src/server.js`** — not `server.js`. A generic
  guide will tell you the latter and the app will fail with "Cannot find module".
- Confirm the **build command is `npm install`** and it completed.
- Do not set `PORT` yourself; let Hostinger assign it. The app reads it.
- `npm audit` warnings are not a cause of 503. Do not run `npm audit fix
  --force` to chase one — it upgrades across major versions and can genuinely
  break the app.

Note that a missing `DATABASE_URL` will *not* cause a 503: the app boots anyway
and reports the problem on its pages and at `/healthz`.

**`/healthz` returns 200 but says `"database": false`.**
The app is running fine; it cannot reach Postgres. Check `DATABASE_URL` and
`DATABASE_SSL=true`. This endpoint returns 200 whenever the process is alive, so
a 503 from it means the app itself is not running.

**The site returns 502 (VPS).**
`pm2 logs refer-gemzonline --lines 100`. Usually a bad `DATABASE_URL` or a
missing environment variable. `pm2 restart refer-gemzonline` after fixing.

**Every page shows an error but `/healthz` says the database is down.**
Check `DATABASE_URL`.

If the error is `getaddrinfo ENOTFOUND db.<ref>.supabase.co`, you are using the
**direct connection string**, which is IPv6-only. Switch to the **session
pooler** string from the Supabase dashboard — different host, and the username
gains the project ref. See section 1.1 step 4.

Otherwise: the password must be substituted in (and URL-encoded if it contains
punctuation), and `DATABASE_SSL=true`.

**Email is not sending.**
Admin → Settings shows the exact SMTP error. Wrong password is the usual cause;
port/secure mismatch is next (465 needs `SMTP_SECURE=true`, 587 needs `false`).

**Email sends but lands in spam.**
SPF and DKIM are not set up. hPanel → Emails → DNS settings.

**Google says `redirect_uri_mismatch` before you even reach a password prompt.**
The redirect URI registered in Google Cloud Console is not exactly Supabase's
callback. It must be `https://<project-ref>.supabase.co/auth/v1/callback` — not
this app's address. Check for a trailing slash and for `http` where it should be
`https`.

**Google sign-in works, then lands on the wrong page.**
The app's redirect URL is not registered in Supabase → Authentication → URL
Configuration, so Supabase ignored it and fell back to the Site URL. Add
`https://rportal.gemzonline.com/auth/callback` exactly.

**"Access blocked: this app has not completed the Google verification process".**
The OAuth consent screen is still in *Testing*, where only listed test users can
sign in. Publish it — with the default scopes this is immediate.

**Google sign-in works locally but sends production users to localhost.**
`APP_URL` is wrong on the server. Every link the app builds, including the OAuth
return address, comes from it. `npm run check:prod` reports this.

**The "Continue with Google" button is missing entirely.**
It renders only when `GOOGLE_SSO_ENABLED` is on and the Supabase keys are set.
Admin → Settings shows whether the keys verified.

**Emails are not going out at all, and the log shows nothing.**
No templates are installed. Admin → Settings → First-run setup → Install
defaults. An event with no matching template sends nothing and logs nothing.

**Reminders are not firing.**
Check Admin → Settings → Scheduled job history. If nothing is listed, the
scheduler is not running: confirm `ENABLE_CRON=true` and, on shared hosting, see
B7. If jobs are listed but nothing sent, check that a template exists with the
"Appointment reminder" trigger on the channel you enabled, and that the reminder
slot is switched on for that campaign.

**WhatsApp says "skipped" in the notification log.**
It is not configured, or the number has no opt-in. Prospects must tick the
WhatsApp box on the acknowledgement page before anything can be sent to them.

**A commission came out at the wrong amount.**
The rank's deal value is the basis. Admin → Campaigns → the campaign → the rank.
Changing it affects commissions created from then on, not ones already recorded.

---

## 4. Backups

Supabase takes daily backups on paid plans. On the free tier, take your own:

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F).sql
```

Worth a weekly cron job. The audit log is the part you cannot reconstruct.
