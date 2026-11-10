/**
 * 🏠 HOME DOWNLOADER — YouTube blocks data-centre servers ("confirm you're not
 * a bot"). Instead of paying a residential proxy per GB, a small helper on a
 * computer on a home internet line (Mosh's Mac) does the YouTube part.
 * (Same file as video-processor-railway/services/homeWorker.js.)
 *
 *   server: download(url) puts a job on the list and waits
 *   helper: GET  /api/home-worker/next          (long poll) → { id, url }
 *           POST /api/home-worker/:id/progress  { progress }
 *           POST /api/home-worker/:id/file      multipart video (+ audio) + info JSON
 *           POST /api/home-worker/:id/fail      { error }
 *   server: merges video + audio (copy, no re-encode) and carries on as if it
 *           had downloaded the file itself.
 *
 * Every helper call carries HOME_WORKER_TOKEN. If no helper has checked in for
 * a while, online() is false and the caller falls back to its old way.
 */

const { v4: uuidv4 } = require('uuid');

const TOKEN = process.env.HOME_WORKER_TOKEN || '';
const PICKUP_MS = 30 * 1000;          // not picked up by then → caller falls back
const FINISH_MS = 15 * 60 * 1000;     // picked up but never finished
const ONLINE_MS = 45 * 1000;          // helper counts as online if seen this recently

const jobs = new Map();               // id → job
const waiting = [];                   // ids not picked yet, oldest first
const pollers = [];                   // helpers waiting for a job: resolve fns
let lastSeen = 0;

const enabled = () => !!TOKEN;
const online = () => enabled() && Date.now() - lastSeen < ONLINE_MS;
const authed = (req) => enabled() && (req.headers['x-home-token'] || '') === TOKEN;

function seen() { lastSeen = Date.now(); }

function handOut() {
  while (pollers.length && waiting.length) {
    const id = waiting.shift();
    const job = jobs.get(id);
    if (!job || job.state !== 'waiting') continue;
    job.state = 'working';
    clearTimeout(job.pickupTimer);
    job.finishTimer = setTimeout(() => finish(job, new Error('The home downloader took too long.')), FINISH_MS);
    pollers.shift()({ id: job.id, url: job.url, ...(job.extra || {}) });
  }
}

function finish(job, err, result) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.pickupTimer);
  clearTimeout(job.finishTimer);
  jobs.delete(job.id);
  if (err) job.reject(err); else job.resolve(result);
}

/**
 * Ask the home helper to fetch a video. Resolves { files: {video, audio?}, info, ...rest }.
 * extra (e.g. { kind: 'captions', langs }) is handed to the helper with the job.
 * Rejects with err.notPicked = true when no helper took it in time.
 */
function download(url, onProgress, extra) {
  return new Promise((resolve, reject) => {
    const job = { id: uuidv4(), url, extra, state: 'waiting', resolve, reject, onProgress, created: Date.now() };
    job.pickupTimer = setTimeout(() => {
      const i = waiting.indexOf(job.id);
      if (i >= 0) waiting.splice(i, 1);
      finish(job, Object.assign(new Error('No home downloader picked this up.'), { notPicked: true }));
    }, PICKUP_MS);
    jobs.set(job.id, job);
    waiting.push(job.id);
    handOut();
  });
}

/** Long poll: resolves a job, or null after ~25 s with nothing to do. */
function next() {
  seen();
  return new Promise((resolve) => {
    let done = false;
    const give = (j) => { if (!done) { done = true; clearTimeout(t); resolve(j); } };
    const t = setTimeout(() => {
      const i = pollers.indexOf(give);
      if (i >= 0) pollers.splice(i, 1);
      give(null);
    }, 25 * 1000);
    pollers.push(give);
    handOut();
  });
}

function progress(id, p) {
  seen();
  const job = jobs.get(id);
  if (job && job.onProgress) job.onProgress(Math.max(0, Math.min(100, Number(p) || 0)));
  return !!job;
}

function complete(id, files, info, rest = {}) {
  seen();
  const job = jobs.get(id);
  if (!job) return false;
  finish(job, null, { files, info, ...rest });
  return true;
}

function fail(id, message) {
  seen();
  const job = jobs.get(id);
  if (!job) return false;
  finish(job, Object.assign(new Error(String(message || 'The home downloader failed.')), { fromHome: true }));
  return true;
}

const status = () => ({ enabled: enabled(), online: online(), lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null, waiting: waiting.length, working: [...jobs.values()].filter((j) => j.state === 'working').length });

module.exports = { enabled, online, authed, download, next, progress, complete, fail, status };
