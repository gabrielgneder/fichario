// Service worker: deixa o app abrir sem internet.
// Ao publicar uma versão nova, aumente o número em VERSION para o celular baixar os arquivos novos.
const VERSION = "fichario-v6";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google (login, Drive) nunca passa pelo cache
  if (/(^|\.)googleapis\.com$|accounts\.google\.com$/.test(url.hostname) && !/fonts\.googleapis\.com$/.test(url.hostname)) return;

  // Fontes: guarda a primeira cópia e usa sempre
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(VERSION + "-fonts").then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }
      catch (err) { return new Response("", { status: 504 }); }
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Página: tenta a rede primeiro (pega atualizações), cai no cache se estiver offline
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put("./", copy)); return res; })
      .catch(() => caches.match("./").then(r => r || caches.match("index.html"))));
    return;
  }

  // Demais arquivos do app: cache primeiro
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
