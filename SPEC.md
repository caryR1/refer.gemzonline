# refer.GemzOnline — Requirements Specification

**Status:** draft for review · **Date:** 19 Aug 2026 · **Owner:** Cary Robinson

A referral and lead management platform for GemzOnline. Independent agents refer
prospects into campaigns and earn commissions. Built primarily for internal use,
structured so it can be sold to external clients later without a data migration.

---

## 1. Roles

| Role | Access |
|------|--------|
| **Admin** | Everything. Campaigns, commission profiles, agents, all leads, email templates, reports, settings, audit log. |
| **Agent** | Self-registers, opts into campaigns, generates referral links, manages their own leads, views their own earnings. Sees only their own data. |
| **Prospect** | Never logs in. Reaches the site via a referral link, submits the lead form, completes acknowledgement, and can later edit or cancel their appointment via a tokenised link. |

A future **super-admin** role sits above admin once the product is sold to
external clients. Not built now; the data model leaves room for it.

---

## 2. Multi-tenancy

Every table carries a `tenant_id`. Every query is scoped through a single
helper so there is exactly one place that has to be correct. Unique constraints
are per-tenant from day one — two tenants can each have a campaign called
`starter`.

There is **no tenant UI, signup, billing, or subdomain routing**. The system
runs as a single organisation ("GemzOnline") seeded at install. Selling this
later means building product surface, not migrating data.

---

## 3. Core concepts

### 3.1 Campaign (program)

The multi-tenant unit of work. Each campaign is independently configurable:

- Name, slug, client name, description, status (active / paused / archived)
- Currency
- Public-facing content: headline, subtext, CTA label, thank-you message
- **Landing page URL** — external, opens in a new tab, rendered on the referral
  page as *"Click here for more information"*
- Consent text and whether consent is required
- Whether an appointment is required
- Custom lead-form fields (typed: text, textarea, select, number)
- Internal notification recipients
- Welcome message template (campaign-specific, email and WhatsApp)
- **Three appointment reminder slots** (see §8.3)

Agents self-select which campaigns to promote. Joining is **instant** — the
referral link works immediately, no admin approval.

### 3.2 Commission profile (rank)

A campaign has **one or more named commission profiles** — these function as
ranks (e.g. "Standard", "Senior", "Partner"). Each profile carries its own
defaults:

- Initial commission: percentage or fixed amount
- Recurring commission: enabled/disabled, percentage or fixed, duration in
  months (blank = for as long as the account is active)
- Payout day of month
- **Deal value** — the basis percentage commissions calculate from
- Currency

The profile's deal value is authoritative. It is **not editable per lead** and
there is no override at closing — changing what a deal is worth means editing
the profile, or moving the agent to a different one. Both are audited.

One profile per campaign is flagged **default**. New members are assigned it
automatically. Admin can move any agent to a different profile at any time —
every such change is written to the audit log.

### 3.3 Agent campaign membership

The link between an agent and a campaign. Carries exactly one commission
profile. A unique constraint on (agent, campaign) enforces **one commission
profile per agent per campaign**. Holds join date, status, and the agent's
referral link for that campaign.

### 3.4 Referral link

Per agent, per campaign. Unguessable slug. Tracks click count and last-click
timestamp. Public URL: `/r/{slug}`.

### 3.5 Lead

Captured through a referral link. Carries contact details, the prospect's own
timezone, campaign custom-field answers, consent record, appointment times, and
the pipeline status.

**Pipeline:** `new → contacted → appointment_set → closed_won / closed_lost`

Agents can move a lead as far as `appointment_set`. The two closing transitions
are **admin only**, because closing is what creates a commission.

**Agent-to-prospect relation** — set by the agent (not asked of the prospect),
from an admin-editable dropdown, with a free-text context note alongside it.
Defaults: brother, sister, parent, child, cousin, other family, spouse/partner,
friend, close friend, neighbour, co-worker, former co-worker, business
associate, client, church member, teammate, classmate, acquaintance, other.

The relation appears on the lead detail, in the pipeline list, and as a variable
available to email templates and call scripts — so a caller can open with
"your sister Marcia suggested we speak."

### 3.6 Commission

One row per earned amount. Kind is `initial` or `recurring`. Status runs
`pending → approved → paid`, with `void` available. Tracking and statements
only — **no payment processing**. Every status change is audited.

---

## 4. Public funnel

1. **`/r/{slug}`** — campaign landing. Records the click, sets the attribution
   cookie, shows campaign headline/subtext/CTA and the *"Click here for more
   information"* link to the campaign's external landing page.
2. **Lead form** — standard contact fields plus the campaign's custom fields.
   Prospect selects their own timezone.
3. **Acknowledgement / consent page** — dynamic per campaign. Prospect reviews
   their details, picks a **primary** and **backup** appointment date/time in
   their own timezone, and gives consent. Also captures an optional **WhatsApp
   opt-in and number** — required before any WhatsApp message can be sent to a
   prospect. Footer carries an **Edit Appointment** link.
4. **Thank-you page** — campaign-specific message.

## 5. Prospect self-service

