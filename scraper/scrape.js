// Щоденний парсер каталогу atbmarket.com для кількох міст.
// Ціни й асортимент залежать від магазину, тому в кожному місті беремо один магазин
// (з найбільшим асортиментом) і ведемо окрему історію цін.
//
//   node scraper/scrape.js                     — усі міста
//   node scraper/scrape.js --city Хмельницький — лише вказані міста (можна кілька через кому)
//   node scraper/scrape.js --repick            — заново вибрати магазини в містах
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';
import { buildGroupMap, groupOf } from './groups.js';
import { buildCompare } from './compare.js';
import { buildFallback } from './fallback.js';
import { isOut, writeChanges } from './changes.js';

const execFileAsync = promisify(execFile);

const BASE = 'https://www.atbmarket.com';
const DATA_DIR = path.resolve('site/data');
const STORES_FILE = path.resolve('scraper/stores.json');
const SHARDS = 100;
const DELAY_MS = 700;
const PARALLEL_CITIES = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Найбільший розділ — за ним оцінюємо асортимент магазину.
const PROBE_CATEGORY = '/catalog/285-bakaliya';
// Скільки магазинів міста перевіряти під час вибору (рівномірно по списку).
const MAX_PROBE_STORES = 12;
// Скільки днів показувати зниклий товар як «немає в наявності», перш ніж прибрати з каталогу.
const OUT_KEEP_DAYS = 30;
// Скільки сторінок товарів «немає в наявності» перевіряти в місті за один збір.
const OUT_CHECK_LIMIT = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дата за київським часом, щоб нічний запуск не «переїжджав» на інший день.
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------- Історія цін ----------
// Запис історії: [дата, ціна, стара_ціна, немає_в_наявності (1), ціна_з_карткою_АТБ]; порожній хвіст відкидаємо.
function entry(price, oldPrice, out, cardPrice) {
  const e = [today, price, oldPrice ?? null, out ? 1 : 0, cardPrice ?? null];
  while (e.length > 2 && !e.at(-1)) e.pop();
  return e;
}
const sameEntry = (a, b) =>
  !!a &&
  isOut(a) === isOut(b) &&
  (b[1] == null || (a[1] === b[1] && (a[2] ?? null) === (b[2] ?? null) && (a[4] ?? null) === (b[4] ?? null)));
// Записує сьогоднішній стан, якщо він відрізняється від попереднього. Повторний збір того ж дня
// замінює сьогоднішній запис і не дублює вчорашній. Повертає true, якщо історія змінилась.
function record(hist, entry) {
  if (sameEntry(hist.at(-1), entry)) return false;
  if (hist.at(-1)?.[0] === today) hist.pop();
  if (sameEntry(hist.at(-1), entry)) return true;
  // «Немає в наявності» без ціни для товару, якого раніше не було, не записуємо.
  if (hist.length || entry[1] != null) hist.push(entry);
  return true;
}
// З якої дати товару немає в наявності (початок останньої серії out-записів).
function outSince(hist) {
  let i = hist.length - 1;
  while (i > 0 && isOut(hist[i - 1])) i--;
  return hist[i][0];
}
// Поля для карток: коли востаннє змінилась ціна, якою була до того,
// і звичайна ціна перед поточною акцією (щоб виявляти завищену «ціну до знижки»).
function derive(p, hist) {
  const prev = hist.slice(0, -1).findLast((h) => h[1] != null);
  p.changed = hist.at(-1)[0];
  p.prev = prev ? prev[1] : null;
  const regular = p.oldPrice ? hist.findLast((h) => h[1] != null && h[2] == null) : null;
  p.regular = regular ? regular[1] : null;
  p.lowFrom = lowFrom(hist);
  const m = p.oldPrice ? minBeforeSale(hist) : null;
  p.min30 = m?.price ?? null;
  p.min30At = m?.date ?? null; // коли була ця ціна
  p.min30Sale = m?.sale ? 1 : null; // і чи то була акція («повторна акція»)
}

// З якої дати поточна ціна найнижча: відтоді ціна не опускалась нижче, а вищою за цей час була.
// Інакше (ціна не змінювалась чи зараз не найнижча) — null.
function lowFrom(hist) {
  const priced = hist.filter((h) => h[1] != null);
  const cur = priced.at(-1)?.[1];
  if (cur == null) return null;
  let i = priced.length - 1;
  while (i > 0 && priced[i - 1][1] >= cur) i--;
  return priced.slice(i).some((h) => h[1] > cur) ? priced[i][0] : null;
}

