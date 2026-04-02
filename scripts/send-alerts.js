#!/usr/bin/env node
// Frost Alerts — nightly send script
// Runs via GitHub Actions every morning at ~6am UK time (cron: 0 5 * * *)
//
// Required environment variables (set as GitHub Actions secrets):
//   SUPABASE_URL       — e.g. https://xxxxxxxxxxxx.supabase.co
//   SUPABASE_SERVICE_KEY — service_role key (not anon key — needs to bypass RLS to read subscribers)
//   RESEND_API_KEY     — your Resend API key
//   SITE_URL           — public URL of your site, e.g. https://yourusername.github.io/frost

'use strict';

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY      = process.env.RESEND_API_KEY;
const SITE_URL            = process.env.SITE_URL || 'https://example.com';
const FROM_EMAIL          = process.env.FROM_EMAIL || 'onboarding@resend.dev';

// ── Frost algorithm (ported from index.html) ──────────────────────────────────

function dewpoint(t, rh) {
  var a = 17.27, b = 237.7;
  var g = (a * t / (b + t)) + Math.log(rh / 100);
  return (b * g) / (a - g);
}

function assessFrost(minT, wind, rh, cloud) {
  var dp          = dewpoint(minT, rh);
  var clearNight  = cloud < 25;
  var partlyClear = cloud < 60;

  var airFrost    = minT <= 0;
  var airPossible = minT <= 1.5;
  var groundFrost  = minT <= 0 || (minT <= 3 && wind < 9 && partlyClear);
  var groundLikely = minT <= 0 || (minT <= 3 && wind < 5 && clearNight);
  var hoarFrost    = dp < 0 && wind < 6 && clearNight;
  var hoarPossible = dp < 0.5 && wind < 9 && partlyClear;

  var score = 0;
  if (airFrost)          score += 3;
  else if (airPossible)  score += 2;
  else if (groundLikely) score += 1;
  if (groundLikely)      score += 1;
  if (hoarFrost)         score += 1;

  var level = 'none';
  if (score >= 4)                                      level = 'high';
  else if (score >= 2)                                 level = 'med';
  else if (score >= 1 || groundFrost || hoarPossible)  level = 'low';

  if (minT > 3) level = 'none';

  if (level === 'none') {
    airFrost = airPossible = groundFrost = groundLikely = hoarFrost = hoarPossible = false;
  }

  return { level, airFrost, airPossible, groundFrost, groundLikely, hoarFrost, hoarPossible, dp };
}

function ghBuffer(wind, cloud) {
  var base = wind > 12 ? 1.5 : wind > 6 ? 2.5 : 3.5;
  var adj  = cloud < 25 ? 0.5 : cloud > 60 ? -0.5 : 0;
  return Math.max(0.5, base + adj);
}

function levelLabel(level) {
  if (level === 'high') return 'HIGH';
  if (level === 'med')  return 'MEDIUM';
  if (level === 'low')  return 'LOW';
  return 'NONE';
}

function levelColour(level) {
  if (level === 'high') return '#cc2828';
  if (level === 'med')  return '#b87000';
  if (level === 'low')  return '#1a7a48';
  return '#5a82a0';
}

function fmt(t) { return (Math.round(t * 10) / 10).toFixed(1) + '°C'; }

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function supabaseFetch(path, opts = {}) {
  const url = SUPABASE_URL + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase error ' + res.status + ': ' + text);
  }
  return res.json();
}

async function getSubscribers() {
  return supabaseFetch('/rest/v1/subscribers?select=*');
}

async function setLastAlertedDate(id, date) {
  await supabaseFetch('/rest/v1/subscribers?id=eq.' + id, {
    method: 'PATCH',
    body: JSON.stringify({ last_alerted_date: date })
  });
}

// ── Weather fetch ─────────────────────────────────────────────────────────────

async function getWeather(lat, lon) {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&daily=temperature_2m_min,windspeed_10m_max,relative_humidity_2m_mean,cloud_cover_mean' +
    '&wind_speed_unit=mph&forecast_days=3&timezone=Europe%2FLondon';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Weather API error ' + res.status);
  const data = await res.json();
  const d = data.daily;
  return d.time.map(function(date, i) {
    return {
      date:  date,
      minT:  d.temperature_2m_min[i],
      wind:  d.windspeed_10m_max[i],
      rh:    d.relative_humidity_2m_mean[i],
      cloud: d.cloud_cover_mean[i]
    };
  });
}

