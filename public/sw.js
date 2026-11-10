const SHELL = 'pw-shell-v3';
const COVERS = 'pw-covers-v1';
const COVER_HOST = /(^|\.)(covers\.openlibrary\.org|archive\.org)$|^www\.gutenberg\.org$|^standardebooks\.org$/;
const FILES = ['/', '/style.css', '/app.js', '/lib.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  const proxiedCover = u.pathname === '/proxy' && /\.(jpe?g|png|avif|webp)$|\/b\/id\//i.test(u.searchParams.get('url') || '');
  if (u.pathname === '/proxy' && !proxiedCover) return;
  if (proxiedCover) {
    e.respondWith(caches.open(COVERS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  // Covers never change: cache-first so shelves paint instantly after the first visit.
  if (COVER_HOST.test(u.hostname) && /\.(jpe?g|png|avif|webp)$|\/b\/id\//i.test(u.pathname)) {
    e.respondWith(caches.open(COVERS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
    return;
  }
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (u.origin !== location.origin && !fonts) return;
  // App files: network first so updates land; fonts: cache first.
  e.respondWith(fonts
    ? caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(s => s.put(e.request, c)); return r; }))
    : fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(s => s.put(e.request, c)); return r; })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
});
