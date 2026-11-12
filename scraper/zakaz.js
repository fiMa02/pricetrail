// ТЕСТ: каталоги мереж з платформи zakaz.ua — Метро, Ашан, Новус, Таврія В, МегаМаркет, ЕкоМаркет.
// Дані — з відкритого API, яким користуються їхні сайти доставки (stores-api.zakaz.ua).
//
//   node scraper/zakaz.js                       — усі мережі й міста
//   node scraper/zakaz.js --chain metro         — одна мережа (можна кілька через кому)
//   node scraper/zakaz.js --chain metro --city kyiv
//
// По одному магазину в кожному нашому місті, де мережа є (з найбільшим асортиментом); вибір запам'ятовується в
// scraper/zakaz-stores.json. Результат — як у Сільпо: site/data/chains/<мережа>/<місто>/… (див. chain-store.js).
// id товару = база мережі + номер штрихкоду в scraper/zakaz-ids.json (EAN → порядковий номер, спільний для всіх
// мереж zakaz.ua — той самий товар у Метро й Ашані має однаковий номер). Штрихкоди для пошуку — scraper/barcodes.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';
import { fetchJson, saveCatalog, writeCities, groupOf, readJson, sleep } from './chain-store.js';

const API = 'https://stores-api.zakaz.ua';
export const ZAKAZ_CHAINS = {
  metro: { base: 30_000_000, title: 'Метро' },
  auchan: { base: 40_000_000, title: 'Ашан' },
  novus: { base: 50_000_000, title: 'Новус' },
  tavriav: { base: 60_000_000, title: 'Таврія В' },
  megamarket: { base: 70_000_000, title: 'МегаМаркет' },
  ekomarket: { base: 80_000_000, title: 'ЕкоМаркет' },
};
// Міста zakaz.ua → наші.
const CITY_OF = {
  kiev: 'kyiv', lviv: 'lviv', odesa: 'odesa', kharkiv: 'kharkiv', dnipro: 'dnipro', kryvyyrig: 'kryvyi-rih', vinnytsia: 'vinnytsia',
  poltava: 'poltava', ivanofrankivsk: 'ivano-frankivsk', chernivtsi: 'chernivtsi', rivne: 'rivne', zhytomyr: 'zhytomyr',
};
// Сезонні добірки й акційні підбірки — товари з інших розділів; не обходимо.
const SKIP_TOP = /новий рік|різдв|вигідн|спеціальн|пропозиц/i;
const STORES_FILE = path.resolve('scraper/zakaz-stores.json');
const IDS_FILE = path.resolve('scraper/zakaz-ids.json');
const PAGE = 100;
const DELAY_MS = 500;
const PARALLEL = 1; // zakaz.ua обмежує частоту запитів (429) — по одному
const NEXT = '_next'; // у zakaz-ids.json — останній виданий номер

const get = (url) => fetchJson(API + url, { headers: { 'Accept-Language': 'uk' } });

async function pickStore(chain, slug, stores) {
  const own = stores.filter((s) => s.retail_chain === chain && CITY_OF[s.city] === slug);
  let best = null;
  for (const s of own) {
    const tree = await get(`/stores/${s.id}/categories/`);
    const n = tree.filter((t) => !SKIP_TOP.test(t.title) && (t.children || []).length).reduce((a, t) => a + t.count, 0);
    if (!best || n > best.n) best = { n, s };
    await sleep(DELAY_MS);
  }
  if (!best) return null;
  const a = best.s.address || {};
  return { id: best.s.id, address: [a.street, a.building].filter(Boolean).join(', ') || best.s.name, lat: a.coords?.lat, lon: a.coords?.lng };
}

async function scrapeStore(chain, city, store, ids) {
  const started = Date.now();
  const { base } = ZAKAZ_CHAINS[chain];
  const tree = await get(`/stores/${store.id}/categories/`);
  const products = new Map();
  // Обходимо підрозділи 2-го рівня: у списку верхнього розділу category_id товару — сам цей розділ, без підрозділу.
  for (const top of tree) {
    if (SKIP_TOP.test(top.title) || !(top.children || []).length) continue;
    const t = top.title.trim();
    for (const subCat of top.children) {
      const sub = subCat.title.trim();
      for (let page = 1; ; page++) {
        const j = await get(`/stores/${store.id}/categories/${subCat.id}/products/?per_page=${PAGE}&page=${page}`);
        for (const x of j.results) {
          if (!x.ean || !(x.price > 0) || x.in_stock === false) continue;
          const local = (ids[x.ean] ||= ++ids[NEXT]);
          const id = base + local;
          if (products.has(id)) continue;
          const old = x.discount?.status && x.discount.old_price > x.price ? x.discount.old_price / 100 : null;
          let url = x.web_url || '';
          try {
            url = new URL(url).pathname;
          } catch {}
          products.set(id, {
            id,
            chain,
            name: x.title.trim(),
            url,
            img: x.img?.s200x200 || x.img?.s150x150 || null,
            price: x.price / 100,
            oldPrice: old,
            unit: x.unit === 'kg' ? 'кг' : 'шт',
            category: sub,
            brand: x.producer?.trademark || null,
            group: groupOf(t, sub),
          });
        }
        await sleep(DELAY_MS);
        if (page * PAGE >= j.count || !j.results.length) break;
      }
    }
  }
  const changed = await saveCatalog(chain, city.slug, products, { id: store.id, address: store.address });
  console.log(`[${ZAKAZ_CHAINS[chain].title}, ${city.name}] ${products.size} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
}

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const onlyChains = arg('--chain')?.split(',') || Object.keys(ZAKAZ_CHAINS);
const onlyCity = arg('--city');

const saved = await readJson(STORES_FILE, {});
const ids = await readJson(IDS_FILE, {});
ids[NEXT] ||= 0;
const allStores = await get('/stores/');
// Черга «мережа × місто»; міста — лише наші, де мережа є.
const queue = [];
for (const chain of onlyChains) {
  if (!ZAKAZ_CHAINS[chain]) throw new Error(`Невідома мережа: ${chain}`);
  const slugs = new Set(allStores.filter((s) => s.retail_chain === chain).map((s) => CITY_OF[s.city]).filter(Boolean));
  for (const city of CITIES) if (slugs.has(city.slug) && (!onlyCity || city.slug === onlyCity)) queue.push([chain, city]);
}
let failed = 0;
const saveIds = () => fs.writeFile(IDS_FILE, JSON.stringify(ids));
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let job; (job = queue.shift()); ) {
      const [chain, city] = job;
      try {
        const key = `${chain}/${city.slug}`;
        saved[key] ||= await pickStore(chain, city.slug, allStores);
        if (!saved[key]) continue;
        await scrapeStore(chain, city, saved[key], ids);
        await saveIds();
      } catch (err) {
        failed++;
        console.error(`[${chain}, ${city.name}] ПОМИЛКА: ${err.message}`);
      }
    }
  }),
);
await fs.writeFile(STORES_FILE, JSON.stringify(saved, null, 2));
await saveIds();
for (const chain of onlyChains) await writeCities(chain);
console.log(`zakaz.ua: готово${failed ? `, з помилками ${failed}` : ''}`);
if (failed) process.exitCode = 1;