// ── Email rendering ───────────────────────────────────────────────────────────

function buildEmail(subscriber, days) {
  const tonight   = days[0];
  const tomorrow  = days[1];
  const frost     = assessFrost(tonight.minT, tonight.wind, tonight.rh, tonight.cloud);
  const buf       = ghBuffer(tonight.wind, tonight.cloud);
  const ghMin     = tonight.minT + buf;
  const frostTmrw = assessFrost(tomorrow.minT, tomorrow.wind, tomorrow.rh, tomorrow.cloud);

  const riskColour = levelColour(frost.level);
  const riskLabel  = levelLabel(frost.level);

  const indicators = [];
  if (frost.airFrost)    indicators.push('Air frost likely');
  else if (frost.airPossible) indicators.push('Air frost possible');
  if (frost.groundLikely)  indicators.push('Ground frost likely');
  else if (frost.groundFrost) indicators.push('Ground frost possible');
  if (frost.hoarFrost)   indicators.push('Hoar frost likely');
  else if (frost.hoarPossible) indicators.push('Hoar frost possible');

  const tomorrowNote = frostTmrw.level !== 'none'
    ? '<p style="margin:16px 0 0;padding:12px 16px;background:#fff7e0;border-left:4px solid #b87000;border-radius:6px;font-size:14px;color:#704200;">' +
      '<strong>Tomorrow night</strong> also carries a ' + levelLabel(frostTmrw.level).toLowerCase() + ' frost risk (' + fmt(tomorrow.minT) + ' min).' +
      '</p>'
    : '';

  const unsubUrl = SITE_URL + '/unsubscribe.html?token=' + subscriber.token;
  const siteUrl  = SITE_URL + '/?lat=' + subscriber.lat + '&lon=' + subscriber.lon;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Frost Alert — ${subscriber.location_name}</title>
</head>
<body style="margin:0;padding:0;background:#f0f7fc;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;color:#0d2137;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7fc;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,80,160,0.10);">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(160deg,#1060a0,#1a7abf);padding:28px 32px;text-align:center;">
          <div style="font-size:36px;margin-bottom:8px;">❄️</div>
          <div style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:400;">Frost Alert</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px;">${subscriber.location_name}</div>
        </td>
      </tr>

      <!-- Risk banner -->
      <tr>
        <td style="padding:0;">
          <div style="background:${riskColour};color:#fff;text-align:center;padding:14px 24px;font-size:18px;font-weight:700;letter-spacing:0.5px;">
            ${riskLabel} FROST RISK TONIGHT
          </div>
        </td>
      </tr>

      <!-- Details -->
      <tr>
        <td style="padding:24px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-bottom:12px;">
                <span style="font-size:13px;color:#5a82a0;text-transform:uppercase;letter-spacing:0.5px;">Conditions</span>
              </td>
            </tr>
            <tr>
              <td>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f9fd;border-radius:10px;padding:16px;">
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Min temperature</span></td>
                    <td style="text-align:right;font-weight:600;">${fmt(tonight.minT)}</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Wind speed</span></td>
                    <td style="text-align:right;font-weight:600;">${Math.round(tonight.wind)} mph</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Humidity</span></td>
                    <td style="text-align:right;font-weight:600;">${Math.round(tonight.rh)}%</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Cloud cover</span></td>
                    <td style="text-align:right;font-weight:600;">${Math.round(tonight.cloud)}%</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Dewpoint</span></td>
                    <td style="text-align:right;font-weight:600;">${fmt(frost.dp)}</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;"><span style="color:#5a82a0;">Greenhouse min</span></td>
                    <td style="text-align:right;font-weight:600;">${fmt(ghMin)} <span style="color:#5a82a0;font-weight:400;font-size:13px;">(+${buf.toFixed(1)}°C buffer)</span></td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>

          ${indicators.length ? `
          <div style="margin-top:16px;">
            ${indicators.map(function(i) {
              return '<div style="display:inline-block;background:#e2eef8;color:#1a7abf;border-radius:20px;padding:4px 12px;font-size:13px;font-weight:600;margin:3px 4px 3px 0;">' + i + '</div>';
            }).join('')}
          </div>` : ''}

          ${tomorrowNote}

          <div style="margin-top:24px;text-align:center;">
            <a href="${siteUrl}" style="display:inline-block;background:#1a7abf;color:#fff;text-decoration:none;padding:12px 28px;border-radius:9px;font-weight:600;font-size:15px;">View full 16-day forecast →</a>
          </div>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:16px 32px 24px;border-top:1px solid #e2eef8;text-align:center;font-size:12px;color:#5a82a0;">
          You're subscribed as <strong>${subscriber.email}</strong> for ${subscriber.location_name}
          (${levelLabel(subscriber.threshold).toLowerCase()} risk threshold).<br>
          <a href="${unsubUrl}" style="color:#1a7abf;">Unsubscribe from this location</a>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text =
    'FROST ALERT — ' + subscriber.location_name + '\n' +
    riskLabel + ' FROST RISK TONIGHT\n\n' +
    'Min temperature: ' + fmt(tonight.minT) + '\n' +
    'Wind: ' + Math.round(tonight.wind) + ' mph\n' +
    'Humidity: ' + Math.round(tonight.rh) + '%\n' +
    'Cloud cover: ' + Math.round(tonight.cloud) + '%\n' +
    'Dewpoint: ' + fmt(frost.dp) + '\n' +
    'Greenhouse min: ' + fmt(ghMin) + ' (+' + buf.toFixed(1) + '°C buffer)\n\n' +
    (indicators.length ? indicators.join(', ') + '\n\n' : '') +
    'View forecast: ' + siteUrl + '\n\n' +
    'Unsubscribe: ' + unsubUrl;

  return { html, text };
}

// ── Resend email send ─────────────────────────────────────────────────────────

async function sendEmail(to, subject, html, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html, text })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Resend error ' + res.status + ': ' + err);
  }
  return res.json();
}