Reached by a long random token in the URL, no expiry, no login. Available from
the campaign welcome email and from the foot of the acknowledgement page.

- Change primary and/or backup appointment date and time
- **Cancel** — sets the lead to `closed_lost` with reason "prospect cancelled",
  clears the appointment times, notifies the agent and admin, logs a note, and
  suppresses further automated email. Reopening is a manual admin action.

Every prospect action is written to the audit log and the lead's note timeline.

---

## 6. Agent portal

- **Self-registration** via Google SSO (any Google account) or email/password
- **Dashboard** — leads by status, conversion rate, earnings this month,
  pending vs paid commission, recent activity
- **Campaigns** — browse available campaigns, join instantly, leave
- **Referral links** — one per campaign, copy button, click counts
- **My leads** — filterable pipeline, lead detail, add notes, set the relation,
  update status
- **Earnings** — commission history by period, pending/approved/paid breakdown,
  payout dates, CSV export
- **Profile** — full name, phone, WhatsApp number, **own timezone**, payout
  details, **notification preferences** (per event type, email and/or WhatsApp)
- **Password** — change while signed in, or request an emailed reset link

---

## 7. Admin console

- **Dashboard** — pipeline across all campaigns, lead volume, conversion,
  commission liability, recent activity
- **Campaigns** — full CRUD including landing page URL, custom fields, consent
  text, welcome template
- **Commission profiles** — CRUD per campaign, mark default, see which agents
  sit on each rank
- **Agents** — list, detail, activate/suspend, assign campaign memberships and
  move agents between commission profiles
- **Leads** — all leads, filter by campaign/agent/status/date, detail view with
  the full note timeline, status changes, appointment management, relation
- **Commissions** — review, approve, mark paid, adjust, void
- **Email templates** — CRUD, per-campaign or global, trigger event, variable
  reference, live preview, manual send
- **WhatsApp templates** — register Meta-approved template names, map variables
  to slots, per trigger event
- **Notification log** — every email and WhatsApp message, with channel,
  status, provider message ID and error detail
- **Notification preferences** — set any user's per-event channel switches;
  turning one off blocks it for that user (see §8.5)
- **Reports** — agent performance, campaign performance, commission statements,
  CSV export
- **Audit log** — filterable, read-only
- **Settings** — relation dropdown options, branding, notification recipients

---

## 8. Notifications — email and WhatsApp

One notification service sits behind both channels. An event fires once; the
service resolves which recipients want it, on which channels, and dispatches.

### 8.1 Email

Nodemailer over Hostinger SMTP. Templates are HTML with `{{variable}}`
placeholders and a variable reference in the editor. Freely editable.

### 8.2 WhatsApp

Provider-agnostic adapter with a **Meta WhatsApp Cloud API** implementation
shipped. Swapping to Twilio or another BSP means writing one adapter file.

**Important constraint:** WhatsApp does not permit free-form business-initiated
messages. Anything sent outside a 24-hour window opened by the customer must use
a **template pre-approved by Meta**. So WhatsApp templates in this app are
registered references to Meta-approved templates with ordered variable slots —
admins map variables to slots but cannot reword the message here. Rewording
means re-submitting to Meta. Prerequisites: verified WhatsApp Business Account,
dedicated number, per-message cost.

Prospects can only be messaged after explicit **WhatsApp opt-in** captured on
the acknowledgement page.

**Recipients:** agents, admin, and prospects.

### 8.3 Campaign appointment reminders

Each campaign has **three independent reminder slots**. Every slot has:

- An offset before the appointment, expressed in **hours or days**
  (e.g. 2 days / 48 hours / 1 hour)
- Channel selection: email, WhatsApp, both, or off
- Recipient selection: prospect, assigned agent, admin

**All three default to off.** Reminders key off the **primary appointment
time**, unless admin has marked the backup as the confirmed slot — reminders
then follow the confirmed time. A reminder is never sent twice for the same
lead and slot, and reminders stop the moment a lead is cancelled or closed.

### 8.4 Event triggers

lead created · consent given · appointment set · appointment rescheduled ·
prospect cancelled · status → contacted · closed won · closed lost · commission
approved · commission paid · recurring account cancelled · monthly commission
report · monthly recurring-account review · appointment reminders

### 8.5 Preferences

Every switch is **per event type, per channel** — e.g. new leads by WhatsApp
only, monthly report by email only, commission paid by both.

Preferences exist at two levels, and they resolve asymmetrically:

| Admin setting | User can... | Result |
|---|---|---|
| **Off** | not re-enable it | **Hard block** — the channel stays off for that event, full stop |
| **On** | mute it | Admin's value is a **default**; the user may switch it off for themselves |

In short: **admin can suppress, but cannot compel.** An admin who turns a
channel off has closed it; an admin who leaves it on has merely set the starting
point, and the user is free to mute.

Blocked switches render disabled in the user's preferences screen with a note
that admin has turned them off, so nobody wonders why a toggle won't move.
Admin changes to another user's preferences are written to the audit log.

### 8.6 Logging

