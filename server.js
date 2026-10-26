// PocketTranscript — the mailbox between a phone and a desktop Chrome extension.
//
// The phone can never call the extension directly (phones don't run extensions,
// and nothing outside your Mac can reach into its Chrome). So neither side ever
// talks to the other. They both talk to this:
//
//   phone  --POST /api/jobs-->  [ queue ]  <--long-poll--  desktop extension
//   phone  <--GET /api/jobs/:id--        <--POST /api/desktop/result--
//
// Deliberately has NO database. Everything lives in memory, because:
//   - a transcript is read once and thrown away, and
//   - a device rebuilds its own entry on its next poll, so a server restart
//     costs at most one in-flight job, never the pairing.
// The phone keeps its deviceId in localStorage; that id IS the password.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);   // Railway's edge: req.ip is the phone, not the proxy
app.use(express.json({ limit: '12mb' }));   // transcripts of long videos are chunky

// ---------------------------------------------------------------- state ----
// deviceId -> { name, lastSeen, jobs: Map<jobId, job>, waiters: [fn] }
const devices = new Map();
// 6-digit pairing code -> { deviceId, expires }
const pairCodes = new Map();

const ONLINE_MS   = 90 * 1000;          // desktop counts as awake if seen this recently
const LONG_POLL_MS = 25 * 1000;         // how long the extension's poll hangs open
const PAIR_TTL_MS = 10 * 60 * 1000;     // a pairing code is good for 10 minutes
const KEEP_MS     = 7 * 24 * 3600 * 1000;   // transcripts are kept for 7 days
const MAX_JOBS    = 300;                // per-device backstop so one batch can't eat the box
const DEVICE_TTL_MS = 30 * 24 * 3600 * 1000;

const now = () => Date.now();

// People who install the Share button without a computer code all share one
// bucket. Their job ids (16 random hex) are what keeps them apart.
const ANON_ID = '0'.repeat(32);
const ANON_KEEP_MS = 24 * 3600 * 1000;
const ANON_MAX_JOBS = 5000;
// Non-YouTube transcripts cost Whisper money, so no-code users get a daily cap.
const ANON_DAILY_LIMIT = Number(process.env.ANON_DAILY_LIMIT || 20);
const anonUse = new Map();   // ip -> { day, count }

// The /share page hands each visitor a code of their own for the Shortcut.
// If they later connect a computer, that code is pointed at the computer's
// id here, so YouTube starts working without reinstalling the Shortcut.
const aliases = new Map();   // share code -> desktop deviceId
const resolveId = (id) => aliases.get(id) || id;

// Each person's own saved instructions for the Share button, by code:
// code -> [{ name, text }]. The name is what shows in the Shortcut's list.
const userPrompts = new Map();
// Which starter packs a code has already been given (so a prompt someone
// deleted on purpose doesn't come back): code -> [pack names]
const packsGiven = new Map();
// Posts and videos saved for later from the Share menu, by code (kept until
// the person deletes them): code -> [saved item], newest first.
const savedItems = new Map();

// ---------------------------------------------------------------- disk ----
// Transcripts have to outlive a redeploy, or "kept for 7 days" is a lie: every
// push would silently empty the phone's list. Railway gives the service a
// volume at /data; everything is small text, so one JSON file is plenty.
const DATA_DIR  = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'store.json');
let saveTimer = null;
let saveFailed = false;

function serialise() {
  const out = {};
  for (const [id, d] of devices) {
    out[id] = { name: d.name, lastSeen: d.lastSeen, jobs: [...d.jobs.values()] };
  }
  return JSON.stringify({ version: 1, savedAt: now(), devices: out, aliases: Object.fromEntries(aliases), prompts: Object.fromEntries(userPrompts), packsGiven: Object.fromEntries(packsGiven), saved: Object.fromEntries(savedItems) });
}

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write beside the target and rename, so a crash mid-write can't leave a
    // half-written file that fails to parse on the next boot.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, serialise());
    fs.renameSync(tmp, DATA_FILE);
    saveFailed = false;
  } catch (e) {
    if (!saveFailed) console.error('[store] could not save:', e.message);
    saveFailed = true;   // log once, keep serving from memory
  }
}

// Called on every change; batches a burst of writes into one.
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const cutoff = now() - KEEP_MS;
    let jobs = 0;
    for (const [id, d] of Object.entries(raw.devices || {})) {
      const dev = { name: d.name || 'Desktop', lastSeen: d.lastSeen || 0, jobs: new Map(), waiters: [] };
      for (const j of d.jobs || []) {
        if (j.createdAt < cutoff) continue;               // past its 7 days
        // Anything caught mid-flight when the process died is nobody's job now.
        // Server-side jobs (links and files from the phone's Get Transcript
        // button) can't be resumed — their upload is gone — so say so plainly.
        if (j.status === 'working' || (j.worker === 'server' && j.status === 'queued')) {
          if (j.worker === 'server') {
            j.status = 'error';
            j.error = 'The server restarted while this was running. Please send it again.';
          } else {
            j.status = 'queued';
          }
        }
        dev.jobs.set(j.id, j);
        jobs++;
      }
      devices.set(id, dev);
    }
    for (const [from, to] of Object.entries(raw.aliases || {})) aliases.set(from, to);
    for (const [id, list] of Object.entries(raw.prompts || {})) if (Array.isArray(list)) userPrompts.set(id, list);
    for (const [id, list] of Object.entries(raw.packsGiven || {})) if (Array.isArray(list)) packsGiven.set(id, list);
    for (const [id, list] of Object.entries(raw.saved || {})) {
      if (!Array.isArray(list)) continue;
      // Anything still being read when the process died: keep what we have.
      for (const it of list) if (it.status === 'reading') it.status = 'ready';
      savedItems.set(id, list);
    }
    console.log(`[store] loaded ${devices.size} device(s), ${jobs} transcript(s), ${aliases.size} alias(es)`);
  } catch (e) {
    console.error('[store] could not load, starting empty:', e.message);
  }
}

// Devices are created on first sight from EITHER side. That is what makes the
// pairing survive a server restart: the phone still knows its deviceId, so the
// first thing it does after a restart quietly recreates the entry.
function getDevice(deviceId, { name } = {}) {
  let d = devices.get(deviceId);
  if (!d) {
    d = { name: name || 'Desktop', lastSeen: 0, jobs: new Map(), waiters: [] };
    devices.set(deviceId, d);
  }
  if (name) d.name = name;
  return d;
}

function isValidDeviceId(id) {
  // The shared no-code bucket is never a valid id from outside, so nobody can
  // list it through /api/status or /api/jobs.
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) && id !== ANON_ID;
}

