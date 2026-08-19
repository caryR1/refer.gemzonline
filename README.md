# refer.GemzOnline

**Multi-tenant Referral and Lead Management Platform**

A generalized, multi-tenant referral and lead management platform designed for independent contractors and service platforms. Hosted at **[refer.GemzOnline.com](https://refer.GemzOnline.com)**.

## Overview

refer.GemzOnline lets independent agents earn commissions by referring prospects into custom programs/campaigns. It provides a complete CRM-style pipeline from public lead capture through appointment scheduling, commission tracking, and automated communications.

## Core Features

- **Multi-tenant programs / campaigns** — dynamically defined, each with custom parameters, tracking links, and rules
- **Public & dynamic referral links** — per-agent, per-program tracking slugs
- **Lead pipeline** — `new -> contacted -> appointment_set -> closed_won / closed_lost`
- **Dynamic acknowledgement + consent page** — with primary and backup appointment date/time and timezone pickers
- **Flexible commission profiles** — per-agent, per-program; initial (percentage or fixed) + optional recurring, with configurable payout day
- **Multi-note interaction log** — timestamped activity notes on every lead
- **Automated email engine** — custom drag-and-drop templates, event triggers, manual sends, and full audit log (Nodemailer over Hostinger SMTP)
- **Scheduled reporting** — automated monthly commission reports (variable per program/campaign), active-account-drop alerts
- **Timezone-aware** — staff see Jamaica time (UTC-5, no DST), prospects see their own local time, emails show both

## Tech Stack

- **Backend:** Node.js / Express
- **Database:** PostgreSQL (Supabase)
- **Auth:** Supabase Auth (with Row Level Security)
- **Email:** Nodemailer over Hostinger SMTP
- **Scheduling:** node-cron
- **Hosting:** Hostinger — refer.GemzOnline.com

## User Roles

| Role | Description |
|------|-------------|
| **Admin** | Manages programs, agents, commission profiles, leads, and email templates |
| **Agent / Affiliate** | Generates referral links, tracks leads, monitors earnings and payouts |
| **Client / Prospect** | Enters via a referral link, completes lead capture and acknowledgement |

## Status

Under active development.