// Найнижча ціна за 30 днів перед початком поточної акції (як вимагає закон про знижки в ЄС) —
// для «чесної знижки». Записи історії — сходинки: ціна діє до дати наступного запису.
// Повертає { price, date, sale } — з однакових мінімумів пізніший, а акційний важливіший за звичайний.
function minBeforeSale(hist) {
  let s = hist.length - 1;
  while (s > 0 && (hist[s - 1][2] != null || hist[s - 1][1] == null)) s--;
  const from = Date.parse(hist[s][0]) - 30 * 86400000;
  let best = null;
  for (let j = 0; j < s; j++) {
    const [date, price, old] = hist[j];
    if (price == null || Date.parse(hist[j + 1][0]) <= from) continue;
    if (!best || price < best.price || (price === best.price && (old != null || !best.sale))) best = { price, date, sale: old != null };
  }
  return best;
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// Завантажуємо через curl: вбудований fetch у Node Cloudflare на сайті АТБ відхиляє (403).
async function curl(url, { cookie, jar, form, headers = [] } = {}, attempt = 1) {
  const a = ['-sS', '--compressed', '-A', UA, '-H', 'Accept-Language: uk-UA,uk;q=0.9', '-w', '\n%{http_code}'];
  if (cookie) a.push('-b', cookie);
  if (jar) a.push('-b', jar, '-c', jar);
  for (const h of headers) a.push('-H', h);
  if (form) a.push('--data', new URLSearchParams(form).toString());
  a.push(url);
  try {
    const { stdout } = await execFileAsync('curl', a, { maxBuffer: 50 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1));
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return stdout.slice(0, cut);
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    await sleep(2000 * attempt);
    return curl(url, { cookie, jar, form, headers }, attempt + 1);
  }
}

const storePage = (href, storeId) => curl(BASE + href, { cookie: `nstore_id=${storeId}` });

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------- Міста й магазини ----------

// Розділи верхнього рівня. «Акція 7 днів» потрібна: лише в ній є непродовольчі
// підрозділи (іграшки, посуд, одяг…). Підрозділи окремо не обходимо — вони дублюють батьківські.
function parseCategories($) {
  const hrefs = new Set();
  $('a.category-menu__link-wrap').each((_, a) => {
    const href = $(a).attr('href');
    if (href?.startsWith('/catalog/') && href !== '/catalog/economy' && href !== '/catalog/novetly') hrefs.add(href);
  });
  return [...hrefs];
}

function parseCityIds($) {
  const ids = new Map();
  $('#city option').each((_, o) => {
    const name = $(o).text().trim();
    if (name && $(o).attr('value')) ids.set(name, $(o).attr('value'));
  });
  return ids;
}

async function getCityStores(cityId, session) {
  const res = JSON.parse(
    await curl(BASE + '/site/getstore', {
      jar: session.jar,
      form: { city: cityId, '_csrf-shop': session.csrf },
      headers: [`X-CSRF-Token: ${session.csrf}`, 'X-Requested-With: XMLHttpRequest'],
    }),
  );
  const $ = cheerio.load(res.optselect || '');
  return $('option')
    .map((_, o) => ({ id: Number($(o).attr('value')), address: $(o).text().trim() }))
    .get()
    .filter((s) => s.id);
}

// Оцінка асортименту магазину: кількість товарів у найбільшому розділі.
async function probeStore(storeId) {
  const first = cheerio.load(await storePage(PROBE_CATEGORY, storeId));
  await sleep(DELAY_MS);
  const last = lastPageOf(first) || 1;
  if (last === 1) return first('article.catalog-item').length;
  const $ = cheerio.load(await storePage(`${PROBE_CATEGORY}?page=${last}`, storeId));
  await sleep(DELAY_MS);
  return (last - 1) * 36 + $('article.catalog-item').length;
}

async function pickStore(city, cityId, session) {
  const stores = await getCityStores(cityId, session);
  await sleep(DELAY_MS);
  if (!stores.length) throw new Error('у місті немає магазинів');
  const step = Math.max(1, Math.floor(stores.length / MAX_PROBE_STORES));
  const candidates = stores.filter((_, i) => i % step === 0).slice(0, MAX_PROBE_STORES);
  let best = null;
  for (const s of candidates) {
    const score = await probeStore(s.id);
    if (!best || score > best.score) best = { ...s, score };
  }
  console.log(`[${city.name}] вибрано магазин ${best.id} (${best.address}), у «Бакалії» ${best.score} товарів; перевірено ${candidates.length} з ${stores.length}`);
  return { id: best.id, address: best.address, cityId: Number(cityId) };
}

// ---------- Каталог ----------

function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('article.catalog-item').each((_, el) => {
    const card = $(el);
    const cart = card.find('.b-addToCart');
    const id = cart.attr('data-productid');
    const link = card.find('.catalog-item__title a');
    const price = num(card.find('.product-price__top').attr('value'));
    if (!id || !price) return;
    const labels = parseLabels($, card.find('.catalog-item__labels > .custom-product-label'));
    items.push({
      id: Number(id),
      name: link.text().trim().replace(/\s+/g, ' '),
      url: link.attr('href'),
      img: card.find('img.catalog-item__img').attr('src') || null,
      price,
      oldPrice: num(card.find('.product-price__bottom').attr('value')),
      // Ціна при оплаті карткою АТБ (фільтр «З карткою АТБ» на сайті; зазвичай −5%).
      cardPrice: num(card.find('.atbcard-sale__price-top').attr('value')),
      unit: card.find('.product-price__unit').first().text().replace('/', '').trim() || 'шт',
      category: cart.attr('data-category') || null,
      brand: cart.attr('data-brand') || null,
      labels,
    });
  });
  // Магазин, для якого сайт віддав сторінку (атрибут форми фільтрів), — щоб переконатися, що cookie спрацювала.
  const store = Number($('form.catalog-filter[data-store]').first().attr('data-store')) || null;
  return { items, store, lastPage: lastPageOf($) };
}

