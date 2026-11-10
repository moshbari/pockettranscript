// 💰 OpenAI cost tracker — what each kind of activity costs Get Transcript.
//
// Every OpenAI call made for Get Transcript calls track() with the usage
// OpenAI sends back (exact token counts, or audio minutes for Whisper). Money
// is worked out from OpenAI's own price list (PRICES below, checked 10 Nov
// 2026 on developers.openai.com/api/docs/pricing; override with PRICES_JSON).
//
// Stored as daily totals on the /data volume (costs.json), so it survives
// redeploys and stays tiny: day → activity → model → numbers, plus
// day → device → dollars for the "who costs most" list. Kept 400 days.
//
// Private page: /costs/<REPLY_KEY> (same key as the other admin pages; any
// other key looks like a missing page). JSON at /api/costs/<REPLY_KEY>.

const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'costs.json');
const KEY = process.env.REPLY_KEY || '';
const KEEP_DAYS = 400;

// $ per 1M tokens (input / cached input / output), Standard tier.
// Image models: text in / image in / image out. Whisper: $ per minute.
const PRICES = Object.assign({
  'gpt-6.1-sol':   { in: 2.00, cached: 0.10, out: 10.00 },
  'gpt-6.1-terra': { in: 1.00, cached: 0.05, out: 5.00 },
  'gpt-6-sol':     { in: 2.00, cached: 0.20, out: 10.00 },
  'gpt-6-luna':    { in: 0.10, cached: 0.01, out: 0.50 },
  'gpt-6-astra':   { in: 10.00, cached: 1.00, out: 50.00 },
  'gpt-image-2':   { in: 5.00, cached: 1.25, imageIn: 8.00, out: 30.00 },
  'whisper-1':     { perMinute: 0.006 },
  'omni-moderation': { free: true },
}, safeJson(process.env.PRICES_JSON));

// What each activity is called on the page, and who pays for it today.
const ACTIVITIES = {
  transcript_whisper: { name: 'Transcripts (Whisper: non-YouTube links, files, caption-less videos)', note: 'on the Get Transcript key (shared transcriber, tagged, since 10 Nov 2026)' },
  reply_coach:        { name: 'Reply Coach: new comment' },
  reply_refine:       { name: 'Reply Coach: Shorter / In Bangla / refine' },
  create_text:        { name: 'Make it here: post / thread / comment' },
  create_image:       { name: 'Make it here: picture' },
  moderation:         { name: 'Community safety check' },
  screenshots_read:   { name: 'Reading screenshots of text posts' },
  auto_title:         { name: 'Auto titles for saved posts' },
};

function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

let store = { days: {} };
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!store.days) store = { days: {} }; } catch { /* first run */ }

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(store));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('[costs] save failed:', e.message); }
  }, 2000);
}
process.on('SIGTERM', () => { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch { /* best effort */ } });

const today = () => new Date().toISOString().slice(0, 10);

// Model names come back dated ("gpt-6.1-sol-2026-09-01"): use the longest known prefix.
function priceFor(model) {
  const m = String(model || '');
  let best = null;
  for (const k of Object.keys(PRICES)) if (m.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? PRICES[best] : null;
}

/** Dollars for one call. usage = what OpenAI returned; minutes for Whisper. */
function dollars(model, usage = {}, minutes = 0) {
  const p = priceFor(model);
  if (!p || p.free) return 0;
  if (p.perMinute) return minutes * p.perMinute;
  const M = 1e6;
  // Chat completions: prompt_tokens / completion_tokens (+ cached part).
  if (usage.prompt_tokens != null) {
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;
    return ((usage.prompt_tokens - cached) * p.in + cached * (p.cached ?? p.in) + (usage.completion_tokens || 0) * p.out) / M;
  }
  // Image generation: input_tokens (text + image parts) / output_tokens.
  const d = usage.input_tokens_details || {};
  const imgIn = d.image_tokens || 0;
  const textIn = d.text_tokens != null ? d.text_tokens : (usage.input_tokens || 0) - imgIn;
  return (textIn * p.in + imgIn * (p.imageIn ?? p.in) + (usage.output_tokens || 0) * p.out) / M;
}

/**
 * Record one OpenAI call. Never throws: a tracking hiccup must not break the app.
 * track('reply_coach', { model, usage, device })  ·  track('transcript_whisper', { model: 'whisper-1', minutes, device })
 */
function track(activity, { model, usage, minutes = 0, device = '' } = {}) {
  try {
    const usd = dollars(model, usage || {}, minutes);
    const u = usage || {};
    const day = (store.days[today()] ||= { acts: {}, devices: {} });
    const act = (day.acts[activity] ||= {});
    const name = String(model || 'unknown').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const row = (act[name] ||= { calls: 0, inTok: 0, cachedTok: 0, outTok: 0, minutes: 0, usd: 0 });
    row.calls += 1;
    row.inTok += u.prompt_tokens ?? u.input_tokens ?? 0;
    row.cachedTok += u.prompt_tokens_details?.cached_tokens || 0;
    row.outTok += u.completion_tokens ?? u.output_tokens ?? 0;
    row.minutes += minutes;
    row.usd += usd;
    if (device) day.devices[device] = (day.devices[device] || 0) + usd;
    if (!priceFor(model)) console.warn(`[costs] no price for model "${model}" (${activity}); counted as $0`);
    prune();
    save();
  } catch (e) { console.warn('[costs] track failed:', e.message); }
}

function prune() {
  const cut = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(store.days)) if (d < cut) delete store.days[d];
}