// ── Threshold check ───────────────────────────────────────────────────────────

function shouldAlert(threshold, level) {
  if (level === 'none') return false;
  if (threshold === 'high')   return level === 'high';
  if (threshold === 'medium') return level === 'high' || level === 'med';
  return true; // 'low' = any risk
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log('Frost Alerts — ' + today);
  console.log('Fetching subscribers...');
  const subscribers = await getSubscribers();
  console.log(subscribers.length + ' subscriber(s) found.');

  // Group by location to minimise API calls
  const byLocation = {};
  for (const sub of subscribers) {
    const key = sub.lat + ',' + sub.lon;
    if (!byLocation[key]) byLocation[key] = { lat: sub.lat, lon: sub.lon, subs: [] };
    byLocation[key].subs.push(sub);
  }

  let sent = 0, skipped = 0, errors = 0;

  for (const key of Object.keys(byLocation)) {
    const { lat, lon, subs } = byLocation[key];
    let days;
    try {
      days = await getWeather(lat, lon);
    } catch (err) {
      console.error('Weather fetch failed for ' + key + ':', err.message);
      errors += subs.length;
      continue;
    }

    const tonight = days[0];
    const frost   = assessFrost(tonight.minT, tonight.wind, tonight.rh, tonight.cloud);

    for (const sub of subs) {
      // Skip if already alerted today
      if (sub.last_alerted_date === today) {
        console.log('  SKIP (already sent today): ' + sub.email + ' @ ' + sub.location_name);
        skipped++;
        continue;
      }

      if (!shouldAlert(sub.threshold, frost.level)) {
        console.log('  SKIP (below threshold "' + sub.threshold + '", risk is "' + frost.level + '"): ' + sub.email);
        skipped++;
        continue;
      }

      const subject = '❄️ ' + levelLabel(frost.level) + ' frost risk tonight — ' + sub.location_name;
      const { html, text } = buildEmail(sub, days);

      try {
        await sendEmail(sub.email, subject, html, text);
        await setLastAlertedDate(sub.id, today);
        console.log('  SENT: ' + sub.email + ' @ ' + sub.location_name + ' [' + frost.level + ']');
        sent++;
      } catch (err) {
        console.error('  ERROR sending to ' + sub.email + ':', err.message);
        errors++;
      }
    }
  }

  console.log('\nDone. Sent: ' + sent + ', Skipped: ' + skipped + ', Errors: ' + errors);
  if (errors > 0) process.exit(1);
}

main().catch(function(err) {
  console.error('Fatal:', err);
  process.exit(1);
});
