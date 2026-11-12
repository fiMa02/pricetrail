// Спільний каталог: вибір міста впливає лише на ціни.
// site/data/cities/<місто>/extra.json — товари, яких у цьому місті немає, з цінами міста, де вони є
// й відстежуються найдовше (з тих, що почали до TRACK_SLACK_DAYS пізніше, — найближчого по прямій); поле from — slug того міста. Свої products.json міст не змінюються.
//
//   node scraper/fallback.js — перебудувати з наявних products.json (парсер робить це сам після збору)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';
import { dropNull } from './scrape.js';

// Міста, де товар почали відстежувати не більше ніж на стільки днів пізніше, вважаємо рівними.
const TRACK_SLACK_DAYS = 7;
const DAY = 86400000;

// Відстань між центрами міст, км (формула гаверсинусів).
function distance(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Дата першого запису в історії кожного товару міста: id → 'YYYY-MM-DD'.
async function firstSeen(dir) {
  const since = new Map();
  for (const f of await fs.readdir(dir).catch(() => [])) {
    const shard = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    for (const [id, hist] of Object.entries(shard)) if (hist[0]) since.set(Number(id), hist[0][0]);
  }
  return since;
}

export async function buildFallback(dataDir) {
  const catalogs = new Map();
  const tracked = new Map();
  for (const city of CITIES) {
    try {
      const list = JSON.parse(await fs.readFile(path.join(dataDir, 'cities', city.slug, 'products.json'), 'utf8'));
      catalogs.set(city.slug, new Map(list.map((p) => [p.id, p])));
      tracked.set(city.slug, await firstSeen(path.join(dataDir, 'cities', city.slug, 'history')));
    } catch {
      // міста ще немає в даних
    }
  }
  const cities = CITIES.filter((c) => catalogs.has(c.slug));
  const all = new Set([...catalogs.values()].flatMap((m) => [...m.keys()]));

  for (const city of cities) {
    const own = catalogs.get(city.slug);
    const nearest = cities.filter((c) => c !== city).sort((a, b) => distance(city, a) - distance(city, b));
    const extra = [];
    for (const id of all) {
      if (own.has(id)) continue;
      // Спершу міста, де товар зараз у каталозі (якщо таких немає — де він лишився з позначкою out);
      // з них — найближче серед тих, де він відстежується найдовше (з допуском TRACK_SLACK_DAYS).
      const has = nearest.filter((c) => catalogs.get(c.slug).has(id));
      const inStock = has.filter((c) => !catalogs.get(c.slug).get(id).out);
      const pool = inStock.length ? inStock : has;
      const since = (c) => Date.parse(tracked.get(c.slug).get(id) || '9999-12-31');
      const oldest = Math.min(...pool.map(since));
      const src = pool.find((c) => since(c) - oldest <= TRACK_SLACK_DAYS * DAY);
      const { out, checked, ...p } = catalogs.get(src.slug).get(id);
      extra.push({ ...p, from: src.slug });
    }
    extra.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    await fs.writeFile(path.join(dataDir, 'cities', city.slug, 'extra.json'), JSON.stringify(extra, dropNull));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildFallback(path.resolve('site/data'));
  console.log('Спільний каталог (extra.json) оновлено.');
}