// Номер останньої сторінки з пагінації («1 2 3 4 5 6 … 11»); null — якщо пагінації немає.
function lastPageOf($) {
  const pages = $('.product-pagination__link')
    .map((_, a) => Number(($(a).attr('href') || '').match(/page=(\d+)/)?.[1] || 1))
    .get();
  return pages.length ? Math.max(...pages) : null;
}

// Мітки товару: знижка («-20% до 27.10») і рекламні кампанії («DC» з підказкою «Безмежний всесвіт DC»).
function parseLabels($, els) {
  return els
    .map((_, l) => {
      const el = $(l);
      const text = el.text().trim().replace(/\s+/g, ' ');
      const hint = (el.attr('data-tippy-content') || '').trim();
      // Підказку до знижки («Акційна пропозиція!…») не зберігаємо — вона однакова в усіх.
      return hint && !/^Акційна пропозиція/.test(hint) ? { text, hint } : { text };
    })
    .get()
    .filter((l) => l.text);
}

// Сторінка товару показує ціну магазину (з cookie) навіть тоді, коли товару немає в наявності.
async function productPage(href, storeId) {
  const $ = cheerio.load(await storePage(href, storeId));
  const box = $('.product-about__price').first();
  const read = (sel) => num(box.find(sel).children('span').first().text().trim());
  const price = read('.product-price__top');
  if (!price) return null;
  return {
    price,
    oldPrice: read('.product-price__bottom'),
    cardPrice: num($('.product-about .atbcard-sale__price-top').first().attr('value')),
    labels: parseLabels($, $('.product-about__labels').first().find('.custom-product-label')),
  };
}

async function scrapeCategory(href, storeId, products) {
  const seenHere = new Set();
  let last = 499;
  for (let page = 1; page <= last; page++) {
    const html = await storePage(`${href}${page > 1 ? `?page=${page}` : ''}`, storeId);
    await sleep(DELAY_MS);
    const { items, store, lastPage } = parseCards(html);
    if (!store) throw new Error(`${href}: на сторінці не знайдено номер магазину — змінилась розмітка сайту?`);
    if (store !== storeId) throw new Error(`сайт віддав магазин ${store} замість ${storeId}`);
    // Скільки сторінок — видно з пагінації першої сторінки; без неї розділ має одну сторінку.
    if (page === 1) last = lastPage || 1;
    // Про всяк випадок: сторінки після останньої повторюють останню.
    const fresh = items.filter((c) => !seenHere.has(c.id));
    if (!fresh.length) break;
    for (const c of fresh) {
      seenHere.add(c.id);
      if (!products.has(c.id)) products.set(c.id, c);
    }
  }
}

