// Reply Coach — screenshots of someone else's post -> one helpful comment.
//
// PRIVATE for now: everything here answers only to REPLY_KEY (an env var, so it
// never lands in this public repo). Without the right key the page and the API
// both look exactly like a missing page. The master prompt lives on the /data
// volume for the same reason, and is edited from the page itself.
//
// The model is OpenAI (Mosh's choice). A conversation is kept in memory for a
// couple of hours so "Shorter" / "In Bangla" refine the same comment instead of
// starting over; nothing about it is written to disk.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const KEY = process.env.REPLY_KEY || '';
const OPENAI_KEY = process.env.REPLY_OPENAI_KEY || '';
const MODEL = process.env.REPLY_MODEL || 'gpt-6.1-sol';
const DAILY_LIMIT = Number(process.env.REPLY_DAILY_LIMIT || 150);   // a backstop, not a plan
const CHAT_TTL_MS = 2 * 3600 * 1000;
const MAX_IMAGES = 8;

const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'reply.json');

// What the page shows and the model must return. Replaces section 13's
// four headed sections with fields the phone can lay out.
const OUTPUT_RULES = `

OUTPUT FORMAT FOR THIS APP (overrides the output layout above, not the rules):
Reply with ONE JSON object and nothing else:
{
  "decision": "comment" or "skip",
  "comment": "the ready-to-post comment, plain text, exactly as it should be pasted (empty if skip)",
  "skip_reason": "one or two sentences on why to skip (empty if comment)",
  "psychology": "Post Psychology, 2-4 short sentences",
  "contribution": "Best Contribution Opportunity, 1-3 short sentences",
  "quality_check": "Final Quality Check, one short line per check"
}
Write the comment in the language the post's audience uses, unless I ask for another.
When I ask for a change, apply it and return the same JSON with the new comment. If I ask
for a comment on a post you recommended skipping, write the best one you can.`;

const REFINE = {
  shorter: 'Make the comment noticeably shorter. Keep the one useful insight.',
  angle: 'Write a different comment built on a different useful insight from the post.',
  bangla: 'Rewrite the comment in natural spoken Bangladeshi Bengali mixed with English where natural (বাংলা for Bengali words, English for English words). Not Kolkata style, not formal.',
  english: 'Rewrite the comment in natural everyday English.',
  warmer: 'Make the comment warmer and more casual, like a friendly community member typing on their phone.',
  anyway: 'I still want to comment on this post. Write the best genuinely helpful comment you can.',
};

let state = { prompt: '', usage: { day: '', count: 0 } };
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch (e) { console.error('[reply] could not load state:', e.message); }
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.error('[reply] could not save state:', e.message); }
}
loadState();

const chats = new Map();   // id -> { messages, at }
setInterval(() => {
  const cutoff = Date.now() - CHAT_TTL_MS;
  for (const [id, c] of chats) if (c.at < cutoff) chats.delete(id);
}, 10 * 60 * 1000).unref();

// Constant-time compare, so the key can't be guessed a character at a time.
function keyOk(k) {
  if (!KEY || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function useOne() {
  const day = new Date().toISOString().slice(0, 10);
  if (state.usage.day !== day) state.usage = { day, count: 0 };
  if (state.usage.count >= DAILY_LIMIT) return false;
  state.usage.count++;
  saveState();
  return true;
}

async function askModel(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(150 * 1000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `OpenAI answered ${r.status}`);
  const text = data.choices?.[0]?.message?.content || '';
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('The AI sent back something unreadable. Please try again.'); }
  return { text, out };
}

function shape(id, out) {
  const skip = out.decision === 'skip' && !String(out.comment || '').trim();
  return {
    ok: true, id,
    decision: skip ? 'skip' : 'comment',
    comment: String(out.comment || '').trim(),
    skip_reason: String(out.skip_reason || '').trim(),
    psychology: String(out.psychology || '').trim(),
    contribution: String(out.contribution || '').trim(),
    quality_check: String(out.quality_check || '').trim(),
  };
}

// JSON bodies are parsed by server.js (12mb cap); the page shrinks screenshots
// before sending, so 8 of them stay well under it.
const router = express.Router();

// Every route below needs the key; anything else falls through to the normal
// 404/app shell, so the feature is invisible.
router.use(['/r/:key', '/api/reply/:key'], (req, res, next) => {
  if (!keyOk(req.params.key)) return next('router');
  next();
});

router.get('/r/:key', (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, 'private', 'reply.html'));
});

router.get('/api/reply/:key/prompt', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, prompt: state.prompt, model: MODEL, used: state.usage.day === new Date().toISOString().slice(0, 10) ? state.usage.count : 0, limit: DAILY_LIMIT });
});

router.put('/api/reply/:key/prompt', (req, res) => {
  const p = String(req.body?.prompt || '').trim();
  if (p.length < 20) return res.status(400).json({ ok: false, error: 'That prompt looks empty.' });
  state.prompt = p;
  saveState();
  res.json({ ok: true });
});

router.post('/api/reply/:key/new', async (req, res) => {
  const images = (Array.isArray(req.body?.images) ? req.body.images : [])
    .filter((s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s))
    .slice(0, MAX_IMAGES);
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  if (!images.length && !note) return res.status(400).json({ ok: false, error: 'Add at least one screenshot.' });
  if (!state.prompt) return res.status(400).json({ ok: false, error: 'Your master prompt is not saved yet. Open "My prompt" and paste it.' });
  if (!OPENAI_KEY) return res.status(503).json({ ok: false, error: 'The OpenAI key is not set up on the server yet.' });
  if (!useOne()) return res.status(429).json({ ok: false, error: `Daily limit of ${DAILY_LIMIT} reached. It resets at midnight (UTC).` });

  const content = [{ type: 'text', text: images.length > 1
    ? `Here is the post as ${images.length} screenshots, in order.${note ? `\n\nMy note: ${note}` : ''}`
    : `Here is the post.${note ? `\n\nMy note: ${note}` : ''}` }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  const messages = [{ role: 'system', content: state.prompt + OUTPUT_RULES }, { role: 'user', content }];

  try {
    const { text, out } = await askModel(messages);
    const id = crypto.randomBytes(12).toString('hex');
    messages.push({ role: 'assistant', content: text });
    chats.set(id, { messages, at: Date.now() });
    res.json(shape(id, out));
  } catch (e) {
    console.error('[reply] new failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.post('/api/reply/:key/refine', async (req, res) => {
  const chat = chats.get(String(req.body?.id || ''));
  if (!chat) return res.status(404).json({ ok: false, error: 'This one has expired. Please send the screenshots again.' });
  const ask = REFINE[req.body?.action] || String(req.body?.text || '').trim().slice(0, 2000);
  if (!ask) return res.status(400).json({ ok: false, error: 'Say what to change.' });
  if (!useOne()) return res.status(429).json({ ok: false, error: `Daily limit of ${DAILY_LIMIT} reached.` });

  const messages = [...chat.messages, { role: 'user', content: ask }];
  try {
    const { text, out } = await askModel(messages);
    messages.push({ role: 'assistant', content: text });
    chat.messages = messages;
    chat.at = Date.now();
    res.json(shape(req.body.id, out));
  } catch (e) {
    console.error('[reply] refine failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
