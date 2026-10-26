// Make it here — the post, thread or comment written inside the app (OpenAI),
// and the Community feed where everyone sees what others made.
//
// Free for now, to build the habit: each code gets 1 post, 1 thread and
// 1 comment a day, plus 1 image a day as a separate step (images are never
// made automatically). When today's is used, the app points people back to
// the prompts (ChatGPT does it for free) — the message comes from here so it
// can change without an app update. Paid plans come later.
//
// The Community shows written content only: the post / thread / comment and
// the video's title and link. Never the transcript (a text post's transcript
// holds strangers' names), never screenshots. Anyone can report a creation
// or hide everything from its author (App Store rule 1.2 for apps where
// people see each other's content); OpenAI's moderation check keeps flagged
// text out of the feed.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const OPENAI_KEY = process.env.REPLY_OPENAI_KEY || '';
const MODEL = process.env.CREATE_MODEL || process.env.REPLY_MODEL || 'gpt-6.1-sol';
const IMAGE_MODEL = process.env.CREATE_IMAGE_MODEL || 'gpt-image-2';
const IMAGE_QUALITY = process.env.CREATE_IMAGE_QUALITY || 'low';
const ADMIN_KEY = process.env.REPLY_KEY || '';

// Per code, per day. Per internet address too, so reinstalling the app for a
// fresh code doesn't give a fresh allowance (a family on one Wi-Fi still fits).
const LIMITS = { post: 1, thread: 1, comment: 1, image: 1 };
const IP_FACTOR = 4;
const KINDS = ['post', 'thread', 'comment'];
const REPORTS_TO_HIDE = 2;
const MAX_SOURCE = 60000;
const MAX_CREATIONS = 20000;
const WAIT_MS = 40 * 1000;
const PAGE = 30;

const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'create.json');
const IMAGE_DIR = path.join(DATA_DIR, 'creations');

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const isCode = (s) => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s) && s !== '0'.repeat(32);
// Who made it, without saying who: the same person always gets the same tag,
// and the tag can't be turned back into their code.
const authorOf = (code) => crypto.createHash('sha256').update('gt-author:' + code).digest('hex').slice(0, 12);

// ------------------------------------------------------------------- state --
let creations = [];            // newest first
const byId = new Map();
let usage = {};                // `${day}|${who}|${kind}` -> count (today only)
let blocks = {};               // code -> [author tags]
let saveTimer = null;

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    creations = Array.isArray(raw.creations) ? raw.creations : [];
    usage = raw.usage || {};
    blocks = raw.blocks || {};
    for (const c of creations) {
      // Caught mid-way by a restart: nothing to resume.
      if (c.status === 'working') { c.status = 'error'; c.error = 'The server restarted while this was being written. Please try again.'; }
      if (c.imageStatus === 'working') { c.imageStatus = 'error'; c.imageError = 'The server restarted while the image was being made. Please try again.'; }
      byId.set(c.id, c);
    }
    console.log(`[create] loaded ${creations.length} creation(s)`);
  } catch (e) {
    console.error('[create] could not load, starting empty:', e.message);
  }
}

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const day = today();
    for (const k of Object.keys(usage)) if (!k.startsWith(day)) delete usage[k];
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, creations, usage, blocks }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[create] could not save:', e.message);
  }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
}
process.on('SIGTERM', saveNow);

// ------------------------------------------------------------------- quota --
const used = (who, kind) => usage[`${today()}|${who}|${kind}`] || 0;
const bump = (who, kind) => { const k = `${today()}|${who}|${kind}`; usage[k] = (usage[k] || 0) + 1; save(); };

function left(code, ip, kind) {
  return Math.max(0, Math.min(LIMITS[kind] - used(code, kind), LIMITS[kind] * IP_FACTOR - used('ip:' + ip, kind)));
}

function quota(code, ip) {
  const out = {};
  for (const k of [...KINDS, 'image']) out[k] = { left: left(code, ip, k), limit: LIMITS[k] };
  const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
  out.resetsInMinutes = Math.ceil((midnight - new Date()) / 60000);
  return out;
}

const NAMES = { post: 'post', thread: 'thread post', comment: 'comment', image: 'image' };

// The words the apps show when today's is used. Clear about what to do now
// (the prompts are always free), with a light hint that more is coming.
function quotaMessage(kind) {
  if (kind === 'image') {
    return {
      title: "Today's free image is used",
      message: "You can still make one in ChatGPT: copy your post, open ChatGPT and ask it for an image for it. A new free image is ready here tomorrow. More images in the app are coming later, as an extra.",
    };
  }
  return {
    title: `Today's free ${NAMES[kind]} is used`,
    message: `You can still make as many as you like with the prompts: tap one under "Ask", it's copied and ChatGPT opens, then Paste and Send. A new free ${NAMES[kind]} is ready here tomorrow. Making more inside the app is coming later, as a paid upgrade.`,
  };
}

