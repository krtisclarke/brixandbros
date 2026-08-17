/* Brix and Bros — offline cache for the hosted copy.
   After the first visit, the phone keeps its own copy of every file, so the
   home-screen app works with no server and no internet.
   Bump VERSION whenever game files change so players pick up the update. */
const VERSION = 'brix-v14';
/* Cache Storage is scoped to the ORIGIN, and both games live on the same
   github.io origin. The activate handler below sweeps away old caches, so it
   must only sweep away OUR old caches — without this prefix it would delete
   the other game's offline copy every time this one updated. */
const PREFIX = 'brix-';
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'js/data.js',
  'js/waves.js',
  'js/engine.js',
  'js/render.js',
  'js/music.js',
  'js/ui.js',
  'js/main.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first, cache as the fallback — not the other way round.

   Cache-first is the usual advice and it was wrong here. It answers from the
   copy on disk and only refreshes in the background, so the first visit after
   an update always shows the PREVIOUS version, and a second visit is needed to
   see the new one. Playing on a phone that is a nuisance; while the game is
   being worked on it reads as the change having been lost, and cost a round of
   "it reverted" over a build that had shipped correctly.

   The trade is one network round-trip when online, on a handful of small files
   from the same origin. With no network — the whole point of the cache — the
   fetch fails and the stored copy answers exactly as before, so the
   home-screen app still works offline. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
