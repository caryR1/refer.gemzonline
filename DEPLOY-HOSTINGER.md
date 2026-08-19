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
- The domain `refer.gemzonline.com` pointing at your Hostinger hosting

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
4. **Project Settings → Database → Connection string → URI**, copy it →
   `DATABASE_URL`. Replace `[YOUR-PASSWORD]` with the password from step 1.
5. **Authentication → Providers → Google**: switch it on, paste in your Google
   OAuth client ID and secret (create them in Google Cloud Console → APIs &
   Services → Credentials → OAuth client ID → Web application).
6. **Authentication → URL Configuration**:
   - Site URL: `https://refer.gemzonline.com`
   - Redirect URLs: add `https://refer.gemzonline.com/auth/callback` and
     `https://refer.gemzonline.com/reset-password`

   In Google Cloud Console, the authorised redirect URI is Supabase's own
   callback — `https://<your-project>.supabase.co/auth/v1/callback` — not this
   app's. Supabase then forwards to `/auth/callback` here.

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

Create `/etc/nginx/sites-available/refer.gemzonline.com`:

```nginx
server {
    listen 80;
    server_name refer.gemzonline.com;

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
ln -s /etc/nginx/sites-available/refer.gemzonline.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d refer.gemzonline.com
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

Hostinger's Business and Cloud plans include a Node.js app manager. It works,
with two caveats worth knowing up front:

- **The scheduler only runs while the app process is alive.** Shared hosting may
  idle your app out. If reminders stop firing, that is why — see B6.
- You get less control over restarts and logs than on a VPS.

### B1. Create the application

hPanel → **Advanced → Node.js** → Create application:

| Field | Value |
|---|---|
| Node version | 20.x (or the highest offered) |
| Application root | `refer-gemzonline` |
| Application URL | `refer.gemzonline.com` |
| Application startup file | `src/server.js` |

### B2. Get the code up

Either use hPanel's Git integration pointing at
`https://github.com/caryR1/refer.gemzonline.git`, or upload the files over SFTP
into the application root. Do not upload `node_modules`.

### B3. Environment variables

In the Node.js app screen, add every variable from `.env.example` as an
environment variable. There is no `.env` file on this path — hPanel injects them.

Set `PORT` to whatever hPanel tells you to use (often it sets this itself —
leave it alone if so).

### B4. Install and migrate

Use the **Run NPM Install** button, then hPanel's terminal (or SSH if your plan
has it):

```bash
cd ~/refer-gemzonline
npm run db:push
npm run db:seed
npm run create:admin -- you@gemzonline.com "Your Name" "a-strong-password"
```

If your plan has no terminal at all, run these three commands from your own
machine instead — they only need `DATABASE_URL` and the Supabase keys, and they
work from anywhere:

```bash
git clone https://github.com/caryR1/refer.gemzonline.git
cd refer.gemzonline
npm install
cp .env.example .env      # fill in the same values you set in hPanel
npm run db:push && npm run db:seed && npm run create:admin
```

### B5. Start it

Hit **Restart** in the Node.js app screen. Visit
`https://refer.gemzonline.com/healthz` — you want `{"status":"ok"}`.

Enable SSL in hPanel → **Security → SSL** if it is not already on.

### B6. Keeping the scheduler alive

If the app idles out and reminders stop, the fix is an external ping. Any free
uptime monitor hitting `https://refer.gemzonline.com/healthz` every 5 minutes
will keep it warm. That endpoint is cheap — one `select 1`.

If reminders still prove unreliable, move to a VPS. Scheduled work on shared
hosting is always a bit of a fight.

---

## 2. After deploying — a checklist

Work through this once; it catches most of what goes wrong.

- [ ] `https://refer.gemzonline.com/healthz` returns `{"status":"ok"}`
- [ ] You can sign in at `/login` with the admin you created
- [ ] **Admin → Settings** shows database, email and (if configured) WhatsApp green
- [ ] Send yourself a test email from that page and it **arrives, not in spam**
- [ ] Google sign-in works from a browser you are not already signed into
- [ ] **Admin → Campaigns** shows the sample campaign; open `/r/automation-starter`
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

**The site returns 502 (VPS).**
`pm2 logs refer-gemzonline --lines 100`. Usually a bad `DATABASE_URL` or a
missing environment variable. `pm2 restart refer-gemzonline` after fixing.

**Every page shows an error but `/healthz` says the database is down.**
Check `DATABASE_URL`. Supabase connection strings need the password substituted
in, and `DATABASE_SSL=true`. If you are behind a restrictive firewall, use the
Session pooler URI on port 5432.

**Email is not sending.**
Admin → Settings shows the exact SMTP error. Wrong password is the usual cause;
port/secure mismatch is next (465 needs `SMTP_SECURE=true`, 587 needs `false`).

**Email sends but lands in spam.**
SPF and DKIM are not set up. hPanel → Emails → DNS settings.

**Google sign-in bounces back to the login page.**
The redirect URL is not registered in Supabase → Authentication → URL
Configuration. It must be exactly `https://refer.gemzonline.com/auth/callback`.

**Reminders are not firing.**
Check Admin → Settings → Scheduled job history. If nothing is listed, the
scheduler is not running: confirm `ENABLE_CRON=true` and, on shared hosting, see
B6. If jobs are listed but nothing sent, check that a template exists with the
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
