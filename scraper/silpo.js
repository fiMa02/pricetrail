// ТЕСТ: каталог Сільпо — по одному магазину в кожному нашому місті, де є Сільпо, щоб порівнювати з АТБ.
// Дані — з відкритого API, яким користується сам сайт silpo.ua (sf-ecom-api.silpo.ua, без перевірок Cloudflare).
//
//   node scraper/silpo.js               — усі міста
//   node scraper/silpo.js --city kyiv   — одне місто
//
// Магазин міста — з найбільшим асортиментом серед найближчих до центру; вибір запам'ятовується в
// scraper/silpo-stores.json (щоб історія цін була з того самого магазину; його можна змінити вручну — так, у Києві
// замість центрального магазину на Басейній, де ціни на 6–9% вищі, ніж в інших київських, узято звичайний).
// Міста без Сільпо пропускаємо.
// Результат — у тому самому форматі, що й АТБ, із полем chain: 'silpo' (порожні поля не пишемо):
//   site/data/chains/silpo/<місто>/products.json, meta.json, history/NN.json
// id товару = SILPO_ID_BASE + externalProductId, щоб не перетинатися з id АТБ (вони до ~300 тис.).
// Мапу «Рівень цін у містах» для Сільпо будує окремий знімок — scraper/silpo-snapshot.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';
import { entry, record, derive } from './scrape.js';