Every dispatch on **either channel** — success or failure — is written to the
notification log with the rendered body, recipient, channel, trigger, provider
message ID and any error.

---

## 9. Audit log

Immutable, append-only. Records actor, action, target, before/after values,
IP and timestamp for:

- Commission profile and rank changes — including edits to the profiles
  themselves and moving an agent between ranks
- Payment and commission status changes — every `pending → approved → paid`
  transition, adjustment and void
- Lead status, appointment and consent changes — including prospect
  self-service reschedules and cancellations
- Account, login and campaign membership events — signups, password changes,
  role changes, campaign joins and leaves, suspensions

---

## 10. Scheduled jobs

- **Monthly commission report** — per campaign, on the profile's payout day,
  emailed to admin and to each agent
- **Recurring account monitor** — detects dropped accounts, notifies the agent
  and admin, stops future recurring commission accrual
- **Monthly recurring-account review** — emails admin the list of every
  currently-active recurring account, so nothing keeps paying out unnoticed
- **Appointment reminders** — runs frequently, dispatches any campaign reminder
  slot that has come due
- **Stale lead alert** — leads sitting untouched past a configurable threshold

---

## 11. Authentication

- Google SSO with open self-registration — any Google account signs in and
  becomes an active agent with no campaigns
- Email and password as an alternative
- In-app password change plus emailed reset link
- Supabase Auth throughout; sessions held in a signed HTTP-only cookie

---

## 12. Timezones

- Stored in UTC (`timestamptz`) throughout
- Staff see **their own timezone**, set on their profile, defaulting to Jamaica
  (UTC-5, no DST)
- Prospects see, and pick appointments in, their own timezone
- Emails that mention a time show **both** the prospect's local time and
  Jamaica time

---

## 13. Analytics

Google Analytics 4, measurement ID held in configuration. Tag fires on **public
referral pages only** — landing, lead form, acknowledgement, thank-you, and the
prospect self-service page. Admin and agent portals are untagged so internal
traffic never pollutes funnel reports.

---

## 14. Visual design

### 14.1 Palette

Navy blue primary, grey scale for structure and secondary text, white surfaces.
Applied consistently across the public funnel, both portals, and email
templates. A small warm accent range exists solely for illustration.

### 14.2 Illustration

**Sober interface, warm illustrations as accents.** The UI stays navy/grey/white
and professional; illustration carries the personality in a few chosen places.

Style: original vector work — rounded, chunky forms, soft gradients and warm
lighting, friendly and dimensional. Hand-authored SVG, not generated raster art,
so it stays crisp at any size and costs almost nothing to load. Not an imitation
of any specific studio's protected look.

Where it appears:

| Placement | Notes |
|---|---|
| Referral landing hero | The prospect's first impression. One shared default, overridable per campaign. |
| Email headers | Welcome, confirmation, reminder. **Rasterised to PNG** and served from `/img/` — email clients do not reliably render inline SVG. |
| Empty states & success screens | Thank-you page, "no leads yet", "no campaigns joined" — warmth where the app would otherwise feel dead. |
| Logo / wordmark | Header, favicon, email footer. |

All illustration ships as source SVG plus generated PNG at 1× and 2× for email
and social preview use.

---

## 15. Technical

| | |
|---|---|
| Runtime | Node.js 18+ / Express |
| Views | Server-rendered EJS — no build step |
| Database | PostgreSQL (Supabase) |
| Auth | Supabase Auth (email/password + Google) |
| Email | Nodemailer over Hostinger SMTP |
| WhatsApp | Provider adapter — Meta WhatsApp Cloud API implementation |
| Scheduling | node-cron |
| Hosting | Hostinger — VPS or hPanel Node.js, deploy guide covers both |

---

## 16. Resolved decisions

**Deal value.** The commission profile alone determines it. No per-lead value,
no override at closing, no admin edit field on the lead. Percentage commissions
calculate off the profile's deal value; fixed commissions ignore it. Changing
what a deal is worth means editing the profile or moving the agent to a
different rank — both audited.

**Closing a lead.** Admin only. Agents move their leads as far as
`appointment_set`; the `closed_won` and `closed_lost` transitions are admin
actions, since closing is what creates a commission. Agents can request a close
by leaving a note — the lead surfaces in an admin "awaiting close" view.

**Recurring account cancellation.** An `account_active` toggle on the lead,
flipped manually by admin. Turning it off records the drop date, stops future
recurring accrual, notifies the agent, and writes to the audit log. In addition,
a monthly job emails admin a review list of every currently-active recurring
account, so nothing keeps paying out unnoticed.

**Staff timezones.** Every staff member sets their own timezone on their
profile, defaulting to Jamaica (UTC-5, no DST). Prospect-facing times and all
emails continue to show both the prospect's local time and Jamaica time.

---

## 17. Explicitly out of scope

- Payment processing or payout disbursement (tracking only)
- Prospect logins or accounts
- Tenant signup, billing, per-tenant branding or subdomains
- SMS notifications
- Authoring or submitting WhatsApp templates to Meta for approval — that
  happens in Meta's console; this app references approved templates by name
- A native mobile app