// ---------------------------------------------------------------- report ---
function report(daysBack) {
  const cut = new Date(Date.now() - (daysBack - 1) * 86400000).toISOString().slice(0, 10);
  const acts = {}, devices = {}, perDay = {};
  let total = 0;
  for (const [d, day] of Object.entries(store.days)) {
    if (d < cut) continue;
    perDay[d] = 0;
    for (const [a, models] of Object.entries(day.acts)) {
      for (const [m, r] of Object.entries(models)) {
        const t = (acts[a] ||= { calls: 0, inTok: 0, cachedTok: 0, outTok: 0, minutes: 0, usd: 0, models: new Set() });
        for (const k of ['calls', 'inTok', 'cachedTok', 'outTok', 'minutes', 'usd']) t[k] += r[k] || 0;
        t.models.add(m);
        perDay[d] += r.usd; total += r.usd;
      }
    }
    for (const [dev, usd] of Object.entries(day.devices || {})) devices[dev] = (devices[dev] || 0) + usd;
  }
  const activities = Object.entries(acts)
    .map(([id, t]) => ({ id, name: ACTIVITIES[id]?.name || id, note: ACTIVITIES[id]?.note || '', ...t, models: [...t.models] }))
    .sort((a, b) => b.usd - a.usd);
  const topDevices = Object.entries(devices).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([d, usd]) => ({ device: d.slice(0, 6) + '…', usd }));
  const days = Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).map(([day, usd]) => ({ day, usd }));
  return { daysBack, total, activities, topDevices, days };
}

const money = (n) => n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0';
const num = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(r, key) {
  const tabs = [1, 7, 30, 90].map((n) => `<a class="${n === r.daysBack ? 'on' : ''}" href="/costs/${esc(key)}?days=${n}">${n === 1 ? 'Today' : n + ' days'}</a>`).join('');
  const rows = r.activities.map((a) => `<tr><td>${esc(a.name)}${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}<div class="note">${esc(a.models.join(', '))}</div></td>
    <td>${num(a.calls)}</td><td>${a.minutes ? num(a.minutes) + ' min' : `${num(a.inTok)} in<br>${num(a.outTok)} out`}</td>
    <td>${r.total ? Math.round(a.usd / r.total * 100) : 0}%</td><td class="b">${money(a.usd)}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Nothing yet in this range.</td></tr>';
  const days = r.days.map((d) => `<tr><td>${d.day}</td><td class="b">${money(d.usd)}</td></tr>`).join('');
  const devs = r.topDevices.map((d) => `<tr><td><code>${esc(d.device)}</code></td><td class="b">${money(d.usd)}</td></tr>`).join('') || '<tr><td colspan="2" class="note">None yet.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Get Transcript costs</title><meta name="robots" content="noindex">
<style>:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--line:#e7e5e4;--card:#fff;--acc:#0f766e}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f5f5f4;--mut:#a8a29e;--line:#2e2d2b;--card:#1c1b19;--acc:#5eead4}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 18px}.big{font-size:40px;font-weight:700;margin:6px 0 18px}
.tabs a{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:999px;margin:0 6px 6px 0;color:var(--fg);text-decoration:none}.tabs a.on{background:var(--acc);border-color:var(--acc);color:var(--bg)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0;overflow-x:auto}h2{font-size:16px;margin:0 0 8px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:500;border-top:0;font-size:13px}
.b{font-weight:600;white-space:nowrap}.note{color:var(--mut);font-size:12px}td:nth-child(n+2),th:nth-child(n+2){text-align:right}</style></head><body><main>
<h1>Get Transcript: OpenAI spend</h1><p class="sub">Measured from OpenAI's own token counts on every call, priced from OpenAI's price list.</p>
<div class="tabs">${tabs}</div><div class="big">${money(r.total)}</div>
<section><h2>By activity</h2><table><tr><th>Activity</th><th>Calls</th><th>Used</th><th>Share</th><th>Cost</th></tr>${rows}</table></section>
<section><h2>By day</h2><table>${days || '<tr><td class="note">Nothing yet.</td></tr>'}</table></section>
<section><h2>Who costs most (by Get Transcript code)</h2><table>${devs}</table></section>
</main></body></html>`;
}

const router = express.Router();
const allowed = (req) => KEY && req.params.key === KEY;
router.get('/costs/:key', (req, res, next) => {
  if (!allowed(req)) return next();
  const n = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  res.set('Cache-Control', 'no-store').type('html').send(page(report(n), req.params.key));
});
router.get('/api/costs/:key', (req, res, next) => {
  if (!allowed(req)) return next();
  res.set('Cache-Control', 'no-store').json(report(Math.min(400, Math.max(1, Number(req.query.days) || 7))));
});

module.exports = { track, router, dollars };
