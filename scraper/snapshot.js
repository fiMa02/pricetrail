// Одноразовий знімок рівня цін у всіх містах АТБ — для мапи «Рівень цін у містах» на головній.
// У кожному місті беремо перший магазин зі списку й кілька розділів (вибірка, а не весь каталог);
// наші щоденні міста беремо з їхніх products.json за тими самими розділами.
//
//   node scraper/snapshot.js <coords.json>   — зібрати (продовжує з місця зупинки) і порахувати
//   node scraper/snapshot.js --build         — лише перерахувати site/data/levels.json із зібраного
//
// coords.json: { "Назва міста як на сайті АТБ": { lat, lon } } — координати пунктів, яких немає в cities.js.
// Сирі ціни — у .scratch/snapshot/<id міста АТБ>.json; результат — site/data/levels.json:
//   { date, cities: [{ name, slug?, lat, lon, v, n }] } — v: на скільки % дорожче за середнє, n: товарів у вибірці.
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CITIES } from './cities.js';
import { BASE, curl, sleep, DELAY_MS, parseCityIds, getCityStores, scrapeCategory } from './scrape.js';

const RAW_DIR = path.resolve('.scratch/snapshot');
const OUT = path.resolve('site/data/levels.json');
const PARALLEL = 5;
// Розділи вибірки й відповідні їм групи в products.json наших міст.
const SAMPLE = {
  '/catalog/molocni-produkti-ta-ajca': 'Молочні продукти та яйця',
  '/catalog/294-napoi-bezalkogol-ni': 'Напої безалкогольні',
  '/catalog/325-khlibobulochni-virobi': 'Хлібобулочні вироби',
  '/catalog/360-kovbasa-i-m-yasni-delikatesi': "Ковбаса і м'ясні делікатеси",
  '/catalog/kava-caj': 'Кава, чай',
  '/catalog/308-pobutova-khimiya-ta-neprodovol-chi-tovari': 'Побутова хімія та непродовольчі товари',
};
const MIN_COMMON = 150; // пари міст з меншою кількістю спільних товарів не враховуємо

async function collect(coordsFile) {
  const coords = JSON.parse(await fs.readFile(coordsFile, 'utf8'));
  const ours = new Set(CITIES.map((c) => c.name));
  await fs.mkdir(RAW_DIR, { recursive: true });
  const jar = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'atb-')), 'cookies.txt');
  const $ = cheerio.load(await curl(BASE + '/', { jar }));
  const session = { jar, csrf: $('meta[name="csrf-token"]').attr('content') };
  const done = new Set((await fs.readdir(RAW_DIR)).map((f) => f.replace('.json', '')));
  const queue = [...parseCityIds($)].filter(([name, id]) => !ours.has(name) && coords[name] && !done.has(id));
  console.log(`До збору: ${queue.length} міст (уже зібрано ${done.size})`);
  const started = Date.now();
  let n = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let item; (item = queue.shift()); ) {
        const [name, id] = item;
        try {
          const stores = await getCityStores(id, session);
          await sleep(DELAY_MS);
          if (!stores.length) {
            console.warn(`[${name}] магазинів немає`);
            continue;
          }
          const products = new Map();
          for (const href of Object.keys(SAMPLE)) await scrapeCategory(href, stores[0].id, products);
          const prices = Object.fromEntries([...products.values()].map((p) => [p.id, p.price]));
          await fs.writeFile(path.join(RAW_DIR, `${id}.json`), JSON.stringify({ name, store: stores[0], prices }));
          n++;
          console.log(`[${name}] ${products.size} товарів · ${n} готово, ${queue.length} лишилось, ${Math.round((Date.now() - started) / 60000)} хв`);
        } catch (err) {
          console.error(`[${name}] ПОМИЛКА: ${err.message}`);
        }
      }
    }),
  );
}

async function build(coordsFile) {
  const coords = coordsFile ? JSON.parse(await fs.readFile(coordsFile, 'utf8')) : {};
  const cities = [];
  // Наші щоденні міста — з останнього збору, за тими самими розділами.
  const groups = new Set(Object.values(SAMPLE));
  let date = '';
  for (const c of CITIES) {
    try {
      const list = JSON.parse(await fs.readFile(path.resolve('site/data/cities', c.slug, 'products.json'), 'utf8'));
      const meta = JSON.parse(await fs.readFile(path.resolve('site/data/cities', c.slug, 'meta.json'), 'utf8'));
      if (meta.updated > date) date = meta.updated;
      const prices = Object.fromEntries(list.filter((p) => !p.out && groups.has(p.group)).map((p) => [p.id, p.price]));
      cities.push({ name: c.name, slug: c.slug, lat: c.lat, lon: c.lon, prices });
    } catch {}
  }
  for (const f of await fs.readdir(RAW_DIR).catch(() => [])) {
    const raw = JSON.parse(await fs.readFile(path.join(RAW_DIR, f), 'utf8'));
    const at = coords[raw.name];
    if (at) cities.push({ name: raw.name, lat: at.lat, lon: at.lon, prices: raw.prices });
  }
  // Попарні середні логарифми співвідношення цін за спільними товарами → рівень міста (вага — кількість спільних).
  const logs = cities.map((c) => new Map(Object.entries(c.prices).map(([id, v]) => [id, Math.log(v)])));
  const level = cities.map((_, i) => {
    let sum = 0;
    let w = 0;
    for (let j = 0; j < cities.length; j++) {
      if (j === i) continue;
      let s = 0;
      let k = 0;
      for (const [id, a] of logs[i]) {
        const b = logs[j].get(id);
        if (b != null) {
          s += a - b;
          k++;
        }
      }
      if (k < MIN_COMMON) continue;
      sum += s;
      w += k;
    }
    return w ? sum / w : null;
  });
  const ok = level.filter((l) => l != null);
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  const out = cities
    .map((c, i) => level[i] != null && { name: c.name, ...(c.slug ? { slug: c.slug } : {}), lat: c.lat, lon: c.lon, v: Math.round((Math.exp(level[i] - mean) - 1) * 1000) / 10, n: logs[i].size })
    .filter(Boolean);
  await fs.writeFile(OUT, JSON.stringify({ date, cities: out }));
  console.log(`levels.json: ${out.length} міст, дата ${date}`);
}

const args = process.argv.slice(2);
if (args[0] === '--build') await build(args[1]);
else {
  await collect(args[0]);
  await build(args[0]);
}
