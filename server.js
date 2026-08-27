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
  return JSON.stringify({ version: 1, savedAt: now(), devices: out });
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
        if (j.status === 'working') j.status = 'queued';
        dev.jobs.set(j.id, j);
        jobs++;
      }
      devices.set(id, dev);
    }
    console.log(`[store] loaded ${devices.size} device(s), ${jobs} transcript(s)`);
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
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
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
  const cutoff = now() - KEEP_MS;
  for (const j of [...d.jobs.values()]) if (j.createdAt < cutoff) d.jobs.delete(j.id);
  const all = [...d.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const j of all.slice(MAX_JOBS)) d.jobs.delete(j.id);
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
  return [...d.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
    .find((j) => j.status === 'queued') || null;
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
    status: 'queued',
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
  wakeWaiters(d);   // a desktop poll is probably hanging right now — feed it

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
      text: job.text || '',
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

// ============================================================= static =======
app.get('/health', (_req, res) => res.json({
  ok: true,
  devices: devices.size,
  transcripts: [...devices.values()].reduce((n, d) => n + d.jobs.size, 0),
  persisted: !saveFailed && fs.existsSync(DATA_FILE),
  keepDays: KEEP_MS / 86400000,
  up: process.uptime(),
}));

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