function jobSummary(j) {
  return {
    id: j.id,
    url: j.url,
    videoId: j.videoId,
    status: j.status,
    title: j.title || '',
    error: j.error || '',
    words: j.plain ? j.plain.trim().split(/\s+/).length : 0,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

function recentJobs(d) {
  return [...d.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(jobSummary);
}

function trimJobs(d) {
  // The shared no-code bucket holds strangers' transcripts: a day, not a week.
  const anon = d === devices.get(ANON_ID);
  const cutoff = now() - (anon ? ANON_KEEP_MS : KEEP_MS);
  for (const j of [...d.jobs.values()]) if (j.createdAt < cutoff) d.jobs.delete(j.id);
  const all = [...d.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const j of all.slice(anon ? ANON_MAX_JOBS : MAX_JOBS)) d.jobs.delete(j.id);
}

// Hand a waiting long-poll its job the instant one is queued, so a phone
// request reaches the extension in well under a second rather than on the
// next alarm tick.
function wakeWaiters(d) {
  const waiters = d.waiters;
  d.waiters = [];
  for (const fn of waiters) { try { fn(); } catch { /* poll already closed */ } }
}

function nextQueuedJob(d) {
  // Only YouTube jobs are the extension's; the server runs everything else.
  return [...d.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
    .find((j) => j.status === 'queued' && j.worker !== 'server') || null;
}

// -------------------------------------------------------- YouTube ids ----
function extractYtId(url) {
  if (!url || typeof url !== 'string') return null;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // A bare 11-character id pasted on its own is a fair guess too.
  const bare = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(bare)) return bare;
  return null;
}

// ====================================================== DESKTOP SIDE ========
// The Chrome extension calls this on a loop. It is both the heartbeat ("I am
// awake") and the job pickup, in one request — one call, not two.
app.post('/api/desktop/poll', (req, res) => {
  const { deviceId, name } = req.body || {};
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });

  const d = getDevice(deviceId, { name });
  d.lastSeen = now();

  let finished = false;
  let timer = null;                 // declared up front: send() may run before it is set
  const drop = () => {
    clearTimeout(timer);
    d.waiters = d.waiters.filter((w) => w !== send);
  };
  const send = () => {
    if (finished) return;
    finished = true;
    drop();
    d.lastSeen = now();

    const job = nextQueuedJob(d);
    if (job) {
      job.status = 'working';
      job.updatedAt = now();
      save();
      return res.json({ ok: true, job: { id: job.id, url: job.url, videoId: job.videoId } });
    }
    res.json({ ok: true, job: null });
  };

  // If work is already waiting, answer immediately. Otherwise hold the request
  // open — a pending fetch also keeps the extension's service worker alive.
  if (nextQueuedJob(d)) return send();
  timer = setTimeout(send, LONG_POLL_MS);
  d.waiters.push(send);

  // Listen on the RESPONSE, not the request: req 'close' fires the moment the
  // POST body has been read, which would tear down every poll instantly.
  res.on('close', () => {
    if (finished) return;
    finished = true;
    drop();
  });
});

// The extension posts the finished transcript back here.
app.post('/api/desktop/result', (req, res) => {
  const { deviceId, jobId, ok, text, plain, segments, title, error } = req.body || {};
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });

  const d = getDevice(deviceId);
  d.lastSeen = now();
  const job = d.jobs.get(jobId);
  if (!job) return res.json({ ok: true, note: 'Job no longer exists — dropped.' });

  if (ok && text && text.trim().length > 0) {
    job.status = 'done';
    job.tookMs = now() - job.createdAt;
    // text = exactly what the desktop .txt download holds (title, video URL,
    // then "0:00 - line" rows). plain = the same words with nothing around them.
    job.text = text;
    job.plain = plain || text;
    job.segments = Array.isArray(segments) ? segments : [];
    job.title = title || '';
  } else {
    job.status = 'error';
    job.error = error || 'No transcript came back. This video may not have captions yet.';
  }
  job.updatedAt = now();
  save();
  res.json({ ok: true });
});

// The popup asks for a code to show the user; the phone redeems it once.
app.post('/api/desktop/paircode', (req, res) => {
  const { deviceId, name } = req.body || {};
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  getDevice(deviceId, { name }).lastSeen = now();

  // Drop any code this device already had, so only the newest one works.
  for (const [code, entry] of pairCodes) if (entry.deviceId === deviceId) pairCodes.delete(code);

  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (pairCodes.has(code));
  pairCodes.set(code, { deviceId, expires: now() + PAIR_TTL_MS });
  res.json({ ok: true, code, expiresInMs: PAIR_TTL_MS });
});

// ======================================================== PHONE SIDE ========
app.post('/api/pair', (req, res) => {
  const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
  const entry = pairCodes.get(code);
  if (!entry || entry.expires < now()) {
    pairCodes.delete(code);
    return res.status(404).json({ ok: false, error: 'That code is wrong or has expired. Open the extension and get a fresh one.' });
  }
  pairCodes.delete(code);   // one use only
  const d = getDevice(entry.deviceId);
  // A phone that already has a Share-button code: route it to this computer.
  const shareCode = String((req.body && req.body.shareCode) || '').toLowerCase();
  if (isValidDeviceId(shareCode) && shareCode !== entry.deviceId) {
    aliases.set(shareCode, entry.deviceId);
    // Prompts saved under the Share-button code follow it to the computer's id.
    const mine = userPrompts.get(shareCode);
    if (mine && mine.length) {
      const theirs = userPrompts.get(entry.deviceId) || [];
      const names = new Set(theirs.map((p) => p.name));
      userPrompts.set(entry.deviceId, [...theirs, ...mine.filter((p) => !names.has(p.name))].slice(0, MAX_PROMPTS));
      userPrompts.delete(shareCode);
    }
    save();
  }
  res.json({ ok: true, deviceId: entry.deviceId, name: d.name, online: now() - d.lastSeen < ONLINE_MS });
});

// The one the phone leans on: is the computer awake, and where are my jobs?
app.get('/api/status', (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  const d = getDevice(deviceId);
  const since = now() - d.lastSeen;
  res.json({
    ok: true,
    name: d.name,
    online: d.lastSeen > 0 && since < ONLINE_MS,
    everSeen: d.lastSeen > 0,
    lastSeenMsAgo: d.lastSeen ? since : null,
    jobs: recentJobs(d),
  });
});

app.post('/api/jobs', (req, res) => {
  const { deviceId, url } = req.body || {};
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  const videoId = extractYtId(url);
  if (!videoId) return res.status(400).json({ ok: false, error: "That doesn't look like a YouTube link." });

  const d = getDevice(deviceId);

  // Same video already queued or running? Hand back the existing job instead of
  // making the desktop scrape it twice.
  const live = [...d.jobs.values()].find(
    (j) => j.videoId === videoId && (j.status === 'queued' || j.status === 'working')
  );
  if (live) return res.json({ ok: true, job: jobSummary(live), duplicate: true });

  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    // The server (through the proxy) goes first; the computer is the backup.
    worker: 'server',
    status: 'working',
    title: '',
    text: '',
    plain: '',
    segments: [],
    error: '',
    createdAt: now(),
    updatedAt: now(),
  };
  d.jobs.set(job.id, job);
  trimJobs(d);
  save();
  runYouTube(job, d, { anon: false });

  res.json({
    ok: true,
    job: jobSummary(job),
    online: d.lastSeen > 0 && now() - d.lastSeen < ONLINE_MS,
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  const d = getDevice(deviceId);
  const job = d.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'That transcript is no longer on the server.' });
  res.json({
    ok: true,
    job: {
      ...jobSummary(job),
      // Older server jobs saved the bare words as `text`; give them the
      // title, link and timestamps too.
      text: job.text && job.text !== job.plain ? job.text : job.plain ? stampedText(job) : '',
      plain: job.plain || '',
      segments: job.segments || [],
    },
    online: d.lastSeen > 0 && now() - d.lastSeen < ONLINE_MS,
  });
});

