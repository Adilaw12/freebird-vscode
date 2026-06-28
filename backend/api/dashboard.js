import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Simple password protection — set DASHBOARD_PASSWORD env var in Vercel
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

export default async function handler(req, res) {
    // Basic auth check
    if (DASHBOARD_PASSWORD) {
        const auth = req.headers['authorization'] || '';
        const expected = 'Basic ' + Buffer.from('admin:' + DASHBOARD_PASSWORD).toString('base64');
        if (auth !== expected) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Freebird Dashboard"');
            return res.status(401).send('Unauthorized');
        }
    }

    if (req.query.json !== undefined) {
        return sendJson(req, res);
    }

    return res.status(200).send(dashboardHtml());
}

async function sendJson(req, res) {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
    const data = { days: [] };

    for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const date = d.toISOString().slice(0, 10);

        const [events, backends, platforms, versions, errors, cloudCalls, uniqueIps] = await Promise.all([
            redis.hgetall(`telemetry:daily:${date}`),
            redis.hgetall(`telemetry:backends:${date}`),
            redis.hgetall(`telemetry:platforms:${date}`),
            redis.hgetall(`telemetry:versions:${date}`),
            redis.lrange(`telemetry:errors:${date}`, 0, 49),
            redis.get(`quota:global:${date}`),
            redis.scard(`monitor:ips:${date}`)
        ]);

        data.days.push({
            date,
            events: events || {},
            backends: backends || {},
            platforms: platforms || {},
            versions: versions || {},
            recentErrors: errors || [],
            cloudCalls: parseInt(cloudCalls ?? '0', 10),
            uniqueIps: uniqueIps || 0
        });
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
}

function dashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freebird AI — Analytics Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f0f1a; color: #cdd6f4; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.5em; margin-bottom: 4px; color: #d97757; }
  .subtitle { opacity: 0.4; font-size: 0.85em; margin-bottom: 24px; }
  .controls { display: flex; gap: 12px; margin-bottom: 24px; align-items: center; }
  select { background: #1e1e2e; color: #cdd6f4; border: 1px solid #313244; border-radius: 6px; padding: 6px 12px; font-size: 0.85em; }
  .refresh-btn { background: #d97757; color: #fff; border: none; border-radius: 6px; padding: 6px 16px; cursor: pointer; font-size: 0.85em; }
  .refresh-btn:hover { background: #e08867; }

  /* KPI row */
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #1e1e2e; border: 1px solid #313244; border-radius: 10px; padding: 16px; }
  .kpi-label { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.4; margin-bottom: 4px; }
  .kpi-value { font-size: 1.8em; font-weight: 700; color: #d97757; }
  .kpi-sub { font-size: 0.75em; opacity: 0.35; margin-top: 2px; }

  /* Sections */
  .section { background: #1e1e2e; border: 1px solid #313244; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .section h2 { font-size: 1em; margin-bottom: 12px; color: #89b4fa; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; padding: 6px 10px; opacity: 0.4; font-weight: 600; font-size: 0.78em;
       text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #313244; }
  td { padding: 6px 10px; border-bottom: 1px solid rgba(49,50,68,0.4); }
  tr:hover td { background: rgba(217,119,87,0.04); }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }

  /* Bar chart */
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .bar-label { min-width: 120px; font-size: 0.82em; text-align: right; }
  .bar-track { flex: 1; height: 20px; background: #181825; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #d97757, #e0a070); border-radius: 4px;
              transition: width 0.4s ease; min-width: 2px; }
  .bar-count { min-width: 50px; font-size: 0.82em; font-variant-numeric: tabular-nums; }

  .error-list { list-style: none; font-size: 0.82em; }
  .error-list li { padding: 4px 0; border-bottom: 1px solid rgba(49,50,68,0.3); display: flex; gap: 8px; }
  .error-name { color: #f48771; font-weight: 500; }
  .error-time { opacity: 0.3; }

  .loading { text-align: center; padding: 40px; opacity: 0.4; }
  .trend { font-size: 0.75em; margin-left: 6px; }
  .trend.up { color: #4caf50; }
  .trend.down { color: #f48771; }
</style>
</head>
<body>

<h1>Freebird AI Analytics</h1>
<p class="subtitle">Extension telemetry dashboard</p>

<div class="controls">
  <select id="days">
    <option value="7">Last 7 days</option>
    <option value="14" selected>Last 14 days</option>
    <option value="30">Last 30 days</option>
    <option value="90">Last 90 days</option>
  </select>
  <button class="refresh-btn" onclick="loadData()">Refresh</button>
</div>

<div id="content"><div class="loading">Loading analytics...</div></div>

<script>
async function loadData() {
  var days = document.getElementById('days').value;
  var res = await fetch('/api/dashboard?json&days=' + days);
  var data = await res.json();
  render(data);
}

function render(data) {
  var el = document.getElementById('content');
  if (!data.days || !data.days.length) { el.innerHTML = '<div class="loading">No data yet</div>'; return; }

  var today = data.days[0] || {};
  var yesterday = data.days[1] || {};
  var te = today.events || {};
  var ye = yesterday.events || {};

  // Aggregate totals across all days
  var totals = {};
  var totalSessions = 0;
  var backendTotals = {};
  var platformTotals = {};
  var versionTotals = {};

  data.days.forEach(function(d) {
    Object.keys(d.events || {}).forEach(function(k) {
      if (k === '_unique_sessions') { totalSessions += parseInt(d.events[k]) || 0; return; }
      totals[k] = (totals[k] || 0) + (parseInt(d.events[k]) || 0);
    });
    Object.keys(d.backends || {}).forEach(function(k) { backendTotals[k] = (backendTotals[k] || 0) + (parseInt(d.backends[k]) || 0); });
    Object.keys(d.platforms || {}).forEach(function(k) { platformTotals[k] = (platformTotals[k] || 0) + (parseInt(d.platforms[k]) || 0); });
    Object.keys(d.versions || {}).forEach(function(k) { versionTotals[k] = (versionTotals[k] || 0) + (parseInt(d.versions[k]) || 0); });
  });

  var todaySessions = parseInt(te._unique_sessions) || 0;
  var yesterdaySessions = parseInt(ye._unique_sessions) || 0;
  var todayMsgs = parseInt(te.message_sent) || 0;
  var yesterdayMsgs = parseInt(ye.message_sent) || 0;
  var todayUpgrades = parseInt(te.upgrade_clicked) || 0;
  var proMsgs = totals.pro_message || 0;
  var ollamaFallbacks = totals.ollama_fallback || 0;
  var totalMachines = totals._unique_machines || 0;
  var totalSubscribed = totals.pro_subscribed || 0;
  var todayCloudCalls = today.cloudCalls || 0;
  var yesterdayCloudCalls = yesterday.cloudCalls || 0;
  var todayUniqueIps = today.uniqueIps || 0;

  var html = '';

  // KPI row
  html += '<div class="kpi-row">';
  html += kpi('Sessions Today', todaySessions, trend(todaySessions, yesterdaySessions));
  html += kpi('Unique Machines', totalMachines, data.days.length + 'd window');
  html += kpi('Messages Today', todayMsgs, trend(todayMsgs, yesterdayMsgs));
  html += kpi('Cloud Calls Today', todayCloudCalls, trend(todayCloudCalls, yesterdayCloudCalls));
  html += kpi('Unique IPs Today', todayUniqueIps, 'abuse check: calls ÷ IPs');
  html += kpi('New Subscriptions', totalSubscribed, data.days.length + 'd total');
  html += '</div>';

  // Conversion funnel: wall shown → upgrade clicked → subscribed
  var fWall  = totals.quota_wall_shown || 0;
  var fClick = totals.upgrade_clicked || 0;
  var fPaid  = totals.pro_subscribed || 0;
  var rClick = fWall ? (fClick / fWall * 100) : 0;
  var rPaidOfClick = fClick ? (fPaid / fClick * 100) : 0;
  var rPaidOverall = fWall ? (fPaid / fWall * 100) : 0;

  html += '<div class="section"><h2>Conversion Funnel (' + data.days.length + 'd)</h2>';
  html += funnelRow('Quota wall shown', fWall, 100, 'top of funnel');
  html += funnelRow('Upgrade clicked', fClick, fWall ? (fClick / fWall * 100) : 0, rClick.toFixed(1) + '% of walls shown');
  html += funnelRow('Subscribed (paid)', fPaid, fWall ? (fPaid / fWall * 100) : 0,
    rPaidOfClick.toFixed(1) + '% of clicks · ' + rPaidOverall.toFixed(2) + '% overall');
  html += '</div>';

  // Feature popularity
  var featureEvents = ['message_sent','pro_message','cloud_edit_used','ollama_fallback',
    'inline_edit','ai_commit','chat_opened','upgrade_clicked','backend_configured','license_activated'];
  var featureData = featureEvents.map(function(k) { return { name: k, count: totals[k] || 0 }; })
    .sort(function(a,b) { return b.count - a.count; });
  var maxFeature = featureData.length ? featureData[0].count : 1;

  html += '<div class="section"><h2>Feature Popularity</h2>';
  featureData.forEach(function(f) {
    var pct = maxFeature > 0 ? (f.count / maxFeature * 100) : 0;
    html += '<div class="bar-row">';
    html += '<span class="bar-label">' + f.name.replace(/_/g, ' ') + '</span>';
    html += '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
    html += '<span class="bar-count num">' + f.count.toLocaleString() + '</span>';
    html += '</div>';
  });
  html += '</div>';

  // Backends & platforms side by side
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px">';

  html += '<div class="section"><h2>Backends</h2><table>';
  sorted(backendTotals).forEach(function(r) {
    html += '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>';
  });
  html += '</table></div>';

  html += '<div class="section"><h2>Platforms</h2><table>';
  sorted(platformTotals).forEach(function(r) {
    html += '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>';
  });
  html += '</table></div>';

  html += '<div class="section"><h2>Versions</h2><table>';
  sorted(versionTotals).forEach(function(r) {
    html += '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>';
  });
  html += '</table></div>';

  html += '</div>';

  // Daily trend table
  html += '<div class="section"><h2>Daily Trend</h2>';
  html += '<table><tr><th>Date</th><th>Sessions</th><th>Cloud Calls</th><th>Unique IPs</th><th>Messages</th><th>Pro Msgs</th><th>Upgrades</th><th>Subs</th></tr>';
  data.days.forEach(function(d) {
    var e = d.events || {};
    html += '<tr>';
    html += '<td>' + d.date + '</td>';
    html += '<td class="num">' + (e._unique_sessions || 0) + '</td>';
    html += '<td class="num">' + (d.cloudCalls || 0) + '</td>';
    html += '<td class="num">' + (d.uniqueIps || 0) + '</td>';
    html += '<td class="num">' + (e.message_sent || 0) + '</td>';
    html += '<td class="num">' + (e.pro_message || 0) + '</td>';
    html += '<td class="num">' + (e.upgrade_clicked || 0) + '</td>';
    html += '<td class="num">' + (e.pro_subscribed || 0) + '</td>';
    html += '</tr>';
  });
  html += '</table></div>';

  // Recent errors
  var allErrors = [];
  data.days.slice(0, 3).forEach(function(d) {
    (d.recentErrors || []).forEach(function(e) { allErrors.push(e); });
  });
  if (allErrors.length) {
    html += '<div class="section"><h2>Recent Errors (last 3 days)</h2><ul class="error-list">';
    allErrors.slice(0, 30).forEach(function(e) {
      var parts = e.split(':');
      html += '<li><span class="error-name">' + parts[0] + '</span><span class="error-time">x' + (parts[1]||1) + '</span></li>';
    });
    html += '</ul></div>';
  }

  el.innerHTML = html;
}

function kpi(label, value, sub) {
  return '<div class="kpi"><div class="kpi-label">' + label + '</div><div class="kpi-value">' +
    (typeof value === 'number' ? value.toLocaleString() : value) +
    '</div><div class="kpi-sub">' + (sub || '') + '</div></div>';
}

function funnelRow(label, count, pct, sub) {
  return '<div class="bar-row">'
    + '<span class="bar-label">' + label + '</span>'
    + '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div>'
    + '<span class="bar-count num">' + count.toLocaleString() + '</span>'
    + '<span style="min-width:200px;font-size:0.78em;opacity:0.4">' + (sub || '') + '</span>'
    + '</div>';
}

function trend(today, yesterday) {
  if (!yesterday) return '';
  var diff = today - yesterday;
  if (diff === 0) return '<span class="trend">→ same</span>';
  var cls = diff > 0 ? 'up' : 'down';
  var arrow = diff > 0 ? '↑' : '↓';
  return '<span class="trend ' + cls + '">' + arrow + ' ' + Math.abs(diff) + ' vs yesterday</span>';
}

function sorted(obj) {
  return Object.entries(obj).sort(function(a,b) { return b[1] - a[1]; });
}

document.getElementById('days').addEventListener('change', loadData);
loadData();
</script>
</body>
</html>`;
}
