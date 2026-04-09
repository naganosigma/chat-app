const CACHE = 'sigmachat-v1';
const ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // ソケット通信・API・画像アップロードはキャッシュしない
  if (e.request.url.includes('/socket.io') ||
      e.request.url.includes('/upload') ||
      e.request.url.includes('/join') ||
      e.request.url.includes('/uploads/')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