// ----------------------------------------------------------------- prompts --
const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs-uom.json'), 'utf8'));
const packText = (match) => (PACK.find((p) => match.test(p.name)) || {}).text || '';

const PROMPTS = {
  post: packText(/villain/i),
  thread: packText(/thread/i),
  commentPost: packText(/comment on this post/i),
  commentVideo: packText(/comment on this video/i),
};

const FORMATS = {
  post: `Do every check and every rewrite silently, in your head. Reply with ONE JSON object and nothing else:
{"post": "the final story version, exactly as it should be pasted on Facebook"}`,
  thread: `Write only the FACEBOOK thread (skip the X version). Do the self-check silently. Reply with ONE JSON object and nothing else:
{"main": "the main post, exactly as it should be pasted", "comments": ["comment 1", "comment 2", "..."]}
Each comment is posted under the main post in order; the last one carries the call to action. No headings, labels, numbers or code blocks inside the texts.`,
  comment: `Do the analysis and the quality check silently. Reply with ONE JSON object and nothing else:
{"comment": "the ready-to-post comment, exactly as it should be pasted"}
Don't put the link in the comment; the app shows it separately. If you would normally advise skipping this post, still write the best genuinely helpful comment you can.`,
};

function pointAtInput(text) {
  let t = String(text || '').trimEnd();
  if (t.endsWith(':')) {
    const cut = Math.max(...['.', '!', '?', '।', '\n'].map((c) => t.lastIndexOf(c, t.length - 2)));
    if (t.length - cut <= 60) t = t.slice(0, cut + 1).trimEnd();
  }
  return t;
}

function buildPrompt(c, fresh) {
  const base = c.kind === 'comment' ? (c.source === 'post' ? PROMPTS.commentPost : PROMPTS.commentVideo) : PROMPTS[c.kind];
  const head = [c.title, c.url].filter(Boolean).join('\n');
  let p = pointAtInput(base) + '\n\nOUTPUT FOR THIS APP (overrides any output layout above, not the rules):\n' + FORMATS[c.kind];
  if (fresh) p += `\n\nThis is a fresh version. Here is an earlier one; write something clearly different (a new angle, a new hook), just as good:\n"""\n${fresh}\n"""`;
  return p + `\n\nMy input is below. Use it as-is; don't ask me for it.\n\n${head ? head + '\n\n' : ''}${c.sourceText}`;
}

async function askModel(prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(240 * 1000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `OpenAI answered ${r.status}`);
  try { return JSON.parse(data.choices?.[0]?.message?.content || ''); }
  catch { throw new Error('The AI sent back something unreadable. Please try again.'); }
}

// Flagged text stays with its maker and never reaches the Community.
async function flagged(text) {
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text.slice(0, 20000) }),
      signal: AbortSignal.timeout(30 * 1000),
    });
    const data = await r.json();
    return !!data.results?.[0]?.flagged;
  } catch {
    return false;   // the check being down shouldn't block anyone
  }
}

const allText = (c) => [c.text, ...(c.comments || [])].filter(Boolean).join('\n\n');

async function write(c, fresh) {
  try {
    const out = await askModel(buildPrompt(c, fresh));
    if (c.kind === 'thread') {
      c.text = String(out.main || '').trim();
      c.comments = (Array.isArray(out.comments) ? out.comments : []).map((s) => String(s || '').trim()).filter(Boolean);
    } else {
      c.text = String(out[c.kind] || '').trim();
    }
    if (!c.text) throw new Error('The AI sent back an empty answer. Please try again.');
    c.public = !(await flagged(allText(c)));
    c.status = 'done';
  } catch (e) {
    c.status = 'error';
    c.error = e.message;
  }
  c.updatedAt = now();
  save();
}