const API = 'https://sf-ecom-api.silpo.ua/v1/uk';
const STORES_FILE = path.resolve('scraper/silpo-stores.json');
const SHARDS = 100;
const DELAY_MS = 500;
const PARALLEL = 3;
const PAGE = 100; // більше API не віддає
const SILPO_ID_BASE = 10_000_000;
const PROBE = 'molochni-produkty-ta-iaitsia-234'; // за кількістю цих товарів у наявності вибираємо магазин
const PROBE_MIN = 100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Розділи Сільпо → наші розділи (як в АТБ), щоб фільтр розділів був спільний.
// Добрі промо, Власні марки й Лавка Традицій — добірки товарів з інших розділів; аптеку й БАДи не беремо.
const GROUP_OF = {
  'frukty-ovochi-4788': 'Овочі та фрукти',
  'm-iaso-4411': "М'ясо",
  'ryba-4430': 'Риба і морепродукти',
  'kovbasni-vyroby-i-m-iasni-delikatesy-4731': "Ковбаса і м'ясні делікатеси",
  'syry-1468': 'Молочні продукти та яйця',
  'molochni-produkty-ta-iaitsia-234': 'Молочні продукти та яйця',
  'khlib-ta-vypichka-5121': 'Хлібобулочні вироби',
  'gotovi-stravy-i-kulinariia-4761': 'Кулінарія',
  'zdorove-kharchuvannia-4864': 'Бакалія',
  'bakaliia-i-konservy-4870': 'Бакалія',
  'sousy-i-spetsii-4938': 'Бакалія',
  'solodoshchi-498': 'Кондитерські вироби',
  'sneky-ta-chypsy-5016': 'Чипси, снеки',
  'kava-chai-359': 'Кава, чай',
  'napoi-52': 'Напої безалкогольні',
  'zamorozhena-produktsiia-264': 'Заморожені продукти',
  'alkogol-22': 'Алкоголь',
  'sygarety-stiky-zhuiky-4384': 'Тютюнові вироби',
  'kvity-tovary-dlia-sadu-ta-gorodu-476': 'Дім, одяг і дозвілля',
  'dlia-domu-567': 'Товари для дому',
  'gigiiena-ta-krasa-4519': 'Гігієна і косметика',
  'dytiachi-tovary-449': 'Товари для дітей',
  'dlia-tvaryn-653': 'Товари для тварин',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const sameName = (a, b) => a.toLowerCase().replace(/[’'ʼ`]/g, '') === b.toLowerCase().replace(/[’'ʼ`]/g, '');
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180));

async function get(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.ok) return res.json();
  if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
    await sleep(5000 * attempt);
    return get(url, attempt + 1);
  }
  throw new Error(`HTTP ${res.status} ${url}`);
}
const readJson = (file, fallback) => fs.readFile(file, 'utf8').then(JSON.parse, () => fallback);
const productsUrl = (branchId, category, offset, limit = PAGE) =>
  `${API}/branches/${branchId}/products?limit=${limit}&offset=${offset}&deliveryType=DeliveryHome&category=${category}&includeChildCategories=true&inStock=true`;

// Магазин для міста: серед 8 найближчих до центру — з найбільшим асортиментом у наявності (за молочними
// товарами); з майже рівних (від 85% найбільшого) — ближчий. У деяких магазинах каталог є, а в наявності — десятки товарів.
async function pickStore(city, branches) {
  const near = branches
    .filter((b) => sameName(b.cityFull || '', city.name))
    .map((b) => ({ b, d: km(city, { lat: +b.latitude, lon: +b.longitude }) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 8);
  for (const x of near) {
    x.n = (await get(productsUrl(x.b.branchId, PROBE, 0, 1))).total;
    await sleep(DELAY_MS);
  }
  const best = Math.max(0, ...near.map((x) => x.n));
  if (best < PROBE_MIN) return null;
  const { b } = near.find((x) => x.n >= best * 0.85);
  return { branchId: b.branchId, address: b.addressFull, lat: +b.latitude, lon: +b.longitude };
}

async function scrapeStore(city, store) {
  const started = Date.now();
  const base = `${API}/branches/${store.branchId}`;
  // Підкатегорія товару — розділ другого рівня, до якого належить його кінцева категорія (sectionSlug).
  const cats = (await get(`${base}/categories`)).items;
  const byId = new Map(cats.map((c) => [c.id, c]));
  const level2 = new Map();
  for (const c of cats) {
    let x = c;
    while (x.parentId && byId.get(x.parentId)?.parentId) x = byId.get(x.parentId);
    level2.set(c.slug, x.parentId ? x.title : c.title);
  }

  const products = new Map();
  for (const [top, group] of Object.entries(GROUP_OF)) {
    for (let offset = 0; ; offset += PAGE) {
      const j = await get(productsUrl(store.branchId, top, offset));
      for (const x of j.items) {
        if (!(x.price > 0)) continue;
        const id = SILPO_ID_BASE + x.externalProductId;
        if (products.has(id)) continue;
        const weighted = x.ratio === 'кг';
        // Вага/об'єм у назві Сільпо немає — вона в displayRatio («180г»); дописуємо, щоб рахувати ціну за кг/л.
        const size = !weighted && /\d/.test(x.displayRatio || '') ? ` ${x.displayRatio}` : '';
        products.set(id, {
          id,
          chain: 'silpo',
          name: `${x.title}${size}`,
          url: `/product/${x.slug}`,
          img: `https://images.silpo.ua/products/300x300/webp/${x.icon}`,
          price: x.price,
          oldPrice: x.oldPrice && x.oldPrice > x.price ? x.oldPrice : null,
          unit: weighted ? 'кг' : 'шт',
          category: level2.get(x.sectionSlug) || null,
          brand: x.brandTitle || null,
          group,
        });
      }
      await sleep(DELAY_MS);
      if (offset + PAGE >= j.total) break;
    }
  }

  const dir = path.resolve('site/data/chains/silpo', city.slug);
  const historyDir = path.join(dir, 'history');
  await fs.mkdir(historyDir, { recursive: true });
  const shards = [];
  for (let i = 0; i < SHARDS; i++) shards.push(await readJson(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), {}));
  let changed = 0;
  for (const p of products.values()) {
    const hist = (shards[p.id % SHARDS][p.id] ||= []);
    if (record(hist, entry(p.price, p.oldPrice, false, null))) changed++;
    derive(p, hist);
    for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  }
  for (let i = 0; i < SHARDS; i++) await fs.writeFile(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  await fs.writeFile(path.join(dir, 'products.json'), JSON.stringify(list));
  const meta = { updated: today, updatedAt: new Date().toISOString(), productCount: list.length, store: { id: store.branchId, address: store.address } };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[${city.name}] ${list.length} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
}

const args = process.argv.slice(2);

const only = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
const stores = await readJson(STORES_FILE, {});
const branches = (await get(`${API}/branches`)).items;
const queue = CITIES.filter((c) => !only || c.slug === only);
const skipped = [];
let failed = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let city; (city = queue.shift()); ) {
      try {
        stores[city.slug] ||= await pickStore(city, branches);
        if (!stores[city.slug]) {
          delete stores[city.slug];
          skipped.push(city.name);
          continue;
        }
        await scrapeStore(city, stores[city.slug]);
      } catch (err) {
        failed++;
        console.error(`[${city.name}] ПОМИЛКА: ${err.message}`);
      }
    }
  }),
);
await fs.writeFile(STORES_FILE, JSON.stringify(stores, null, 2));
if (skipped.length) console.log(`Без Сільпо (пропущено): ${skipped.join(', ')}`);
if (failed) process.exitCode = 1;
