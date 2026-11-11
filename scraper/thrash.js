// ТЕСТ: акції «Траш!» (THRASH!, дискаунтер Fozzy Group) — для порівняння з АТБ і Сільпо в тестовій копії.
// Повного каталогу «Траш!» у відкритому доступі немає: thrash.ua/graphql віддає лише акційні пропозиції
// (сторінки «Акції» й головна, ~300 товарів) і однаково для всіх магазинів, тож каталог один на всю мережу.
// Артикул «Траш!» — той самий код товару, що й у Сільпо, тож розділ, підкатегорію й бренд беремо з каталогу Сільпо.
//
//   node scraper/thrash.js
//
// Результат — у форматі АТБ, із полем chain: 'thrash' і датами акції (since, until — останній день):
//   site/data/chains/thrash/products.json, meta.json, changes.json, history/NN.json — лише товари з чинною акцією;
//   site/data/chains/thrash/cities.json — [{ slug }]: наші міста, де є магазини «Траш!».
// id товару = THRASH_ID_BASE + артикул.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';
import { entry, record, derive } from './scrape.js';
import { writeChanges } from './changes.js';

const API = 'https://thrash.ua/graphql';
const DIR = path.resolve('site/data/chains/thrash');
const SILPO_DIR = path.resolve('site/data/chains/silpo');
const SHARDS = 100;
const THRASH_ID_BASE = 20_000_000;
const SILPO_ID_BASE = 10_000_000;
const PAGES = ['actions', 'main']; // на головній є ще добірка вин, якої немає в «Акціях»
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const kyivDate = (iso) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date(iso));
const readJson = (file, fallback) => fs.readFile(file, 'utf8').then(JSON.parse, () => fallback);
const key = (s) => s.toLowerCase().replace(/[’'ʼ`]/g, '');

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${API}`);
  const j = await res.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const OFFERS = `query($page: String!) {
  offersSplited(pagingInfo: { limit: 2000, offset: 0 }, pageSlug: $page, random: false) {
    products { items { ... on Product { articul title weight imageUrl price oldPrice activePeriod { start end } } } }
  }
}`;

// Розділ, підкатегорія й бренд — з каталогу Сільпо (будь-якого міста, де товар є).
const silpo = new Map();
for (const { slug } of await readJson(path.join(SILPO_DIR, 'cities.json'), [])) {
  for (const p of await readJson(path.join(SILPO_DIR, slug, 'products.json'), [])) if (!silpo.has(p.id)) silpo.set(p.id, p);
}

const products = new Map();
for (const page of PAGES) {
  const data = await gql(OFFERS, { page });
  for (const x of data.offersSplited.products.items) {
    const price = +x.price;
    if (!x.articul || !(price > 0)) continue;
    const id = THRASH_ID_BASE + x.articul;
    if (products.has(id)) continue;
    // «кг» без числа — ваговий товар (ціна за кг); «1кг», «500г», «0,5л» — фасовка, дописуємо до назви.
    const weighted = x.weight === 'кг';
    const s = silpo.get(SILPO_ID_BASE + x.articul);
    products.set(id, {
      id,
      chain: 'thrash',
      name: weighted || !x.weight ? x.title : `${x.title} ${x.weight}`,
      url: '/actions',
      img: x.imageUrl,
      price,
      oldPrice: +x.oldPrice > price ? +x.oldPrice : null,
      unit: weighted ? 'кг' : 'шт',
      category: s?.category || null,
      brand: s?.brand || null,
      group: s?.group || null,
      since: x.activePeriod?.start ? kyivDate(x.activePeriod.start) : null,
      // Кінець акції в API — північ UTC останнього дня.
      until: x.activePeriod?.end ? x.activePeriod.end.slice(0, 10) : null,
    });
  }
}
if (!products.size) throw new Error('Жодної акції «Траш!» не отримано');

const historyDir = path.join(DIR, 'history');
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
// Акція скінчилась — товару немає в наявності (звичайної ціни «Траш!» не публікує).
for (const shard of shards) {
  for (const [id, hist] of Object.entries(shard)) if (!products.has(+id)) record(hist, entry(null, null, true, null));
}
for (let i = 0; i < SHARDS; i++) await fs.writeFile(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
await writeChanges(DIR, shards, products, today, await readJson(path.join(DIR, 'products.json'), []));
const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
await fs.writeFile(path.join(DIR, 'products.json'), JSON.stringify(list));
await fs.writeFile(
  path.join(DIR, 'meta.json'),
  JSON.stringify({ updated: today, updatedAt: new Date().toISOString(), productCount: list.length, store: { address: 'усі магазини мережі (лише акції)' } }, null, 2),
);

// Наші міста, де є магазини «Траш!» (назви в API — з «м.», «смт», «с.»).
const { cities } = await gql('{ cities(marketStatusIds: [OPENED]) { title } }');
const names = new Set(cities.map((c) => key(c.title.replace(/^(м|смт|сел|с)\.?\s+/, ''))));
const ours = CITIES.filter((c) => names.has(key(c.name))).map((c) => ({ slug: c.slug }));
await fs.writeFile(path.join(DIR, 'cities.json'), JSON.stringify(ours));
const known = list.filter((p) => p.group).length;
console.log(`Траш!: ${list.length} акційних товарів (з розділом із каталогу Сільпо: ${known}), змін цін: ${changed}, наших міст: ${ours.length}`);
