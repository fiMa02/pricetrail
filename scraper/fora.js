// ТЕСТ: каталог Фори — по одному магазину в кожному нашому місті, де Фора є.
// Дані — з відкритого API, яким користується сам сайт fora.ua (api.catalog.ecom.fora.ua).
//
//   node scraper/fora.js               — усі міста
//   node scraper/fora.js --city kyiv   — одне місто
//
// Магазин міста — з найбільшим асортиментом серед найближчих до центру; вибір запам'ятовується в scraper/fora-stores.json.
// Результат — як у Сільпо: site/data/chains/fora/<місто>/… (див. chain-store.js).
// Фора й Сільпо — одна група (Fozzy), коди товарів спільні: id = FORA_ID_BASE + код (у Сільпо — SILPO_ID_BASE + код),
// тож той самий товар зіставляється з Сільпо за кодом, а штрихкоди беруться з Сільпо (scraper/silpo-barcodes.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';
import { fetchJson, saveCatalog, writeCities, groupOf, readJson, sleep } from './chain-store.js';

const API = 'https://api.catalog.ecom.fora.ua/api/2.0/exec/EcomCatalogGlobal';
const MERCHANT = 2; // Фора (1 — Сільпо)
const BUSINESS = 4;
const FORA_ID_BASE = 90_000_000;
const STORES_FILE = path.resolve('scraper/fora-stores.json');
const PAGE = 200;
const DELAY_MS = 400;
const PARALLEL = 2;

const call = (method, data) => fetchJson(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, data }) });
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180));
// «м. Київ», «смт Козин», «сел. Гатне», «м. Гостомель (Ірпінь)» → «київ», «козин»…
const cityName = (s) => s.replace(/^(м|смт|сел|с)\.?\s+/i, '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase().replace(/[’'ʼ`]/g, '');

async function scrapeStore(city, store) {
  const started = Date.now();
  const products = new Map();
  for (let from = 1; ; from += PAGE) {
    const j = await call('GetSimpleCatalogItems', { merchantId: MERCHANT, deliveryType: 2, filialId: store.id, From: from, To: from + PAGE - 1 });
    for (const x of j.items || []) {
      if (!(x.price > 0)) continue;
      const id = FORA_ID_BASE + x.id;
      if (products.has(id)) continue;
      const cats = x.categories || [];
      const top = cats.find((c) => !c.parentId)?.name;
      const sub = cats.find((c) => c.parentId && cats.some((t) => !t.parentId && t.id === c.parentId))?.name;
      const weighted = x.isWeightedProduct;
      // У вагових товарів ціна — за вагу з unit: «кг» або «100г» (цукерки, сир…). Переводимо в ціну за 1 кг.
      const g = weighted && /^(\d+(?:[.,]\d+)?)\s*(г|кг)$/i.exec((x.unit || '').trim());
      const perKg = g ? 1000 / (parseFloat(g[1].replace(',', '.')) * (g[2].toLowerCase() === 'кг' ? 1000 : 1)) : 1;
      const kg = (v) => Math.round(v * perKg * 100) / 100;
      // Вага/об'єм — в unit («900г»); дописуємо до назви, щоб рахувати ціну за кг/л.
      const size = !weighted && /\d/.test(x.unit || '') ? ` ${x.unit}` : '';
      products.set(id, {
        id,
        chain: 'fora',
        name: `${x.name.trim()}${size}`,
        url: `/product/${x.slug}`,
        img: x.mainImage || null,
        price: kg(x.price),
        oldPrice: x.oldPrice && x.oldPrice > x.price ? kg(x.oldPrice) : null,
        unit: weighted ? 'кг' : 'шт',
        category: sub || top || null,
        group: groupOf(top, sub),
      });
    }
    await sleep(DELAY_MS);
    if (!(j.items || []).length || from + PAGE > j.itemsCount) break;
  }
  const changed = await saveCatalog('fora', city.slug, products, { id: store.id, address: store.address });
  console.log(`[Фора, ${city.name}] ${products.size} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
}

const args = process.argv.slice(2);
const only = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
const saved = await readJson(STORES_FILE, {});
const filials = (await call('GetPickupFilials', { businessId: BUSINESS })).items || [];
const queue = [];
for (const city of CITIES) {
  if (only && city.slug !== only) continue;
  if (!saved[city.slug]) {
    const own = filials.filter((f) => cityName(f.city || '') === cityName(city.name)).sort((a, b) => km(city, a) - km(city, b));
    if (!own.length) continue;
    // З 8 найближчих до центру — з найбільшим асортиментом; з майже рівних (від 90% найбільшого) — ближчий.
    const near = own.slice(0, 8);
    for (const f of near) {
      f.n = (await call('GetSimpleCatalogItems', { merchantId: MERCHANT, deliveryType: 2, filialId: f.id, From: 1, To: 1 })).itemsCount || 0;
      await sleep(DELAY_MS);
    }
    const best = Math.max(...near.map((f) => f.n));
    const f = near.find((x) => x.n >= best * 0.9);
    saved[city.slug] = { id: f.id, address: f.address, lat: f.lat, lon: f.lon };
  }
  queue.push(city);
}
let failed = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let city; (city = queue.shift()); ) {
      try {
        await scrapeStore(city, saved[city.slug]);
      } catch (err) {
        failed++;
        console.error(`[Фора, ${city.name}] ПОМИЛКА: ${err.message}`);
      }
    }
  }),
);
await fs.writeFile(STORES_FILE, JSON.stringify(saved, null, 2));
const cities = await writeCities('fora');
console.log(`Фора: готово, міст ${cities.length}${failed ? `, з помилками ${failed}` : ''}`);
if (failed) process.exitCode = 1;
