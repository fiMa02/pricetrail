// Ціни одного товару в усіх містах — для порівняння на сторінці товару.
// site/data/compare/NN.json (розбито за id % 100): { id: { місто: ціна | [ціна, ціна_до_знижки] } }.
// site/data/compare/index.json — загальна різниця цін між містами (для мапи на головній):
//   { cities: [slug…], d: [[%…]…], n: [[кількість…]…] } — d[i][j]: на скільки % у місті i дорожче, ніж у j,
//   за спільними товарами (середнє геометричне співвідношення поточних цін); n[i][j] — скільки спільних товарів;
//   avg[i] — на скільки % у місті i дорожче за середній рівень цін по всіх містах (не залежить від вибраного міста).
//
//   node scraper/compare.js — перебудувати з наявних products.json (парсер робить це сам після збору)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';

const SHARDS = 100;

export async function buildCompare(dataDir) {
  const shards = Array.from({ length: SHARDS }, () => ({}));
  const prices = new Map(); // місто → Map(id → ціна)
  for (const city of CITIES) {
    let products;
    let updated;
    try {
      products = JSON.parse(await fs.readFile(path.join(dataDir, 'cities', city.slug, 'products.json'), 'utf8'));
      ({ updated } = JSON.parse(await fs.readFile(path.join(dataDir, 'cities', city.slug, 'meta.json'), 'utf8')));
    } catch {
      continue;
    }
    for (const p of products) {
      // Товар поза каталогом — лише якщо його ціну звірили зі сторінки товару в останньому зборі.
      if (p.out && p.checked !== updated) continue;
      const shard = shards[p.id % SHARDS];
      (shard[p.id] ||= {})[city.slug] = p.oldPrice ? [p.price, p.oldPrice] : p.price;
      if (!prices.has(city.slug)) prices.set(city.slug, new Map());
      prices.get(city.slug).set(p.id, p.price);
    }
  }
  const dir = path.join(dataDir, 'compare');
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < SHARDS; i++) {
    await fs.writeFile(path.join(dir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(priceIndex(prices)));
}

function priceIndex(prices) {
  const cities = [...prices.keys()];
  const logs = cities.map((c) => new Map([...prices.get(c)].map(([id, v]) => [id, Math.log(v)])));
  const d = cities.map(() => []);
  const n = cities.map(() => []);
  const g = cities.map(() => []); // логарифм співвідношення цін
  for (let i = 0; i < cities.length; i++) {
    d[i][i] = 0;
    n[i][i] = logs[i].size;
    for (let j = i + 1; j < cities.length; j++) {
      let sum = 0;
      let k = 0;
      for (const [id, a] of logs[i]) {
        const b = logs[j].get(id);
        if (b == null) continue;
        sum += a - b;
        k++;
      }
      const v = k ? sum / k : 0;
      g[i][j] = v;
      g[j][i] = -v;
      d[i][j] = Math.round((Math.exp(v) - 1) * 1000) / 10;
      d[j][i] = Math.round((Math.exp(-v) - 1) * 1000) / 10;
      n[i][j] = n[j][i] = k;
    }
  }
  // Рівень цін міста: середня різниця з усіма іншими містами (вага — кількість спільних товарів),
  // зсунута так, щоб середнє по містах було 0.
  const level = cities.map((_, i) => {
    let sum = 0;
    let w = 0;
    for (let j = 0; j < cities.length; j++) {
      if (j === i || n[i][j] < 300) continue;
      sum += g[i][j] * n[i][j];
      w += n[i][j];
    }
    return w ? sum / w : 0;
  });
  const mean = level.reduce((a, b) => a + b, 0) / level.length;
  const avg = level.map((l) => Math.round((Math.exp(l - mean) - 1) * 1000) / 10);
  return { cities, d, n, avg };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildCompare(path.resolve('site/data'));
  console.log('Порівняння міст оновлено.');
}