// Re-queue a job that failed (captions often just aren't ready yet).
app.post('/api/jobs/:id/retry', (req, res) => {
  const { deviceId } = req.body || {};
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  const d = getDevice(deviceId);
  const job = d.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'That job is gone.' });
  if (job.videoId) {
    // YouTube: server first again, the computer as the backup.
    Object.assign(job, { worker: 'server', status: 'working', error: '', updatedAt: now() });
    save();
    runYouTube(job, d, { anon: false });
    return res.json({ ok: true, job: jobSummary(job) });
  }
  if (job.worker === 'server') {
    return res.status(400).json({ ok: false, error: 'Send this one again from the Get Transcript button on your phone.' });
  }
  job.status = 'queued';
  job.error = '';
  job.updatedAt = now();
  save();
  wakeWaiters(d);
  res.json({ ok: true, job: jobSummary(job) });
});

app.delete('/api/jobs/:id', (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ ok: false, error: 'Bad deviceId' });
  getDevice(deviceId).jobs.delete(req.params.id);
  save();
  res.json({ ok: true });
});

// ================================================ GET TRANSCRIPT BUTTON =====
// The iPhone Shortcut in the Share menu. It hands over a link or a file and
// gets back plain text, ready for ChatGPT or Claude. Two calls:
//
//   POST /api/grab?deviceId=…      JSON {url}  or  multipart field "file"
//   GET  /api/grab/:id?deviceId=…  holds up to 45s, answers the moment it's done
//
// Everything goes to the transcriber service first (YouTube captions through
// its residential proxy; other links and files through yt-dlp + Whisper).
// YouTube falls back to the Mac's extension only if the server can't get it.
const multer = require('multer');
const os = require('os');
const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL || 'https://transcriber-production-f2f1.up.railway.app';
const GRAB_WAIT_MS = 40 * 1000;   // under the ~60s an iPhone Shortcut waits for an answer
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });

// A Shortcut's simplest upload is the file itself as the whole request body
// (no form around it). Save that to disk so it looks like a multer upload.
function rawUpload(req, res, next) {
  const type = String(req.headers['content-type'] || '');
  if (/json|multipart|x-www-form-urlencoded/i.test(type) || !Number(req.headers['content-length'] || 1)) return next();
  const tmp = path.join(os.tmpdir(), 'grab-' + crypto.randomBytes(8).toString('hex'));
  const out = fs.createWriteStream(tmp);
  req.pipe(out);
  out.on('finish', () => {
    req.file = { path: tmp, originalname: 'Recording from phone', size: out.bytesWritten };
    next();
  });
  out.on('error', (e) => res.status(500).json({ ok: false, error: `Upload failed: ${e.message}` }));
}

// The instructions offered on the phone after the transcript arrives. They live
// here, not in the Shortcut, so they can change without reinstalling it.
// The Shortcut only tests "has any value" (its text comparisons read back empty
// on current iOS), so answers carry flags: `pending` while working, and
// `custom` maps the type-your-own choice to "yes".
const TYPE_OWN = '✏️ Type my own instruction';
// Opens the ChatGPT app on a NEW chat (opening the app itself lands on the
// last chat). Only addresses listed in chatgpt.com/.well-known/apple-app-site-association
// open the app; plain https://chatgpt.com/ opened Safari. "/#native" is listed
// as "ChatGPT home. This will start a new conversation in-app."
const CHATGPT_URL = process.env.CHATGPT_URL || 'https://chatgpt.com/#native';

const PROMPTS = [
  'Summarise this in simple words',
  'Give me the key points and the action steps',
  'Pull out every useful idea, tip and example',
  'Turn this into a social media post',
  'Write this up as a clean, readable article',
  'Translate this into Bangla',
  TYPE_OWN,
];
// Last in the list: opens the page where people save their own prompts.
const MANAGE = '⚙️ Add or edit my prompts';
const MAX_PROMPTS = 30;

// The Shortcut sends "<instruction>\n\nHere is the transcript:\n\n<transcript>".
// Many saved prompts end with their own empty label ("… Output only the post.
// INPUT:"), so the AI saw "INPUT:" followed by nothing and asked "please send me
// the input" (7 Oct 2026). Drop that dangling label and say plainly where the
// input is. Applied when sending, never to what is saved.
function pointAtTranscript(text) {
  let t = String(text || '').trimEnd();
  if (t.endsWith(':')) {
    const cut = Math.max(...['.', '!', '?', '\u0964', '\u2024', '\n'].map((c) => t.lastIndexOf(c, t.length - 2)));
    if (t.length - cut <= 60) t = t.slice(0, cut + 1).trimEnd();
  }
  return t + '\n\nMy input is the transcript below. Use it as-is; don\'t ask me for it.';
}

// Built-in prompts that carry their own words (unlike PROMPTS, whose name IS the
// instruction): Mosh's Bangla + English Facebook post prompts, at the top of
// everyone's list. Defined in packs-uom.json, read below with the packs.
// Someone who saved a prompt with the same name sees their own words instead,
// in the same top spot, and only once.
function topPrompts(mine) {
  const byName = new Map(mine.map((p) => [p.name, p]));
  const top = DEFAULTS.map((d) => byName.get(d.name) || d);
  const rest = mine.filter((p) => !DEFAULTS.some((d) => d.name === p.name));
  return [...top, ...rest];
}

// Your saved prompts first, then the built-in ones. `texts` turns a name into
// the instruction sent to the AI; `manage` flags the choice that opens the page.
// Shortcuts from before custom prompts (no `v`) only get the built-in list:
// they would send a custom prompt's NAME to the AI instead of its words.
function promptMenu(code, version) {
  if (version < 2) return { prompts: PROMPTS, custom: { [TYPE_OWN]: 'yes' } };
  // Shortcuts reads a dot in a dictionary key as a key path ("a.b" = key b
  // inside key a), and the Shortcut uses both the name AND the words as keys.
  // A prompt with a full stop failed "Could not evaluate the key path". So
  // every dot goes out as ONE DOT LEADER (U+2024): looks the same, not a path.
  const noDots = (t) => t.replace(/\./g, '\u2024');
  const mine = topPrompts(code ? userPrompts.get(code) || [] : [])
    .map((p) => ({ name: noDots(p.name), text: noDots(pointAtTranscript(p.text)) }));
  const texts = {};
  for (const p of mine) texts[p.name] = p.text;
  const out = {
    prompts: [...mine.map((p) => p.name), ...PROMPTS],
    custom: { [TYPE_OWN]: 'yes' },
    texts,
    manage: {},
  };
  if (code) {
    out.prompts.push(MANAGE);
    out.manage[MANAGE] = 'yes';
  }
  return out;
}

