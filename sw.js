// App shell served from the device instantly (cache first). Google API calls are never cached here.
// Updating: bump VERSION. The new version is downloaded in the background as one complete set,
// then the page offers "Reload" (or picks it up on the next open). Files are never mixed across versions.
const VERSION = `stash-v35`;
const SHELL = [
  `./`, `./index.html`, `./css/app.css`, `./manifest.webmanifest`,
  `./js/app.js`, `./js/config.js`, `./js/google.js`, `./js/store.js`, `./js/search.js`, `./js/image.js`, `./js/ui.js`, `./js/idb.js`, `./js/ai.js`, `./js/scan.js`, `./js/qrscan.js`, `./js/licensing.js`, `./js/licensing-stub.js`, `./js/licensing-rules.js`, `./js/vendor/jsQR.min.js`,
  `./icons/icon-192.png`, `./icons/icon-512.png`,
];

self.addEventListener(`install`, (e) => {
  // Each file is requested as "<file>?v=<VERSION>" so neither the browser cache nor GitHub's CDN can hand back an older
  // copy, then stored under its plain name. If any file fails, the install fails and the current version keeps running.
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(async (u) => {
      const res = await fetch(new Request(`${u}${u.includes(`?`) ? `&` : `?`}v=${VERSION}`, { cache: `no-store` }));
      if (!res.ok) throw new Error(`${u}: ${res.status}`);
      await cache.put(u, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener(`activate`, (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener(`fetch`, (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== `GET` || url.origin !== location.origin) return; // Google APIs go straight to the network
  const isPage = e.request.mode === `navigate`;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(isPage ? `./index.html` : e.request, { ignoreSearch: isPage });
    if (hit) return hit;                       // instant, no network wait
    try {
      const res = await fetch(e.request);      // not in the shell (e.g. a new file): network, then keep it
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(`./index.html`)) || Response.error();
    }
  })());
});
