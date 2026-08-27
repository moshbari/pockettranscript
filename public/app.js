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
let stampedView = false;

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
    const r = await api('/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
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
  clearInterval(pollTimer);
  show('pairScreen');
}

// -------------------------------------------------------------- status ----
// The bit Mosh asked for: if the Mac is asleep, say so plainly, right at the top.
function paintStatus(s) {
  const pill = $('statusPill');
  pill.className = 'pill ' + (s.online ? 'pill-online' : 'pill-offline');
  $('statusText').textContent = s.online ? 'Computer awake' : 'Computer asleep';
  $('asleepBanner').classList.toggle('hidden', !!s.online);
  $('deviceLabel').textContent = s.online
    ? `Connected to ${s.name}`
    : `${s.name} — last seen ${ago(s.lastSeenMsAgo)}`;
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
    const sub = {
      queued:  'Waiting for your computer…',
      working: 'Your computer is grabbing it…',
      done:    `${j.words.toLocaleString()} words · tap to read`,
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
          refresh();
        } catch (e) { toast(e.message); retry.disabled = false; }
      });
      row.appendChild(retry);
    }
    list.appendChild(row);
  }
}

async function refresh() {
  if (!deviceId) return;
  try {
    const s = await api(`/api/status?deviceId=${deviceId}`);
    paintStatus(s);
    paintJobs(s.jobs);
  } catch {
    // A dropped signal is not the same as a sleeping Mac — don't lie about it.
    $('statusPill').className = 'pill pill-unknown';
    $('statusText').textContent = 'No connection';
  }
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
    toast(r.online
      ? (r.duplicate ? 'Already working on that one' : 'Sent to your computer')
      : 'Queued — it will run when your Mac wakes');
    refresh();
  } catch (e) {
    showError($('mainError'), e.message);
  } finally {
    $('goBtn').disabled = false;
    $('goBtn').textContent = 'Get the transcript';
  }
}

// ------------------------------------------------------- transcript view --
function renderBody() {
  if (!currentJob) return;
  if (stampedView && currentJob.segments && currentJob.segments.length) {
    $('viewBody').textContent = currentJob.segments
      .map((s) => `[${s.timestamp}] ${s.text}`).join('\n');
  } else {
    $('viewBody').textContent = currentJob.text || '';
  }
  $('tabPlain').classList.toggle('active', !stampedView);
  $('tabStamped').classList.toggle('active', stampedView);
}

async function openJob(id) {
  try {
    const r = await api(`/api/jobs/${id}?deviceId=${deviceId}`);
    currentJob = r.job;
    stampedView = false;
    $('viewTitle').textContent = currentJob.title || 'Transcript';
    $('tabStamped').classList.toggle('hidden', !(currentJob.segments || []).length);
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
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 4000);
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
  $('backBtn').addEventListener('click', () => { show('mainScreen'); refresh(); });
  $('tabPlain').addEventListener('click', () => { stampedView = false; renderBody(); });
  $('tabStamped').addEventListener('click', () => { stampedView = true; renderBody(); });
  $('copyBtn').addEventListener('click', copyAll);
  $('shareBtn').addEventListener('click', () => {
    navigator.share({ title: currentJob?.title || 'Transcript', text: bodyText() }).catch(() => {});
  });

  // Coming back to the app should feel instant, not four seconds stale.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
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