// Names can't clash with the built-in choices, or the Shortcut couldn't tell
// "your Summarise" from ours.
const RESERVED = new Set([...PROMPTS, MANAGE]);

function cleanPrompts(list) {
  if (!Array.isArray(list)) return { error: 'Nothing to save.' };
  const out = [];
  const seen = new Set();
  for (const p of list) {
    const name = String((p && p.name) || '').replace(/\s+/g, ' ').trim();
    const text = String((p && p.text) || '').trim();
    if (!name && !text) continue;                       // an empty row: skip it
    if (!name) return { error: 'Every prompt needs a name.' };
    if (!text) return { error: `"${name}" needs its instruction.` };
    if (name.length > 60) return { error: `"${name.slice(0, 30)}…" is too long a name (60 letters max).` };
    if (text.length > 4000) return { error: `"${name}" is too long (4,000 letters max).` };
    if (RESERVED.has(name)) return { error: `"${name}" is already a built-in choice. Pick another name.` };
    if (seen.has(name.toLowerCase())) return { error: `Two prompts are called "${name}". Give each its own name.` };
    seen.add(name.toLowerCase());
    out.push({ name, text });
  }
  if (out.length > MAX_PROMPTS) return { error: `That's more than ${MAX_PROMPTS} prompts. Remove a few first.` };
  return { prompts: out };
}

// The code in the URL is the only key: the same code the Shortcut was given.
function promptOwner(req) {
  const given = String(req.query.code || '').trim().toLowerCase();
  return isValidDeviceId(given) ? resolveId(given) : null;
}

// Starter packs: ready-made prompts an app (like UOM AI Coach) hands its
// members, so they can post on day one without writing a prompt. Edit the JSON
// file to change them; members who already got a pack keep their copy.
const PACKS = { uom: JSON.parse(fs.readFileSync(path.join(__dirname, 'packs-uom.json'), 'utf8')) };
const DEFAULTS = PACKS.uom;

// Members keep their copy of a pack, so a rewritten pack prompt would never
// reach them. packs-uom-old.json lists earlier wordings by name: a copy that
// still matches one of them word for word (never edited) gets the new words.
function refreshPackCopies() {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs-uom-old.json'), 'utf8'));
  let n = 0;
  for (const list of userPrompts.values()) {
    for (const p of list) {
      const now = DEFAULTS.find((d) => d.name === p.name);
      if (now && p.text !== now.text && (old[p.name] || []).includes(p.text)) { p.text = now.text; n++; }
    }
  }
  if (n) { console.log(`[packs] refreshed ${n} saved copy(ies)`); save(); }
}

// Adds a pack's prompts to the top of a code's list, once per code.
app.post('/api/prompts/pack', (req, res) => {
  const owner = promptOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  const name = String(req.query.pack || '');
  const pack = PACKS[name];
  if (!pack) return res.status(404).json({ ok: false, error: 'No such pack.' });
  const given = packsGiven.get(owner) || [];
  if (!given.includes(name)) {
    const mine = userPrompts.get(owner) || [];
    const have = new Set(mine.map((p) => p.name));
    userPrompts.set(owner, [...pack.filter((p) => !have.has(p.name)), ...mine].slice(0, MAX_PROMPTS));
    packsGiven.set(owner, [...given, name]);
    save();
  }
  res.json({ ok: true, prompts: userPrompts.get(owner) || [] });
});

// How many transcripts a code finished today (the member's own day: `tz` is
// minutes east of UTC) — AI Coach counts these as today's posts.
app.get('/api/usage', (req, res) => {
  const owner = promptOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0)) * 60000;
  const local = now() + tz;
  const midnight = local - (local % 86400000) - tz;
  const d = devices.get(owner);
  const jobs = d ? [...d.jobs.values()].filter((j) => j.status === 'done') : [];
  res.json({
    ok: true,
    today: jobs.filter((j) => j.createdAt >= midnight).length,
    ever: jobs.length,
  });
});

app.get('/api/prompts', (req, res) => {
  const owner = promptOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  const mine = userPrompts.get(owner) || [];
  const have = new Set(mine.map((p) => p.name));
  res.json({
    ok: true, prompts: mine, builtIn: PROMPTS.filter((p) => p !== TYPE_OWN),
    // Built-ins with their own words, shown above everything (minus any the
    // person saved under the same name: their copy is in `prompts`).
    defaults: DEFAULTS.filter((d) => !have.has(d.name)),
    // The whole top of the list, worded exactly as it goes to the AI (the native app sends these).
    send: topPrompts(mine).map((p) => ({ name: p.name, text: pointAtTranscript(p.text) })),
  });
});

app.put('/api/prompts', (req, res) => {
  const owner = promptOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  const r = cleanPrompts(req.body && req.body.prompts);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  if (r.prompts.length) userPrompts.set(owner, r.prompts); else userPrompts.delete(owner);
  save();
  res.json({ ok: true, prompts: r.prompts });
});

function newServerJob(d, fields) {
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    worker: 'server',
    url: '', videoId: '', status: 'working', title: '',
    text: '', plain: '', segments: [], error: '',
    createdAt: now(), updatedAt: now(),
    ...fields,
  };
  d.jobs.set(job.id, job);
  trimJobs(d);
  save();
  return job;
}

// How long a transcript usually takes, so the phone can show a real
// countdown instead of a spinner: the median of the last finished ones of the
// same sort (screenshots, link, recording). Cached for a minute.
const EXPECT_FALLBACK = { screenshots: 20, link: 30, file: 45 };
let expectCache = { at: 0, by: {} };
const sortOf = (job) => job.source === 'screenshots' ? 'screenshots' : job.url ? 'link' : 'file';
function grabExpect(job) {
  if (now() - expectCache.at > 60000) {
    const lists = {};
    for (const d of devices.values()) {
      for (const j of d.jobs.values()) {
        if (j.status === 'done' && j.tookMs > 0 && j.worker === 'server') (lists[sortOf(j)] ||= []).push([j.createdAt, j.tookMs]);
      }
    }
    const by = {};
    for (const [k, l] of Object.entries(lists)) {
      const last = l.sort((x, y) => y[0] - x[0]).slice(0, 30).map((x) => x[1]).sort((x, y) => x - y);
      by[k] = Math.round(last[Math.floor(last.length / 2)] / 1000);
    }
    expectCache = { at: now(), by };
  }
  const k = sortOf(job);
  return Math.max(8, Math.min(240, expectCache.by[k] || EXPECT_FALLBACK[k]));
}

// Same shape as the desktop .txt: title, link, then "0:00 - line" rows.
function stampedText(job) {
  const segs = job.segments || [];
  const rows = segs.length && segs[0].start !== undefined
    ? segs.map((sg) => `${stamp(sg.start)} - ${String(sg.text || '').trim()}`).join('\n')
    : job.plain;
  return [job.title, job.url].filter(Boolean).join('\n') + '\n\n' + rows;
}

