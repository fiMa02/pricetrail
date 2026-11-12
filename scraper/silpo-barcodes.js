// ТЕСТ: штрихкоди товарів Сільпо (а з ними — Фори й «Траш!»: коди товарів у групи спільні) для пошуку за штрихкодом.
// Штрихкоди є лише на сторінці товару в API Сільпо (поле barcodes), тож запит на кожен товар; уже відомі не перезапитуємо.
//
//   node scraper/silpo-barcodes.js            — дозібрати штрихкоди товарів, яких ще немає в кеші
//   node scraper/silpo-barcodes.js --limit N  — не більше N запитів за запуск
//
// Внутрішні коди мережі (EAN з префіксом 2 — «для обігу в межах магазину») не беремо.
// Кеш: scraper/silpo-barcodes.json — { код товару: [штрихкоди] } (порожній масив — у товару штрихкодів немає).
// Пишеться кожні 500 товарів, тож перерваний збір продовжується з того самого місця.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchJson, readJson, sleep } from './chain-store.js';

const API = 'https://sf-ecom-api.silpo.ua/v1/uk';
const SILPO_ID_BASE = 10_000_000;
const CACHE = path.resolve('scraper/silpo-barcodes.json');
const DIR = path.resolve('site/data/chains/silpo');
const DELAY_MS = 300;
const PARALLEL = 2;

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const cache = await readJson(CACHE, {});
const stores = await readJson(path.resolve('scraper/silpo-stores.json'), {});

// Товари всіх міст Сільпо: код → [slug, магазин].
const todo = new Map();
for (const [slug, store] of Object.entries(stores)) {
  for (const p of await readJson(path.join(DIR, slug, 'products.json'), [])) {
    const code = p.id - SILPO_ID_BASE;
    if (!(code in cache) && !todo.has(code)) todo.set(code, [p.url.split('/').pop(), store.branchId]);
  }
}
const queue = [...todo].slice(0, limit);
console.log(`Штрихкоди Сільпо: у кеші ${Object.keys(cache).length}, треба дозібрати ${todo.size}, цей запуск — ${queue.length}`);
let done = 0;
let failed = 0;
const save = () => fs.writeFile(CACHE, JSON.stringify(cache));
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let job; (job = queue.shift()); ) {
      const [code, [slug, branch]] = job;
      try {
        const j = await fetchJson(`${API}/branches/${branch}/products/${slug}`);
        cache[code] = [...new Set((j.barcodes || []).map((b) => String(b).replace(/^0+/, '')).filter((b) => b.length >= 8 && !/^2\d{11,12}$/.test(b)))];
      } catch (err) {
        failed++;
        if (!/HTTP 404/.test(err.message)) console.error(`[${code}] ${err.message}`);
      }
      if (++done % 500 === 0) {
        await save();
        console.log(`… ${done} з ${done + queue.length}`);
      }
      await sleep(DELAY_MS);
    }
  }),
);
await save();
const withCodes = Object.values(cache).filter((b) => b.length).length;
console.log(`Штрихкоди Сільпо: готово, у кеші ${Object.keys(cache).length} товарів (зі штрихкодом ${withCodes}), помилок ${failed}`);
