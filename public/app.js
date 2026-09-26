// PocketTranscript — phone side.
//
// This file never speaks to the Chrome extension. It only ever talks to the
// server. The extension is doing the same thing from the other side, and the
// two never meet. That is the whole trick.

const LS_DEVICE = 'pt.deviceId';
const LS_NAME   = 'pt.deviceName';

const $ = (id) => document.getElementById(id);
let deviceId  = localStorage.getItem(LS_DEVICE) || '';
let pollTimer = null;
let currentJob = null;
let stampedView = true;   // default = the full transcript, same as the desktop .txt

// ------------------------------------------------------------- helpers ----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Something went wrong (${res.status}).`);
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(el) { el.classList.add('hidden'); }

function show(screen) {
  for (const id of ['pairScreen', 'mainScreen', 'viewScreen']) {
    $(id).classList.toggle('hidden', id !== screen);
  }
  window.scrollTo(0, 0);
}

function ago(ms) {
  if (ms == null) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ------------------------------------------------------------- pairing ----
async function doPair() {
  const code = $('codeInput').value.replace(/\D/g, '');
  clearError($('pairError'));
  if (code.length !== 6) return showError($('pairError'), 'Type all 6 digits.');

  $('pairBtn').disabled = true;
  $('pairBtn').textContent = 'Connecting…';
  try {
    // If this phone already installed the Share button from /share, send its
    // code along so the server points it at this computer (YouTube then works
    // without reinstalling the Shortcut).
    let shareCode = '';
    try { shareCode = localStorage.getItem('pt.shareCode') || ''; } catch { /* private mode */ }
    const r = await api('/api/pair', { method: 'POST', body: JSON.stringify({ code, shareCode }) });
    deviceId = r.deviceId;
    localStorage.setItem(LS_DEVICE, deviceId);
    localStorage.setItem(LS_NAME, r.name || 'Desktop');
    toast('Connected 🎉');
    startMain();
  } catch (e) {
    showError($('pairError'), e.message);
  } finally {
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = 'Connect';
  }
}

function unpair() {
  localStorage.removeItem(LS_DEVICE);
  localStorage.removeItem(LS_NAME);
  deviceId = '';
  clearTimeout(pollTimer);
  show('pairScreen');
}

// -------------------------------------------------------------- status ----
// The bit Mosh asked for: if the Mac is asleep, say so plainly, right at the top.
function paintStatus(s) {
  const pill = $('statusPill');
  pill.className = 'pill ' + (s.online ? 'pill-online' : 'pill-offline');
  $('statusText').textContent = s.online ? 'Computer awake' : 'Computer asleep';
  $('asleepBanner').classList.toggle('hidden', !!s.online);
  // "last seen never" reads like a fault. Before the desktop has ever checked
  // in (a fresh pairing, or a server restart) say what is actually happening.
  $('deviceLabel').textContent = s.online
    ? `Connected to ${s.name}`
    : s.everSeen
      ? `${s.name} — last seen ${ago(s.lastSeenMsAgo)}`
      : 'Waiting to hear from your computer';
}

function paintJobs(jobs) {
  const list = $('jobsList');
  $('jobsSection').classList.toggle('hidden', !jobs.length);
  if (!jobs.length) { list.innerHTML = ''; return; }

  list.innerHTML = '';
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'job';

    const icon = { queued: '⏳', working: '⚙️', done: '✅', error: '⚠️' }[j.status] || '•';
    const label = j.title || j.url.replace(/^https?:\/\/(www\.)?/, '');
    // With a 7-day window, age is the useful thing to show — it says what's
    // about to disappear without needing a countdown on every row.
    const age = Date.now() - j.createdAt;
    const day = 86400000;
    const when = age < day ? 'today'
      : age < 2 * day ? 'yesterday'
      : `${Math.floor(age / day)} days ago`;

    const sub = {
      queued:  'Waiting for your computer…',
      working: 'Your computer is grabbing it…',
      done:    `${j.words.toLocaleString()} words · ${when}`,
      error:   j.error,
    }[j.status] || '';

    row.innerHTML = `
      <div class="job-icon">${j.status === 'working' ? '<span class="spinning">⚙️</span>' : icon}</div>
      <div class="job-main">
        <div class="job-title"></div>
        <div class="job-sub ${j.status === 'error' ? 'err' : ''}"></div>
      </div>`;
    row.querySelector('.job-title').textContent = label;
    row.querySelector('.job-sub').textContent = sub;

    if (j.status === 'done') {
      const chev = document.createElement('div');
      chev.className = 'job-chev';
      chev.textContent = '›';
      row.appendChild(chev);
      row.addEventListener('click', () => openJob(j.id));
    } else if (j.status === 'error') {
      const retry = document.createElement('button');
      retry.className = 'job-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        retry.disabled = true;
        try {
          await api(`/api/jobs/${j.id}/retry`, {
            method: 'POST', body: JSON.stringify({ deviceId }),
          });
          loop();
        } catch (e) { toast(e.message); retry.disabled = false; }
      });
      row.appendChild(retry);
    }
    list.appendChild(row);
  }
}