function finishJob(job, result) {
  if (result.text && result.text.trim()) {
    job.status = 'done';
    job.tookMs = now() - job.createdAt;
    job.plain = result.text.trim();
    job.segments = Array.isArray(result.segments) ? result.segments : [];
    job.text = stampedText(job);
  } else {
    job.status = 'error';
    job.error = result.error || 'No words came back. The recording may be silent or music only.';
  }
  job.updatedAt = now();
  save();
}

async function callTranscriber(pathname, body) {
  const r = await fetch(TRANSCRIBER_URL + pathname, { method: 'POST', ...body });
  let data = {};
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !data.text) {
    return { error: data.error || `The transcriber answered ${r.status}.` };
  }
  return data;
}

// A text post (no video) can't be transcribed, and "trying anyway" picked up
// whatever video sat elsewhere on the page. So for these links we don't fetch
// anything: the job is the link plus a note, and the person attaches their
// screenshots in ChatGPT. The Shortcut needs no change: it still gets a
// "transcript", the menu, and copies prompt + link (24 Oct 2026).
const SCREENSHOTS_NOTE = "(This is a text post. I'm attaching screenshots of it to this message: read the post from them.)";

function isTextPostLink(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.replace(/^(www|m|mobile|web|business)\./, '');
  const path = u.pathname;
  if (host === 'facebook.com' || host === 'fb.com') {
    if (/\/(reel|reels|videos|watch|live)\b/.test(path) || /^\/share\/(v|r)\//.test(path)) return false;
    return /\/(posts|permalink\.php|story\.php|photo|photos|groups|share\/p)\b/.test(path) || u.searchParams.has('story_fbid');
  }
  if (host === 'linkedin.com') return /^\/(posts|feed\/update|pulse)\//.test(path);
  if (host === 'threads.net' || host === 'threads.com') return true;
  return false;
}

function finishAsScreenshotsPost(job) {
  job.title = job.title || `Post on ${siteName(job.url)}`;
  finishJob(job, { text: SCREENSHOTS_NOTE, segments: [] });
}

async function runLink(job) {
  if (isTextPostLink(job.url)) return finishAsScreenshotsPost(job);
  let result;
  try {
    result = await callTranscriber('/transcribe', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.url }),
    });
  } catch (e) {
    result = { error: `Couldn't reach the transcriber: ${e.message}` };
  }
  // No video to transcribe: it may be a text post. Read its words from the page.
  if (!(result.text && result.text.trim())) {
    const post = await readPostFromLink(job.url).catch(() => null);
    if (post) {
      job.title = post.title;
      result = { text: post.text, segments: [] };
    } else {
      // Nothing to read: treat it as a text post the person will screenshot.
      return finishAsScreenshotsPost(job);
    }
  }
  finishJob(job, result);
}

// ========================================================== text posts =====
// A text post can't be transcribed. Two ways in: its words straight from the
// link (public X / LinkedIn / many sites), or screenshots read by a cheap
// OpenAI model. Either way the post's link rides along, so after ChatGPT
// answers you can still get back to the post to comment.
const OCR_KEY = process.env.REPLY_OPENAI_KEY || '';
const OCR_MODEL = process.env.OCR_MODEL || 'gpt-6-luna';
const MAX_SHOTS = 8;

function siteName(url) {
  try { return new URL(url).hostname.replace(/^(www|m|mobile|web)\./, ''); } catch { return ''; }
}

const decodeEntities = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function readPostFromLink(url) {
  const site = siteName(url);
  // X: the public embed feed has the full text without a login.
  const tweet = url.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/);
  if (tweet) {
    const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweet[1]}&token=x`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const t = await r.json();
      if (t.text) return { title: `Post by ${t.user?.name || 'someone'} on X`, text: decodeEntities(t.text) };
    }
    return null;
  }
  // Everything else: the page's own preview text. Facebook mostly answers with
  // a login page, which has no useful description, so we say so instead.
  const r = await fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)', 'Accept-Language': 'en' },
  });
  if (!r.ok) return null;
  const html = (await r.text()).slice(0, 600000);
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const text = meta('og:description') || meta('description');
  const title = meta('og:title') || site;
  if (text.length < 40 || /log in|sign up|see posts, photos and more/i.test(text)) return null;
  return { title: title || `Post on ${site}`, text };
}

async function readScreenshots(images) {
  if (!OCR_KEY) throw new Error('Reading screenshots is not set up on the server yet.');
  const content = [{ type: 'text', text: `These ${images.length} screenshot(s), in order, show one social media post. Write out the post's text exactly as written, in reading order, joining the screenshots into one text without repeating lines that appear on two of them. Keep the original language and spelling; never translate or fix it. Start with the author's name on its own line if it is visible. Leave out the app's own buttons and counts (Like, Comment, Share, reactions, view counts, menus, the keyboard, the status bar). If the post contains a picture, add one line like [Picture: what it shows, and any words in it]. Output only the post.` }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCR_KEY}` },
    body: JSON.stringify({ model: OCR_MODEL, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `The picture reader answered ${r.status}`);
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function runScreenshots(job, images) {
  try {
    const text = await readScreenshots(images);
    finishJob(job, text ? { text, segments: [] } : { error: "I couldn't find any words in those screenshots." });
  } catch (e) {
    finishJob(job, { error: e.message });
  }
}

// The apps send { images: [jpeg data URLs, in order], url: the post's link (optional) }.
app.post('/api/grab-post', (req, res) => {
  const given = String(req.query.deviceId || '').trim().toLowerCase();
  const anon = !isValidDeviceId(given);
  const d = getDevice(anon ? ANON_ID : resolveId(given));
  const images = (Array.isArray(req.body?.images) ? req.body.images : [])
    .filter((s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s))
    .slice(0, MAX_SHOTS);
  const url = firstUrl(req.body?.url || '');
  if (!images.length) return res.status(400).json({ ok: false, error: 'Add at least one screenshot.' });

  // Same daily cap as other paid work for codes with no computer behind them.
  if (anon || !d.lastSeen) {
    const day = new Date().toISOString().slice(0, 10);
    const u = anonUse.get(req.ip);
    const use = u && u.day === day ? u : { day, count: 0 };
    if (use.count >= ANON_DAILY_LIMIT) return res.status(429).json({ ok: false, error: `That's today's ${ANON_DAILY_LIMIT} free reads. More tomorrow!` });
    use.count++;
    anonUse.set(req.ip, use);
  }

  const site = siteName(url);
  const shots = images.length > 1 ? `${images.length} screenshots` : 'screenshot';
  const job = newServerJob(d, { url, source: 'screenshots', title: site ? `Post on ${site} (${shots})` : `Post from ${shots}` });
  runScreenshots(job, images);
  res.json({ ok: true, id: job.id, expect: grabExpect(job) });
});

// "0:07" or "1:02:07", the same stamps the desktop .txt uses.
function stamp(sec) {
  const t = Math.floor(Number(sec) || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

async function youTubeTitle(url) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url),
      { signal: AbortSignal.timeout(8000) });
    if (r.ok) return (await r.json()).title || '';
  } catch { /* no title is fine */ }
  return '';
}

