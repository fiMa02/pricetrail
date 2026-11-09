// ТЕСТ: знімок рівня цін у всіх містах Сільпо — для мапи «Рівень цін у містах» на головній (перемикач «Сільпо»).
// Так само, як scraper/snapshot.js для АТБ: у кожному місті — один магазин (з найбільшим асортиментом серед
// найближчих до центру) і ті самі розділи-вибірка: молочні продукти, напої, хліб, ковбаси, кава й чай, побутова хімія.
//
//   node scraper/silpo-snapshot.js --fresh   — зібрати все заново і порахувати
//   node scraper/silpo-snapshot.js           — продовжити перерваний збір і порахувати
//   node scraper/silpo-snapshot.js --build   — лише перерахувати з зібраного
//
// Сирі ціни — у .scratch/silpo-snapshot/<branchId>.json; результат — site/data/chains/silpo/levels.json:
//   { date, cities: [{ name, slug?, lat, lon, v, n }] } — v: на скільки % дорожче за середнє, n: товарів у вибірці;
//   slug — для наших міст (щоб виділити вибране місто).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';

const API = 'https://sf-ecom-api.silpo.ua/v1/uk';
const RAW_DIR = path.resolve('.scratch/silpo-snapshot');
const OUT = path.resolve('site/data/chains/silpo/levels.json');
const DELAY_MS = 500;
const PARALLEL = 3;
const PAGE = 100;
const SAMPLE = [
  'molochni-produkty-ta-iaitsia-234',
  'napoi-52',
  'khlib-ta-vypichka-5121',
  'kovbasni-vyroby-i-m-iasni-delikatesy-4731',
  'kava-chai-359',
  'pobutova-khimiia-4588',
];
const PROBE_MIN = 100; // менше молочних товарів у наявності — магазин міста не беремо
const MIN_COMMON = 150; // пари міст з меншою кількістю спільних товарів не враховуємо
// Наші міста — з тих самих магазинів, що й щоденний збір (scraper/silpo.js).
const STORES_FILE = path.resolve('scraper/silpo-stores.json');
// «Прип'ять» у списку магазинів — пункт у зоні відчуження з кількома сотнями товарів; на мапі він лише заважає.
const EXCLUDE = new Set(["Прип'ять"]);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const key = (s) => s.toLowerCase().replace(/[’'ʼ`]/g, '');
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
const productsUrl = (branchId, category, offset, limit = PAGE) =>
  `${API}/branches/${branchId}/products?limit=${limit}&offset=${offset}&deliveryType=DeliveryHome&category=${category}&includeChildCategories=true&inStock=true`;

async function collect(fresh) {
  if (fresh) await fs.rm(RAW_DIR, { recursive: true, force: true });
  await fs.mkdir(RAW_DIR, { recursive: true });
  const ours = new Map(CITIES.map((c) => [key(c.name), c]));
  const ourStores = JSON.parse(await fs.readFile(STORES_FILE, 'utf8').catch(() => '{}'));
  // Міста — за назвою в списку магазинів; центр міста — наше місто з cities.js або середнє координат його магазинів.
  const byCity = new Map();
  for (const b of (await get(`${API}/branches`)).items) {
    if (!b.cityFull || !b.latitude || EXCLUDE.has(b.cityFull)) continue;
    if (!byCity.has(b.cityFull)) byCity.set(b.cityFull, []);
    byCity.get(b.cityFull).push({ ...b, lat: +b.latitude, lon: +b.longitude });
  }
  const done = new Set((await fs.readdir(RAW_DIR)).map((f) => f.replace('.json', '')));
  const queue = [...byCity].filter(([name]) => !done.has(key(name)));
  console.log(`До збору: ${queue.length} міст (уже зібрано ${done.size})`);
  const started = Date.now();
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let item; (item = queue.shift()); ) {
        const [name, list] = item;
        try {
          const our = ours.get(key(name));
          const center = our || { lat: list.reduce((a, b) => a + b.lat, 0) / list.length, lon: list.reduce((a, b) => a + b.lon, 0) / list.length };
          // Серед 8 найближчих до центру — з найбільшим асортиментом у наявності; з майже рівних (від 85%) — ближчий.
          // У наших містах — магазин щоденного збору.
          const fixed = our && ourStores[our.slug] && list.find((b) => b.branchId === ourStores[our.slug].branchId);
          const near = fixed ? [fixed] : [...list].sort((x, y) => km(center, x) - km(center, y)).slice(0, 8);
          for (const b of near) {
            b.n = (await get(productsUrl(b.branchId, SAMPLE[0], 0, 1))).total;
            await sleep(DELAY_MS);
          }
          const best = Math.max(0, ...near.map((b) => b.n));
          if (best < PROBE_MIN) {
            console.warn(`[${name}] немає магазину з достатнім асортиментом у наявності`);
            continue;
          }
          const store = near.find((b) => b.n >= best * 0.85);
          const prices = {};
          for (const cat of SAMPLE) {
            for (let offset = 0; ; offset += PAGE) {
              const j = await get(productsUrl(store.branchId, cat, offset));
              for (const x of j.items) if (x.price > 0) prices[x.externalProductId] = x.price;
              await sleep(DELAY_MS);
              if (offset + PAGE >= j.total) break;
            }
          }
          const at = our ? { lat: our.lat, lon: our.lon } : { lat: store.lat, lon: store.lon };
          await fs.writeFile(
            path.join(RAW_DIR, `${key(name)}.json`),
            JSON.stringify({ name, ...(our ? { slug: our.slug } : {}), ...at, store: { id: store.branchId, address: store.addressFull }, prices }),
          );
          console.log(`[${name}] ${Object.keys(prices).length} товарів · ${queue.length} лишилось, ${Math.round((Date.now() - started) / 60000)} хв`);
        } catch (err) {
          console.error(`[${name}] ПОМИЛКА: ${err.message}`);
        }
      }
    }),
  );
}

async function build() {
  const cities = [];
  for (const f of await fs.readdir(RAW_DIR).catch(() => [])) {
    const raw = JSON.parse(await fs.readFile(path.join(RAW_DIR, f), 'utf8'));
    if (EXCLUDE.has(raw.name)) continue;
    cities.push({ ...raw, logs: new Map(Object.entries(raw.prices).map(([id, v]) => [id, Math.log(v)])) });
  }
  // Попарні середні логарифми співвідношення цін за спільними товарами → рівень міста (вага — кількість спільних).
  const level = cities.map(({ logs }, i) => {
    let sum = 0;
    let w = 0;
    for (let j = 0; j < cities.length; j++) {
      if (j === i) continue;
      let s = 0;
      let k = 0;
      for (const [id, a] of logs) {
        const b = cities[j].logs.get(id);
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
    .map(
      (c, i) =>
        level[i] != null && { name: c.name, ...(c.slug ? { slug: c.slug } : {}), lat: c.lat, lon: c.lon, v: Math.round((Math.exp(level[i] - mean) - 1) * 1000) / 10, n: c.logs.size },
    )
    .filter(Boolean);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ date: today, cities: out }));
  console.log(`levels.json: ${out.length} міст, від ${Math.min(...out.map((x) => x.v))}% до ${Math.max(...out.map((x) => x.v))}%`);
}

const args = process.argv.slice(2);
if (!args.includes('--build')) await collect(args.includes('--fresh'));
await build();
