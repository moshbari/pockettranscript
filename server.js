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
  return JSON.stringify({ version: 1, savedAt: now(), devices: out, aliases: Object.fromEntries(aliases), prompts: Object.fromEntries(userPrompts), packsGiven: Object.fromEntries(packsGiven) });
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
  const mine = (code ? userPrompts.get(code) || [] : [])
    .map((p) => ({ name: noDots(p.name), text: noDots(p.text) }));
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
  res.json({ ok: true, prompts: userPrompts.get(owner) || [], builtIn: PROMPTS.filter((p) => p !== TYPE_OWN) });
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

async function runLink(job) {
  try {
    finishJob(job, await callTranscriber('/transcribe', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.url }),
    }));
  } catch (e) {
    finishJob(job, { error: `Couldn't reach the transcriber: ${e.message}` });
  }
}

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

function grab(req, res) {
  // No code (left blank on install) is fine: everything but YouTube-through-
  // your-computer works without one.
  const given = String(req.query.deviceId || (req.body && req.body.deviceId) || '').trim().toLowerCase();
  const anon = !isValidDeviceId(given);
  const d = getDevice(anon ? ANON_ID : resolveId(given));
  // Only a code with a computer behind it skips the daily cap.
  const limited = anon || !d.lastSeen;

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
    return res.json({ ok: true, id: job.id });
  }

  const url = firstUrl(req.body && (req.body.url || req.body.text));
  if (!url) return res.status(400).json({ ok: false, error: "I didn't find a link or a file in what you shared." });

  const videoId = extractYtId(url);
  if (videoId) {
    // Server first (the transcriber reads captions through the proxy). The
    // computer's extension only gets it if the server can't.
    const job = newServerJob(d, { url: `https://www.youtube.com/watch?v=${videoId}`, videoId });
    runYouTube(job, d, { anon });
    return res.json({ ok: true, id: job.id });
  }

  const job = newServerJob(d, { url });
  runLink(job);
  res.json({ ok: true, id: job.id });
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
      words: transcript.split(/\s+/).length,
      transcript: head ? `${head}\n\n${transcript}` : transcript,
      // A few lines for the Shortcut's menu. The whole thing there pushed the
      // ChatGPT/Claude buttons off an iPhone screen.
      preview: previewOf(transcript),
      ...promptMenu(owner, Number(req.query.v) || 1),
    });
  }
  if (job.status === 'error') return res.json({ ok: true, state: 'error', error: job.error });
  res.json({ ok: true, state: 'working', pending: 'yes' });
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

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
app.listen(PORT, () => console.log(`PocketTranscript listening on ${PORT}`));