// YouTube: the transcriber first (captions through the residential proxy). If
// that fails and the computer is awake, hand the job to its extension instead.
async function runYouTube(job, d, { anon }) {
  let result;
  try {
    const [r, title] = await Promise.all([
      callTranscriber('/transcribe', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: job.url }),
      }),
      youTubeTitle(job.url),
    ]);
    result = r;
    job.title = title;
  } catch (e) {
    result = { error: `Couldn't reach the transcriber: ${e.message}` };
  }

  if (result.text && result.text.trim()) {
    const segs = Array.isArray(result.segments) ? result.segments : [];
    job.status = 'done';
    job.tookMs = now() - job.createdAt;
    job.plain = result.text.trim();
    job.segments = segs;
    job.text = stampedText(job);
    job.source = 'server';
    job.updatedAt = now();
    save();
    return;
  }

  const macAwake = !anon && d.lastSeen > 0 && now() - d.lastSeen < ONLINE_MS;
  if (macAwake) {
    job.worker = 'extension';
    job.status = 'queued';
    job.updatedAt = now();
    save();
    wakeWaiters(d);
    return;
  }
  job.status = 'error';
  job.error = !anon && d.lastSeen
    ? "The server couldn't get this one, and your computer is asleep. Wake the Mac (with Chrome open) and try again."
    : "The server couldn't get this one. It may have no captions. For YouTube backup, see pocket.99dfy.com/share";
  job.updatedAt = now();
  save();
}

async function runFile(job, file) {
  try {
    const form = new FormData();
    const blob = await fs.openAsBlob(file.path);
    form.append('file', blob, file.originalname || 'recording');
    finishJob(job, await callTranscriber('/transcribe-media', { body: form }));
  } catch (e) {
    finishJob(job, { error: `Couldn't reach the transcriber: ${e.message}` });
  } finally {
    fs.rm(file.path, { force: true }, () => {});
  }
}

// The Shortcut sends whatever it was given — sometimes a bare link, sometimes
// a caption with a link inside it. Pull the first link out.
function firstUrl(s) {
  const m = String(s || '').match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : '';
}

app.post('/api/grab', rawUpload, upload.single('file'), (req, res) => grab(req, res));

// "Try again" without transcribing again. If ChatGPT or Claude errors (say it's
// logged out), iOS stops the Shortcut dead and nothing inside it can catch that.
// But the clipboard still holds the prompt, which carries the transcript (and
// its link). So running Get Transcript again sends us that, and we hand back the
// transcript we already made: the ChatGPT / Claude menu is back in a second.
function allUrls(s) {
  return String(s || '').match(/https?:\/\/[^\s<>"']+/g) || [];
}
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function recentJob(d, { urls = [], body = '' }) {
  const done = [...d.jobs.values()].filter((j) => j.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const u of urls) {
    const vid = extractYtId(u);
    // A text post only reuses an answer that really is the post: one read from
    // screenshots, or the screenshots note. Older tries fetched other things.
    const usable = (j) => !isTextPostLink(u) || j.source === 'screenshots' || j.plain === SCREENSHOTS_NOTE;
    const hit = done.find((j) => (vid ? j.videoId === vid : j.url === u && usable(j)));
    if (hit) return hit;
  }
  const flat = squash(body);
  if (flat.length < 40) return null;
  return done.find((j) => {
    const head = squash(j.plain || j.text).slice(0, 300);
    return head.length >= 40 && flat.includes(head);
  }) || null;
}

// Text sent as a "file" (the Shortcut does this when the clipboard holds words,
// not a link). Recordings are never small enough to be mistaken for this.
function textFile(file) {
  if (!file || !file.size || file.size > 5 * 1024 * 1024) return '';
  try {
    const s = fs.readFileSync(file.path, 'utf8');
    return s.includes('\uFFFD') ? '' : s;
  } catch { return ''; }
}

function grab(req, res) {
  // No code (left blank on install) is fine: everything but YouTube-through-
  // your-computer works without one.
  const given = String(req.query.deviceId || (req.body && req.body.deviceId) || '').trim().toLowerCase();
  const anon = !isValidDeviceId(given);
  const d = getDevice(anon ? ANON_ID : resolveId(given));
  // Only a code with a computer behind it skips the daily cap.
  const limited = anon || !d.lastSeen;

  // Already made this one? Hand it straight back (see recentJob).
  const sent = req.body && (req.body.url || req.body.text);
  const typed = textFile(req.file);
  const again = recentJob(d, { urls: allUrls(sent || typed), body: typed });
  if (again) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.json({ ok: true, id: again.id, again: 'yes', expect: grabExpect(again) });
  }
  if (typed && !allUrls(typed).length) {
    // Words with no link and nothing we made before: not something to transcribe.
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ ok: false, error: "No link found. Copy the post's link first (Share → Copy link), then run this again. Or tap Share on the post and pick Get Transcript." });
  }
  if (typed) {
    // A link inside copied text: treat it like a shared link.
    fs.rm(req.file.path, { force: true }, () => {});
    req.file = null;
    req.body = { ...(req.body || {}), text: typed };
  }

  // Count a no-code user's paid transcripts (files and non-YouTube links).
  const bodyUrl = firstUrl(req.body && (req.body.url || req.body.text));
  const paid = (req.file && req.file.size > 0) || (bodyUrl && !extractYtId(bodyUrl));
  if (limited && paid) {
    const day = new Date().toISOString().slice(0, 10);
    const u = anonUse.get(req.ip);
    const use = u && u.day === day ? u : { day, count: 0 };
    if (use.count >= ANON_DAILY_LIMIT) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      return res.status(429).json({ ok: false, error: `That's today's ${ANON_DAILY_LIMIT} free transcripts. More tomorrow!` });
    }
    use.count++;
    anonUse.set(req.ip, use);
  }

  if (req.file && req.file.size > 0) {
    const job = newServerJob(d, { title: req.file.originalname || 'Recording from phone' });
    runFile(job, req.file);
    return res.json({ ok: true, id: job.id, expect: grabExpect(job) });
  }

  const url = firstUrl(req.body && (req.body.url || req.body.text));
  if (!url) return res.status(400).json({ ok: false, error: "No link found. Copy the post's link first (Share → Copy link), then run this again. Or tap Share on the post and pick Get Transcript." });

  const videoId = extractYtId(url);
  if (videoId) {
    // Server first (the transcriber reads captions through the proxy). The
    // computer's extension only gets it if the server can't.
    const job = newServerJob(d, { url: `https://www.youtube.com/watch?v=${videoId}`, videoId });
    runYouTube(job, d, { anon });
    return res.json({ ok: true, id: job.id, expect: grabExpect(job) });
  }

  const job = newServerJob(d, { url });
  runLink(job);
  res.json({ ok: true, id: job.id, expect: grabExpect(job) });
}

