// Just enough service worker to make this installable and to open instantly.
// The shell is cached; every /api/ call goes straight to the network, because a
// cached "your computer is awake" would be a lie.

const CACHE = 'pocket-transcript-v5';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js',
               '/install', '/install.css', '/install.js',
               '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // never cache status or transcripts
  if (url.pathname.endsWith('.shortcut')) return; // a download handed back by the worker lands as .html on iPhone

  // Network first so a deployed change shows up, cache as the offline safety net.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