// The image prompt follows Mosh's: one simple scene that pokes the reader's
// pain and desire, tied to what the post says.
async function draw(c) {
  try {
    const prompt = `Create one scroll-stopping square image for this Facebook post. It must make the reader feel their own pain and their desire from the post, and hint at the way out. Keep it simple: one clear scene, one idea, directly about what the post says. Realistic photo style. No words in the image unless a few are essential.\n\nPOST:\n${c.text.slice(0, 3000)}`;
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024', quality: IMAGE_QUALITY, output_format: 'jpeg', output_compression: 85 }),
      signal: AbortSignal.timeout(240 * 1000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `The image maker answered ${r.status}`);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image came back. Please try again.');
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const name = `${c.id}-${now()}.jpg`;
    fs.writeFileSync(path.join(IMAGE_DIR, name), Buffer.from(b64, 'base64'));
    if (c.image) fs.rm(path.join(IMAGE_DIR, c.image), () => {});
    c.image = name;
    c.imageStatus = 'done';
    c.imageError = '';
  } catch (e) {
    c.imageStatus = 'error';
    c.imageError = e.message;
  }
  c.updatedAt = now();
  save();
}

// ------------------------------------------------------------------- shape --
function shape(c, code) {
  const mine = !!code && c.owner === code;
  return {
    id: c.id,
    kind: c.kind,
    title: c.title || '',
    url: c.url || '',
    status: c.status,
    error: c.error || '',
    text: c.text || '',
    comments: c.comments || [],
    // Images stay with their maker: the Community is written content only.
    image: c.image && mine ? `/api/create/${c.id}/image.jpg?deviceId=${code}&v=${encodeURIComponent(c.image)}` : '',
    imageStatus: c.imageStatus || '',
    imageError: c.imageError || '',
    mine,
    author: authorOf(c.owner),
    shared: !!c.public && !c.hidden,
    createdAt: c.createdAt,
  };
}

function visibleTo(c, code) {
  if (c.status !== 'done' || !c.public || c.hidden) return false;
  if (code && c.owner !== code) {
    if ((blocks[code] || []).includes(authorOf(c.owner))) return false;
    if ((c.reports || []).includes(code)) return false;
  }
  return true;
}

function codeOf(req) {
  const c = String(req.query.deviceId || req.body?.deviceId || '').trim().toLowerCase();
  return isCode(c) ? c : null;
}

function trim() {
  while (creations.length > MAX_CREATIONS) {
    const c = creations.pop();
    byId.delete(c.id);
    if (c.image) fs.rm(path.join(IMAGE_DIR, c.image), () => {});
  }
}

// ------------------------------------------------------------------ routes --
const router = express.Router();

router.get('/api/create/quota', (req, res) => {
  const code = codeOf(req);
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  res.json({ ok: true, ...quota(code, req.ip) });
});

// { deviceId, kind, title, url, transcript, source: 'post'|'video', fromId?, agreed }
// fromId = "a fresh version of that one": same source, different angle.
router.post('/api/create', (req, res) => {
  const code = codeOf(req);
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code.' });
  if (!OPENAI_KEY) return res.status(503).json({ ok: false, error: 'Writing in the app is not set up on the server yet.' });
  const b = req.body || {};
  const from = b.fromId ? byId.get(String(b.fromId)) : null;
  if (b.fromId && (!from || (from.owner !== code && !visibleTo(from, code)))) {
    return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  }
  const kind = from && !b.kind ? from.kind : String(b.kind || '');
  if (!KINDS.includes(kind)) return res.status(400).json({ ok: false, error: 'Pick a post, a thread or a comment.' });
  const sourceText = from ? from.sourceText : String(b.transcript || '').trim().slice(0, MAX_SOURCE);
  if (sourceText.length < 20) return res.status(400).json({ ok: false, error: 'There are no words to write from yet.' });

  if (left(code, req.ip, kind) < 1) {
    console.log(`[create] ${kind} for ${code.slice(0, 6)}: today's is used`);
    return res.status(429).json({ ok: false, quota: true, kind, ...quotaMessage(kind) });
  }
  bump(code, kind);
  bump('ip:' + req.ip, kind);

  const c = {
    id: crypto.randomBytes(8).toString('hex'),
    owner: code,
    kind,
    source: from ? from.source : (b.source === 'post' ? 'post' : 'video'),
    title: from ? from.title : String(b.title || '').slice(0, 300),
    url: from ? from.url : String(b.url || '').slice(0, 1000),
    sourceText,
    fromId: from ? from.id : undefined,
    status: 'working',
    createdAt: now(),
    updatedAt: now(),
  };
  creations.unshift(c);
  byId.set(c.id, c);
  trim();
  save();
  write(c, from ? allText(from) : '');
  console.log(`[create] ${kind} ${c.id} for ${code.slice(0, 6)}${from ? ' from ' + from.id : ''}`);
  res.json({ ok: true, id: c.id });
});