// ============================================================ ANDROID ======
// Android has no Shortcuts, but Chrome can install /android/ as an app, and an
// installed web app can sit in Android's Share menu (manifest share_target).
// Android POSTs what was shared (link, caption or file) here as a normal form.
// The code rides in a cookie the /android/ page set, since a share carries no URL
// of ours. Then we hand the phone back to /android/ to wait for the words.
function cookieCode(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)pt_code=([a-f0-9]{32})/);
  return m ? m[1] : '';
}

app.post('/android/share', upload.single('file'), (req, res) => {
  const code = cookieCode(req);
  req.query.deviceId = code;
  req.body = req.body || {};
  // Apps put the link in any of the three fields; join them so firstUrl finds it.
  req.body.text = [req.body.url, req.body.text, req.body.title].filter(Boolean).join(' ');
  const back = (q) => res.redirect(303, '/android/?' + q);
  grab(req, {
    status() { return this; },
    json(b) {
      if (b.ok) back('job=' + b.id + (isValidDeviceId(code) ? '' : '&anon=1'));
      else back('error=' + encodeURIComponent(b.error || 'Something went wrong.'));
    },
  });
});

function previewOf(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

app.get('/api/grab/:id', async (req, res) => {
  const given = String(req.query.deviceId || '').trim().toLowerCase();
  const owner = isValidDeviceId(given) ? resolveId(given) : null;
  const d = getDevice(owner || ANON_ID);
  const job = d.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, state: 'error', error: 'That transcript is no longer on the server.' });

  const until = now() + GRAB_WAIT_MS;
  let closed = false;
  res.on('close', () => { closed = true; });
  while ((job.status === 'queued' || job.status === 'working') && now() < until && !closed) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (closed) return;

  if (job.status === 'done') {
    // A link gets its title and address on top; a recording just gets its words.
    const head = job.url ? [job.title, job.url].filter(Boolean).join('\n') : '';
    const transcript = (job.plain || job.text || '').trim();
    return res.json({
      ok: true, state: 'done',
      title: job.title || '',
      url: job.url || '',
      words: transcript.split(/\s+/).length,
      transcript: head ? `${head}\n\n${transcript}` : transcript,
      // A few lines for the Shortcut's menu. The whole thing there pushed the
      // ChatGPT/Claude buttons off an iPhone screen.
      preview: previewOf(transcript),
      // Where "Ask ChatGPT" sends the person. Kept here, not in the Shortcut,
      // so it can change without everyone reinstalling.
      chatgptUrl: CHATGPT_URL,
      ...promptMenu(owner, Number(req.query.v) || 1),
    });
  }
  if (job.status === 'error') return res.json({ ok: true, state: 'error', error: job.error });
  res.json({ ok: true, state: 'working', pending: 'yes', expect: grabExpect(job), elapsed: Math.round((now() - job.createdAt) / 1000) });
});

// ========================================================= saved for later ==
// One tap in the Share menu ("Save for later") keeps a post or video to use
// later: comment on it, or make content from it. Saving answers at once; the
// title and words are filled in afterwards, so the Share sheet closes in a
// blink. Nothing is transcribed until the person picks it up (that costs money).
const SAVED_DIR = path.join(DATA_DIR, 'saved');
const MAX_SAVED = 2000;

function savedSummary(it) {
  return {
    id: it.id, url: it.url || '', title: it.title || '', site: it.site || '',
    kind: it.kind, preview: previewOf(it.text || it.note || '', 160),
    shots: it.shots || 0, status: it.status, done: !!it.done,
    createdAt: it.createdAt,
  };
}

function savedOwner(req) {
  const given = String(req.query.code || req.query.deviceId || '').trim().toLowerCase();
  return isValidDeviceId(given) ? resolveId(given) : null;
}

function findSaved(owner, id) {
  return (savedItems.get(owner) || []).find((it) => it.id === id) || null;
}

function dropSavedFiles(it) {
  for (let n = 0; n < (it.shots || 0); n++) fs.rm(path.join(SAVED_DIR, `${it.id}-${n}.jpg`), { force: true }, () => {});
}

// Title and words for a saved link, from the cheap places only.
async function fillSaved(it) {
  try {
    if (extractYtId(it.url)) {
      it.title = (await youTubeTitle(it.url)) || it.title;
    } else if (!isTextPostLink(it.url)) {
      const post = await readPostFromLink(it.url).catch(() => null);
      if (post) { it.title = post.title; it.text = post.text; }
    }
  } catch { /* the link alone is still worth keeping */ }
  if (!it.title) it.title = it.kind === 'video' ? `Video on ${it.site}` : `Post on ${it.site || 'the web'}`;
  it.status = 'ready';
  save();
}

async function readSavedShots(it, images) {
  try {
    it.text = await readScreenshots(images);
    const author = (it.text.split('\n')[0] || '').trim();
    if (!it.title && author && author.length < 60) it.title = `Post by ${author}`;
  } catch (e) {
    it.note = `Couldn't read the words yet (${e.message}). The screenshots are kept.`;
  }
  if (!it.title) it.title = it.site ? `Post on ${it.site}` : 'Saved screenshot';
  it.status = 'ready';
  save();
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|loom\.com)$/;
function linkKind(url) {
  if (extractYtId(url) || VIDEO_HOSTS.test(siteName(url))) return 'video';
  if (/\/(reel|reels|videos|watch|live)\b|\/share\/(v|r)\//.test(url)) return 'video';
  return 'post';
}

// { text | url: what was shared (a link, or a caption with a link in it),
//   images: [jpeg data URLs] (screenshots, optional) }
app.post('/api/saved', (req, res) => {
  const owner = savedOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  const shared = String((req.body && (req.body.url || req.body.text)) || '').slice(0, 5000);
  const url = firstUrl(shared);
  const images = (Array.isArray(req.body?.images) ? req.body.images : [])
    .filter((s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s))
    .slice(0, MAX_SHOTS);
  if (!url && !images.length) return res.status(400).json({ ok: false, error: "I didn't find a link or a picture in what you shared." });

  const list = savedItems.get(owner) || [];
  // Saving the same link twice just brings it back to the top.
  const again = url && !images.length && list.find((it) => it.url === url);
  if (again) {
    again.createdAt = now();
    again.done = false;
    list.sort((a, b) => b.createdAt - a.createdAt);
    save();
    return res.json({ ok: true, item: savedSummary(again), again: true });
  }

  const it = {
    id: crypto.randomBytes(8).toString('hex'),
    url, site: siteName(url), kind: images.length ? 'screenshot' : linkKind(url),
    title: '', text: '', note: '',
    // The words that came with the link (an app's caption), minus the link.
    caption: url ? squash(shared.replace(url, '')).slice(0, 1000) : '',
    shots: 0, status: 'reading', done: false, createdAt: now(),
  };
  if (images.length) {
    try {
      fs.mkdirSync(SAVED_DIR, { recursive: true });
      images.forEach((d, n) => fs.writeFileSync(path.join(SAVED_DIR, `${it.id}-${n}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
      it.shots = images.length;
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Couldn't keep the pictures: ${e.message}` });
    }
  }
  list.unshift(it);
  for (const old of list.splice(MAX_SAVED)) dropSavedFiles(old);
  savedItems.set(owner, list);
  save();
  res.json({ ok: true, item: savedSummary(it) });
  if (images.length) readSavedShots(it, images); else fillSaved(it);
});

app.get('/api/saved', (req, res) => {
  const owner = savedOwner(req);
  if (!owner) return res.status(400).json({ ok: false, error: "That code doesn't look right." });
  res.json({ ok: true, items: (savedItems.get(owner) || []).map(savedSummary) });
});

app.get('/api/saved/:id', (req, res) => {
  const owner = savedOwner(req);
  const it = owner && findSaved(owner, req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'That saved post is gone.' });
  res.json({ ok: true, item: { ...savedSummary(it), text: it.text || '', note: it.note || '', caption: it.caption || '' } });
});

app.get('/api/saved/:id/shot/:n', (req, res) => {
  const owner = savedOwner(req);
  const it = owner && findSaved(owner, req.params.id);
  const n = Number(req.params.n);
  if (!it || !(n >= 0 && n < (it.shots || 0))) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(SAVED_DIR, `${it.id}-${n}.jpg`));
});