async function scrapeCity(city, store, categories, groupMap) {
  const started = Date.now();
  const dir = path.join(DATA_DIR, 'cities', city.slug);
  const historyDir = path.join(dir, 'history');
  const products = new Map();
  for (const href of categories) await scrapeCategory(href, store.id, products);

  const meta = await readJson(path.join(dir, 'meta.json'), { productCount: 0 });
  // Захист від часткового збою: не позначаємо товари зниклими, якщо зібрали підозріло мало.
  const fullScrape = products.size >= meta.productCount * 0.9;
  if (!fullScrape) console.warn(`[${city.name}] увага: зібрано ${products.size} проти ${meta.productCount} минулого разу`);

  // Історія — лише зміни:
  //   [дата, ціна] або [дата, ціна, стара_ціна] — у наявності;
  //   [дата, ціна, стара_ціна | null, 1]        — немає в наявності, ціну взято зі сторінки товару;
  //   [дата, null]                               — немає в наявності, ціна невідома.
  await fs.mkdir(historyDir, { recursive: true });
  const shards = [];
  for (let i = 0; i < SHARDS; i++) {
    shards.push(await readJson(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), {}));
  }
  // Учорашній каталог: звідти назви, посилання й останній стан товарів, яких сьогодні немає.
  const oldList = await readJson(path.join(dir, 'products.json'), []);
  const known = new Map(oldList.map((p) => [p.id, p]));

  let changed = 0;
  for (const p of products.values()) {
    p.group = groupOf(p.category, groupMap);
    const hist = (shards[p.id % SHARDS][p.id] ||= []);
    if (record(hist, entry(p.price, p.oldPrice, false, p.cardPrice))) changed++;
    derive(p, hist);
  }

  const out = [];
  let checked = 0;
  if (fullScrape) {
    // Товари, яких сьогодні немає: якщо зникли недавно — лишаються в каталозі з позначкою out.
    const missing = [];
    for (const shard of shards) {
      for (const [key, hist] of Object.entries(shard)) {
        const id = Number(key);
        if (products.has(id)) continue;
        const since = isOut(hist.at(-1)) ? outSince(hist) : today;
        if (daysBetween(since, today) > OUT_KEEP_DAYS) continue;
        missing.push({ id, hist, shard, base: known.get(id) });
      }
    }
    // Ціну перевіряємо на сторінці товару: спершу щойно зниклі, далі ті, що найдовше не перевірялись.
    const queue = missing
      .filter((m) => m.base?.url)
      .sort((a, b) => (a.base.checked || '').localeCompare(b.base.checked || ''))
      .slice(0, OUT_CHECK_LIMIT);
    const pages = new Map();
    for (const m of queue) {
      try {
        const page = await productPage(m.base.url, store.id);
        if (page) pages.set(m.id, page);
      } catch (err) {
        console.warn(`[${city.name}] сторінка товару ${m.id}: ${err.message}`);
      }
      checked++;
      await sleep(DELAY_MS);
    }
    for (const { id, hist, shard, base } of missing) {
      const page = pages.get(id);
      if (page && record(hist, entry(page.price, page.oldPrice, true, page.cardPrice))) changed++;
      if (!page) record(hist, [today, null]);
      if (!hist.length) {
        delete shard[id]; // з'явився й зник того самого дня
        continue;
      }
      if (!base) continue;
      const item = { ...base, out: outSince(hist) };
      if (page) {
        // Мітки акції беремо зі сторінки, лише якщо ціна змінилась — у каталозі вони детальніші («-20% до 27.10»).
        const moved = page.price !== base.price || page.oldPrice !== (base.oldPrice ?? null);
        Object.assign(item, { price: page.price, oldPrice: page.oldPrice, cardPrice: page.cardPrice, checked: today }, moved ? { labels: page.labels } : {});
      }
      derive(item, hist);
      out.push(item);
    }
  } else {
    // Неповний збір: зниклими нікого не позначаємо, а вчорашні «немає в наявності» лишаємо як були.
    out.push(...oldList.filter((p) => p.out && !products.has(p.id)));
  }
  for (let i = 0; i < SHARDS; i++) {
    await fs.writeFile(path.join(historyDir, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
  }
  await writeChanges(dir, shards, products, today, oldList);

  const list = [...products.values(), ...out].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  await fs.writeFile(path.join(dir, 'products.json'), JSON.stringify(list));
  const cityMeta = { updated: today, updatedAt: new Date().toISOString(), productCount: products.size, outCount: out.length, store };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(cityMeta, null, 2));
  console.log(
    `[${city.name}] ${products.size} товарів (+${out.length} немає в наявності, перевірено ${checked}), змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`,
  );
  return cityMeta;
}