// Waits (up to 40 s) while it's being written or drawn, then answers.
router.get('/api/create/:id', async (req, res) => {
  const code = codeOf(req);
  const c = byId.get(req.params.id);
  if (!c || (c.owner !== code && !visibleTo(c, code))) return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  const until = now() + WAIT_MS;
  let closed = false;
  res.on('close', () => { closed = true; });
  while ((c.status === 'working' || c.imageStatus === 'working') && now() < until && !closed) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (closed) return;
  res.json({ ok: true, creation: shape(c, code) });
});

// The image is its own step, and only for your own post or thread.
router.post('/api/create/:id/image', (req, res) => {
  const code = codeOf(req);
  const c = byId.get(req.params.id);
  if (!c || c.owner !== code) return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  if (c.kind === 'comment') return res.status(400).json({ ok: false, error: 'Comments go without an image.' });
  if (c.status !== 'done') return res.status(400).json({ ok: false, error: 'Wait for the words first.' });
  if (c.imageStatus === 'working') return res.json({ ok: true, id: c.id });
  if (left(code, req.ip, 'image') < 1) return res.status(429).json({ ok: false, quota: true, kind: 'image', ...quotaMessage('image') });
  bump(code, 'image');
  bump('ip:' + req.ip, 'image');
  c.imageStatus = 'working';
  c.imageError = '';
  save();
  draw(c);
  res.json({ ok: true, id: c.id });
});

router.get('/api/create/:id/image.jpg', (req, res) => {
  const c = byId.get(req.params.id);
  if (!c || !c.image || c.owner !== codeOf(req)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(IMAGE_DIR, c.image), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

router.delete('/api/create/:id', (req, res) => {
  const code = codeOf(req);
  const c = byId.get(req.params.id);
  if (!c || c.owner !== code) return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  creations = creations.filter((x) => x !== c);
  byId.delete(c.id);
  if (c.image) fs.rm(path.join(IMAGE_DIR, c.image), () => {});
  save();
  res.json({ ok: true });
});

// The feed: ?kind=post|thread|comment, ?mine=1 for your own, ?before=<createdAt> for more.
router.get('/api/community', (req, res) => {
  const code = codeOf(req);
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const mine = req.query.mine === '1';
  const before = Number(req.query.before) || Infinity;
  const items = [];
  for (const c of creations) {
    if (items.length >= PAGE) break;
    if (c.createdAt >= before) continue;
    if (kind && c.kind !== kind) continue;
    if (mine ? c.owner !== code : !visibleTo(c, code)) continue;
    items.push(shape(c, code));
  }
  res.json({ ok: true, items, more: items.length === PAGE });
});

router.post('/api/community/:id/report', (req, res) => {
  const code = codeOf(req);
  const c = byId.get(req.params.id);
  if (!code || !c) return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  c.reports = c.reports || [];
  if (!c.reports.includes(code) && c.owner !== code) c.reports.push(code);
  c.reportReasons = [...(c.reportReasons || []), String(req.body?.reason || '').slice(0, 300)].slice(-10);
  if (c.reports.length >= REPORTS_TO_HIDE) c.hidden = true;
  console.log(`[create] report on ${c.id} (${c.reports.length})`);
  save();
  res.json({ ok: true });
});

// Hide everything from the author of this creation, for me only.
router.post('/api/community/:id/block', (req, res) => {
  const code = codeOf(req);
  const c = byId.get(req.params.id);
  if (!code || !c) return res.status(404).json({ ok: false, error: 'That one is no longer available.' });
  if (c.owner === code) return res.status(400).json({ ok: false, error: "That's yours." });
  const list = blocks[code] || (blocks[code] = []);
  const tag = authorOf(c.owner);
  if (!list.includes(tag)) list.push(tag);
  save();
  res.json({ ok: true });
});

// Mosh's side: what's been reported, and hide / show one. Same key as Comment Coach.
router.get('/api/community-admin/:key/reported', (req, res, next) => {
  if (!ADMIN_KEY || req.params.key !== ADMIN_KEY) return next('router');
  res.json({ ok: true, items: creations.filter((c) => (c.reports || []).length).map((c) => ({ ...shape(c, null), reports: c.reports.length, reasons: c.reportReasons || [], hidden: !!c.hidden })) });
});
router.post('/api/community-admin/:key/:id/:action(hide|show)', (req, res, next) => {
  if (!ADMIN_KEY || req.params.key !== ADMIN_KEY) return next('router');
  const c = byId.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  c.hidden = req.params.action === 'hide';
  if (!c.hidden) c.reports = [];
  save();
  res.json({ ok: true });
});

load();
module.exports = router;