async function refresh() {
  if (!deviceId) return false;
  try {
    const s = await api(`/api/status?deviceId=${deviceId}`);
    paintStatus(s);
    paintJobs(s.jobs);
    return s.jobs.some((j) => j.status === 'queued' || j.status === 'working');
  } catch {
    // A dropped signal is not the same as a sleeping Mac — don't lie about it.
    $('statusPill').className = 'pill pill-unknown';
    $('statusText').textContent = 'No connection';
    return false;
  }
}

// Check often while the desktop still owes us something, then back off. A phone
// on a fixed 4-second timer is both too slow to feel live and too greedy on battery.
function loop() {
  clearTimeout(pollTimer);
  refresh().then((busy) => {
    pollTimer = setTimeout(loop, busy ? 2000 : 10000);
  });
}

// ---------------------------------------------------------- submitting ----
async function submitUrl() {
  const url = $('urlInput').value.trim();
  clearError($('mainError'));
  if (!url) return showError($('mainError'), 'Paste a YouTube link first.');

  $('goBtn').disabled = true;
  $('goBtn').textContent = 'Sending…';
  try {
    const r = await api('/api/jobs', {
      method: 'POST', body: JSON.stringify({ deviceId, url }),
    });
    $('urlInput').value = '';
    toast(r.duplicate ? 'Already working on that one' : 'Getting the words…');
    loop();
  } catch (e) {
    showError($('mainError'), e.message);
  } finally {
    $('goBtn').disabled = false;
    $('goBtn').textContent = '2. Get every word';
  }
}

// ------------------------------------------------------- transcript view --
// The full view is byte-for-byte what the extension writes into its .txt on the
// computer: title, video URL, blank line, then "0:00 - line" rows. It is built
// by content.js, not reassembled here, so the two can't drift apart.
function fullTranscript() {
  if (!currentJob) return '';
  if (currentJob.text) return currentJob.text;
  // Only if an old job predates the server carrying `text`.
  const head = [currentJob.title, currentJob.url].filter(Boolean).join('\n');
  const body = (currentJob.segments || []).map((s) => `${s.timestamp} - ${s.text}`).join('\n');
  return head ? `${head}\n\n${body}` : body;
}

function renderBody() {
  if (!currentJob) return;
  $('viewBody').textContent = stampedView ? fullTranscript() : (currentJob.plain || '');
  $('tabPlain').classList.toggle('active', !stampedView);
  $('tabStamped').classList.toggle('active', stampedView);
}

async function openJob(id) {
  try {
    const r = await api(`/api/jobs/${id}?deviceId=${deviceId}`);
    currentJob = r.job;
    stampedView = true;
    $('viewTitle').textContent = currentJob.title || 'Transcript';
    // Nothing to strip down to? Then there's no second view to offer.
    $('tabPlain').classList.toggle('hidden', !currentJob.plain);
    $('shareBtn').classList.toggle('hidden', !navigator.share);
    renderBody();
    show('viewScreen');
  } catch (e) { toast(e.message); }
}

function bodyText() { return $('viewBody').textContent || ''; }

async function copyAll() {
  const text = bodyText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ✓');
  } catch {
    // Older iOS Safari refuses clipboard writes outside a tight gesture —
    // fall back to selecting it so the user can copy by hand.
    const range = document.createRange();
    range.selectNodeContents($('viewBody'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected — press Copy');
  }
}

// -------------------------------------------------------------- startup ---
function startMain() {
  show('mainScreen');
  loop();
}

function wireUp() {
  $('pairBtn').addEventListener('click', doPair);
  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) doPair();
  });

  $('goBtn').addEventListener('click', submitUrl);
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUrl(); });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { $('urlInput').value = t.trim(); toast('Pasted'); }
    } catch { toast('Hold the box and tap Paste'); }
  });

  $('statusPill').addEventListener('click', refresh);
  $('unpairBtn').addEventListener('click', unpair);
  $('backBtn').addEventListener('click', () => { show('mainScreen'); loop(); });
  $('tabPlain').addEventListener('click', () => { stampedView = false; renderBody(); });
  $('tabStamped').addEventListener('click', () => { stampedView = true; renderBody(); });
  $('copyBtn').addEventListener('click', copyAll);
  $('shareBtn').addEventListener('click', () => {
    navigator.share({ title: currentJob?.title || 'Transcript', text: bodyText() }).catch(() => {});
  });

  // Coming back to the app should feel instant, not four seconds stale.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });
}

function boot() {
  wireUp();

  // Android share-sheet / ?url= handoff: a link handed in lands straight in the box.
  const shared = new URLSearchParams(location.search).get('url')
              || new URLSearchParams(location.search).get('text');

  if (deviceId) {
    startMain();
    if (shared) {
      $('urlInput').value = shared.trim();
      history.replaceState({}, '', '/');
      submitUrl();
    }
  } else {
    show('pairScreen');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
