# ❄️ Frost Risk Checker — with Email Alerts

A 16-day air, ground and hoar frost risk forecast for any UK location. Designed for gardeners, smallholders and anyone protecting seedlings, tender plants or an unheated greenhouse.

This fork adds an **opt-in email alert service**: subscribers receive a morning email on days when frost is forecast above their chosen threshold.

---

## Features

- **16-day forecast** — reliable for the first 7 days; days 8–16 are shown with an accuracy warning
- **Three frost types assessed independently** — air frost, ground frost, and hoar frost
- **Unheated greenhouse estimate** — minimum inside temperature adjusted for wind speed and cloud cover
- **Tonight's summary banner** — at-a-glance risk level, min temp, wind, cloud cover, and greenhouse estimate
- **UK location lookup** — accepts full or partial postcodes (via postcodes.io) or place names (via Open-Meteo geocoding)
- **Use my location** — one-click geolocation via the browser
- **Shareable links** — copies a URL with coordinates
- **Email alerts** — subscribe from the page; alerts sent automatically each morning at ~6am

---

## Frost algorithm

### Scoring

| Condition | Points |
|---|---|
| Air frost (min ≤ 0 °C) | +3 |
| Air frost possible (min ≤ 1.5 °C) | +2 |
| Ground frost likely | +1 (cumulative) |
| Hoar frost | +1 |

**Ground frost likely:** min ≤ 0 °C, OR (min ≤ 3 °C AND wind < 5 mph AND cloud < 25%)  
**Ground frost possible:** min ≤ 0 °C, OR (min ≤ 3 °C AND wind < 9 mph AND cloud < 60%)  
**Hoar frost:** dewpoint < 0 °C AND wind < 6 mph AND cloud < 25%  
**Hoar frost possible:** dewpoint < 0.5 °C AND wind < 9 mph AND cloud < 60%

### Risk levels

| Score | Level |
|---|---|
| ≥ 4 | **High** |
| ≥ 2 | **Medium** |
| ≥ 1, or ground/hoar possible | **Low** |
| min > 3 °C (override) | **None** |

### Greenhouse buffer

| Wind | Base buffer |
|---|---|
| > 12 mph | 1.5 °C |
| 6–12 mph | 2.5 °C |
| ≤ 6 mph | 3.5 °C |

Cloud adjustment: −0.5 °C if overcast (> 60%), +0.5 °C if clear (< 25%). Minimum buffer: 0.5 °C.

---

## Setting up the alert service

The alerts system uses three services:

| Service | Purpose | Free tier |
|---|---|---|
| [Supabase](https://supabase.com) | Stores subscriber data (PostgreSQL) | 500 MB, 50,000 rows |
| [Resend](https://resend.com) | Sends emails | 3,000 emails/month |
| GitHub Actions | Runs the nightly cron job | 2,000 min/month |

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project.
2. In the **SQL Editor**, paste and run the contents of `supabase/schema.sql`.
3. Note your **Project URL** and **anon key** (Settings → API). Also note the **service_role key** — keep this secret and never commit it to git.

### 2. Create a Resend account

1. Sign up at [resend.com](https://resend.com).
2. Add and verify your sending domain (or use Resend's onboarding domain for testing).
3. Create an **API key** with "Sending access".

### 3. Configure index.html

At the top of the `<script>` block in `index.html`, replace the three placeholder values:

```js
var SUPABASE_URL      = 'https://xxxxxxxxxxxx.supabase.co';
var SUPABASE_ANON_KEY = 'eyJ...your anon key...';
var SITE_URL          = 'https://yourusername.github.io/frost-alerts';
```

Do the same in `unsubscribe.html`:

```js
var SUPABASE_URL      = 'https://xxxxxxxxxxxx.supabase.co';
var SUPABASE_ANON_KEY = 'eyJ...your anon key...';
```

### 4. Add GitHub Actions secrets

In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service_role** key (not anon) |
| `RESEND_API_KEY` | Your Resend API key |
| `SITE_URL` | Public URL of your deployed site |
| `FROM_EMAIL` | Sender address, e.g. `Frost Alerts <alerts@yourdomain.com>` |

### 5. Deploy

Push to GitHub. GitHub Pages will serve the site. The Actions workflow (`frost-alerts.yml`) runs automatically at 5:00 UTC (≈ 6am UK time) each day.

To test manually: go to **Actions → Send Frost Alerts → Run workflow**.

---

## Alert thresholds

Subscribers choose one of three options:

| Option | Sends when... |
|---|---|
| High only | Frost risk score ≥ 4 (air frost likely) |
| Medium or above | Score ≥ 2 |
| Any risk | Any frost risk detected |

---

## Data sources

- **Weather:** [Open-Meteo](https://open-meteo.com) — free, no API key required
- **UK postcodes:** [postcodes.io](https://postcodes.io) — free, open data
- **Place names:** Open-Meteo Geocoding API

---

## Tech stack

- Vanilla HTML/CSS/JS — no frontend build step
- Node.js (GitHub Actions) for the nightly alert script
- Supabase (PostgreSQL + REST API) for subscriber storage
- Resend for transactional email
- GitHub Pages for hosting