// { done: true | false }
app.patch('/api/saved/:id', (req, res) => {
  const owner = savedOwner(req);
  const it = owner && findSaved(owner, req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'That saved post is gone.' });
  if (typeof req.body?.done === 'boolean') it.done = req.body.done;
  save();
  res.json({ ok: true, item: savedSummary(it) });
});

app.delete('/api/saved/:id', (req, res) => {
  const owner = savedOwner(req);
  const list = owner && savedItems.get(owner);
  const i = list ? list.findIndex((it) => it.id === req.params.id) : -1;
  if (i < 0) return res.status(404).json({ ok: false, error: 'That saved post is gone.' });
  dropSavedFiles(list[i]);
  list.splice(i, 1);
  save();
  res.json({ ok: true });
});

// "Use it": turn a saved item into a normal job, so the phone shows the usual
// words + prompts screen (GET /api/grab/:id). Words we already have are used
// as-is; a video link gets transcribed now.
app.post('/api/saved/:id/use', (req, res) => {
  const owner = savedOwner(req);
  const it = owner && findSaved(owner, req.params.id);
  if (!it) return res.status(404).json({ ok: false, error: 'That saved post is gone.' });
  const d = getDevice(owner);
  if (it.text) {
    const job = newServerJob(d, { url: it.url, title: it.title, source: it.shots ? 'screenshots' : 'saved' });
    finishJob(job, { text: it.text, segments: [] });
    return res.json({ ok: true, id: job.id, expect: grabExpect(job) });
  }
  if (it.shots) {
    // Screenshots whose words couldn't be read when saved: read them now.
    const images = [];
    for (let n = 0; n < it.shots; n++) {
      try { images.push('data:image/jpeg;base64,' + fs.readFileSync(path.join(SAVED_DIR, `${it.id}-${n}.jpg`)).toString('base64')); } catch { /* gone */ }
    }
    if (images.length) {
      const job = newServerJob(d, { url: it.url, title: it.title, source: 'screenshots' });
      runScreenshots(job, images).then(() => {
        if (job.status === 'done' && !it.text) { it.text = job.plain; it.note = ''; save(); }
      });
      return res.json({ ok: true, id: job.id, expect: grabExpect(job) });
    }
  }
  if (!it.url) return res.status(400).json({ ok: false, error: "There's nothing to read in this one yet." });
  req.query.deviceId = owner;
  req.body = { text: it.url };
  req.file = null;
  grab(req, res);
});

// ======================================================== app versions ======
// The newest app in each store, so the apps and the website can say "you have
// 1.0.1, the newest is 1.0.1". The App Store answers for iPhone; for Android the
// release title on the download repo carries it (scripts/publish-apk.sh sets it).
const APP_STORE_URL = 'https://apps.apple.com/app/get-transcript/id6820350358';
const APK_URL = 'https://github.com/moshbari/gettranscript-downloads/releases/latest/download/GetTranscript.apk';
let appVersions = { at: 0, ios: '', android: '' };

async function readAppVersions() {
  const [ios, android] = await Promise.all([
    fetch('https://itunes.apple.com/lookup?id=6820350358&country=us', { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json()).then((j) => (j.results && j.results[0] && j.results[0].version) || '').catch(() => ''),
    fetch('https://api.github.com/repos/moshbari/gettranscript-downloads/releases/tags/latest',
      { headers: { 'User-Agent': 'pocket.99dfy.com' }, signal: AbortSignal.timeout(8000) })
      .then((r) => r.json()).then((j) => ((j.name || '').match(/\d+(?:\.\d+)+/) || [''])[0]).catch(() => ''),
  ]);
  // Keep the last good answer when a store doesn't reply.
  appVersions = { at: Date.now(), ios: ios || appVersions.ios, android: android || appVersions.android };
}

app.get('/api/app-versions', async (_req, res) => {
  if (Date.now() - appVersions.at > 30 * 60 * 1000) await readAppVersions();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ok: true,
    ios: { version: appVersions.ios, url: APP_STORE_URL },
    android: { version: appVersions.android, url: APK_URL },
  });
});

// ============================================================= static =======
app.get('/health', (_req, res) => res.json({
  ok: true,
  devices: devices.size,
  transcripts: [...devices.values()].reduce((n, d) => n + d.jobs.size, 0),
  persisted: !saveFailed && fs.existsSync(DATA_FILE),
  keepDays: KEEP_MS / 86400000,
  up: process.uptime(),
}));

// The iPhone names the shortcut after the file, so hand it over as "Get Transcript".
app.get('/get-transcript.shortcut', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.download(path.join(__dirname, 'public', 'get-transcript.shortcut'), 'Get Transcript.shortcut');
});

// Private for now: answers only to REPLY_KEY, falls through otherwise.
app.use(require('./reply'));
app.use(require('./create'));

// The front page is the sales page; the web app lives at /app. Anything
// shared into an old install of the web app (its share target was "/") or a
// /?code=… link still lands in the app.
app.get('/', (req, res, next) => {
  const q = req.originalUrl.slice(1);
  if (/[?&](text|url|title|job|code|pack)=/.test(q)) return res.redirect(302, '/app' + q);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Housekeeping: expired codes, and devices nobody has touched in a fortnight.
setInterval(() => {
  const t = now();
  for (const [code, e] of pairCodes) if (e.expires < t) pairCodes.delete(code);
  let changed = false;
  for (const [id, d] of devices) {
    const before = d.jobs.size;
    trimJobs(d);                                  // drop anything past 7 days
    if (d.jobs.size !== before) changed = true;
    if (d.lastSeen && t - d.lastSeen > DEVICE_TTL_MS && !d.waiters.length && !d.jobs.size) {
      devices.delete(id);
      changed = true;
    }
  }
  if (changed) save();
}, 60 * 1000).unref();

// Last write wins on the way out, so a redeploy doesn't lose the last second.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { clearTimeout(saveTimer); saveNow(); process.exit(0); });
}

load();
refreshPackCopies();
app.listen(PORT, () => console.log(`PocketTranscript listening on ${PORT}`));
