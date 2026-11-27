// Service worker (module) : coquille hors ligne + réception des photos partagées (Web Share Target).
// Coquille précachée à l'installation ; les modèles (models/*.bin) sont mis en cache à leur première lecture,
// dans un cache à part qui survit aux changements de version. face/ (MediaPipe, 15 Mo) n'est jamais précaché : lib/face.js le
// copie dans « vs-face » à la première utilisation.
import { createStore } from './lib/store.js';

// publish.mjs remplace le marqueur ci-dessous par la version de precache.json : chaque publication change les octets de sw.js.
const VERSION = 'b853a20e13e9bea6';
const MODELS = 'vs-models';
const isModel = (p) => p.startsWith('models/') && p.endsWith('.bin');
const rel = (url) => new URL(url).pathname.slice(new URL('./', self.location.href).pathname.length);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const pc = await (await fetch('./precache.json', { cache: 'no-store' })).json();
    const c = await caches.open('vs-' + VERSION);
    await c.addAll(['./', ...pc.files.map((f) => f.path).filter((p) => !isModel(p) && !p.startsWith('face/')).map((p) => './' + p)].map((u) => new Request(u, { cache: 'reload' })));
    await c.put('./precache.json', new Response(JSON.stringify(pc)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== MODELS && k !== 'vs-face' && k !== 'vs-' + VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const r = e.request, p = rel(r.url);
  if (r.method === 'POST' && p === 'share') {
    e.respondWith((async () => {
      const files = (await r.formData()).getAll('photos').filter((f) => f instanceof File);
      await createStore().putShared(files);
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (r.method !== 'GET') return;
  e.respondWith((async () => {
    // Le document à la racine du scope (start_url « ./ », « ./?shared=1 ») est servi par index.html précaché.
    const hit = await caches.match(r.mode === 'navigate' && p === '' ? './index.html' : r, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(r); // les modèles sont écrits dans « vs-models » par la page (lib/models.js)
  })());
});