// ---------- Головне ----------

async function main() {
  const started = Date.now();
  const only = argValue('--city')?.split(',').map((s) => s.trim());
  // --half 1 / --half 2 — перша чи друга половина списку міст (збираються в різний час, див. scripts/daily.ps1).
  const half = Number(argValue('--half')) || 0;
  const mid = Math.ceil(CITIES.length / 2);
  const pool = half === 1 ? CITIES.slice(0, mid) : half === 2 ? CITIES.slice(mid) : CITIES;
  const cities = only ? pool.filter((c) => only.includes(c.name) || only.includes(c.slug)) : pool;
  if (!cities.length) throw new Error(`Невідоме місто: ${only}`);

  // Сесія потрібна для запиту списку магазинів (CSRF-токен + cookie).
  const jar = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'atb-')), 'cookies.txt');
  const home = await curl(BASE + '/', { jar });
  const $ = cheerio.load(home);
  const session = { jar, csrf: $('meta[name="csrf-token"]').attr('content') };
  const categories = parseCategories($);
  const cityIds = parseCityIds($);
  const groupMap = buildGroupMap($);
  console.log(`Розділів: ${categories.length}, міст на сайті: ${cityIds.size}`);

  const stores = await readJson(STORES_FILE, {});
  for (const city of cities) {
    if (stores[city.slug] && !args.includes('--repick')) continue;
    const cityId = cityIds.get(city.name);
    if (!cityId) {
      console.warn(`[${city.name}] немає у списку міст АТБ — пропускаю`);
      continue;
    }
    try {
      stores[city.slug] = await pickStore(city, cityId, session);
      await fs.writeFile(STORES_FILE, JSON.stringify(stores, null, 2) + '\n');
    } catch (err) {
      console.error(`[${city.name}] не вдалося вибрати магазин: ${err.message}`);
    }
  }

  // Міста обробляємо по PARALLEL_CITIES одночасно.
  const queue = cities.filter((c) => stores[c.slug]);
  const results = {};
  const failed = [];
  await Promise.all(
    Array.from({ length: PARALLEL_CITIES }, async () => {
      for (let city; (city = queue.shift()); ) {
        try {
          results[city.slug] = await scrapeCity(city, stores[city.slug], categories, groupMap);
        } catch (err) {
          failed.push(city.name);
          console.error(`[${city.name}] ПОМИЛКА: ${err.message}`);
        }
      }
    }),
  );

  // Список міст для сайту: беремо всі міста, для яких уже є дані.
  const index = [];
  for (const city of CITIES) {
    const meta = results[city.slug] || (await readJson(path.join(DATA_DIR, 'cities', city.slug, 'meta.json'), null));
    if (meta) index.push({ slug: city.slug, name: city.name, lat: city.lat, lon: city.lon, address: meta.store.address, productCount: meta.productCount, updated: meta.updated });
  }
  await fs.writeFile(path.join(DATA_DIR, 'cities.json'), JSON.stringify(index, null, 2));
  await buildCompare(DATA_DIR);
  await buildFallback(DATA_DIR);

  console.log(`Готово за ${Math.round((Date.now() - started) / 60000)} хв: міст ${Object.keys(results).length}, з помилками ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
  if (!Object.keys(results).length) process.exit(1);
}

// Для одноразових знімків (scraper/snapshot.js) — ті самі запити й розбір сторінок.
export { BASE, curl, sleep, DELAY_MS, parseCategories, parseCityIds, getCityStores, scrapeCategory, entry, record, derive, today };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
