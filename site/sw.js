// Оболонка сайту — з кешу; дані — спершу з мережі (щоб ціни були свіжими), з кешу лише офлайн.
const V = 57; // збільшувати разом із ?v= в index.html при кожній зміні сайту
const CACHE = `pricetrail-v${V}`;
// Обране (копія з localStorage сторінки) і вже надіслані сповіщення — не видаляються при оновленні.
const STATE = 'pricetrail-state';
const SHELL = ['./', 'index.html', `style.css?v=${V}`, `app.js?v=${V}`, 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== STATE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // no-cache: браузер звіряє файл із сервером (ETag), а не бере мовчки з HTTP-кешу (на GitHub Pages — до 10 хв).
  e.respondWith(
    fetch(e.request.mode === 'navigate' ? e.request.url : e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// ---------- Фонова перевірка обраного (Periodic Background Sync) ----------

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'prices') e.waitUntil(checkFavs());
});

const fmtPrice = (v) => v.toFixed(2).replace('.', ',');

// Та сама умова, що й на сторінці: ціна нижча за останню побачену (і не вища за бажану, якщо її задано).
async function checkFavs() {
  const st = await caches.open(STATE);
  const saved = await st.match('state/favs').then((r) => r?.json());
  if (!saved?.city || !saved.favs || !Object.keys(saved.favs).length) return;
  const load = (file) => fetch(`data/cities/${saved.city}/${file}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : []));
  // extra.json — товари, яких у місті немає, з цінами найближчого міста.
  const [own, extra] = await Promise.all([load('products.json'), load('extra.json').catch(() => [])]);
  const byId = new Map(extra.concat(own).map((p) => [p.id, p]));
  const notified = (await st.match('state/notified').then((r) => r?.json())) || {};
  const hits = [];
  for (const [id, f] of Object.entries(saved.favs)) {
    const p = byId.get(+id);
    const seen = f.seen?.[saved.city];
    if (!p || seen == null || !(p.price < seen - 0.004 && (!f.target || p.price <= f.target))) continue;
    const key = `${saved.city}:${id}`;
    if (notified[key] === p.price) continue; // про цю ціну вже повідомляли
    notified[key] = p.price;
    hits.push({ p, seen });
  }
  if (!hits.length) return;
  const opts = { icon: 'icon-192.png', badge: 'icon-192.png', lang: 'uk' };
  if (hits.length > 3) {
    await self.registration.showNotification(`Подешевшало з обраного: ${hits.length}`, {
      ...opts,
      body: hits.slice(0, 3).map(({ p }) => p.name).join(', ') + '…',
      tag: 'favs',
      data: { url: './#/fav' },
    });
  } else {
    for (const { p, seen } of hits) {
      await self.registration.showNotification(p.name, {
        ...opts,
        body: `Подешевшало: ${fmtPrice(seen)} → ${fmtPrice(p.price)} грн${p.oldPrice ? ' (акція)' : ''}`,
        tag: `fav-${p.id}`,
        data: { url: `./#/p/${p.id}` },
      });
    }
  }
  await st.put('state/notified', new Response(JSON.stringify(notified)));
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#/fav', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins[0];
      if (!win) return self.clients.openWindow(url);
      return win.navigate(url).then((w) => (w || win).focus());
    }),
  );
});
