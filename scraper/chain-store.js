// Спільне збереження каталогу мережі (Сільпо, мережі zakaz.ua, Фора, Грош) у тому самому форматі, що й АТБ:
//   site/data/chains/<мережа>/<місто>/products.json, meta.json, changes.json, history/NN.json
//   site/data/chains/<мережа>/cities.json — [{ slug, address }]: міста, де є каталог мережі
// Для мереж без поділу за містами (ціни однакові всюди) — та сама структура в site/data/chains/<мережа>/ (без <місто>).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CITIES } from './cities.js';
import { entry, record, derive } from './scrape.js';
import { writeChanges } from './changes.js';

const SHARDS = 100;
export const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const readJson = (file, fallback) => fs.readFile(file, 'utf8').then(JSON.parse, () => fallback);
export const chainDir = (chain, slug) => path.resolve('site/data/chains', chain, ...(slug ? [slug] : []));
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Запит з повтором при 429/5xx і обривах мережі.
// На 429 («забагато запитів») чекаємо довго — 30 с, 1, 2, 4, 8 хв (або скільки просить Retry-After).
export async function fetchJson(url, init = {}, attempt = 1) {
  let wait = 4000 * attempt;
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers } });
    if (res.ok) return await res.json();
    if (res.status === 429) wait = Math.max(Number(res.headers.get('retry-after')) * 1000 || 0, 30000 * 2 ** (attempt - 1));
    if (attempt < 6 && (res.status === 429 || res.status >= 500)) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
    throw new Error(`HTTP ${res.status} ${url}`);
  } catch (err) {
    if (attempt < 6 && (err.retry || err.name === 'TypeError')) {
      await sleep(wait);
      return fetchJson(url, init, attempt + 1);
    }
    throw err;
  }
}

// Стислий запис товару в products.json (GitHub Pages обмежує сайт 1 ГБ): без поля chain (мережа — за діапазоном id)
// і без спільних початків адрес фото й посилань — сайт дописує їх сам (EXPAND у site/app.js; префікси — ті самі).
export const PREFIX = {
  img: { fora: 'https://content.fora.ua/sku/ecommerce/', grosh: 'https://d3og57k1dk4307.cloudfront.net/grosh/', zakaz: 'https://img2.zakaz.ua/' },
  url: { fora: '/product/', zakaz: '/uk/products/' },
};
const ZAKAZ = new Set(['metro', 'auchan', 'novus', 'tavriav', 'megamarket', 'ekomarket']);
export function compact(p) {
  const key = ZAKAZ.has(p.chain) ? 'zakaz' : p.chain;
  const q = { ...p };
  delete q.chain;
  const img = PREFIX.img[key];
  if (img && q.img) q.img = q.img.replace(/^https:\/\/img\d\.zakaz\.ua\//, 'https://img2.zakaz.ua/').replace(img, '');
  const url = PREFIX.url[key];
  if (url && q.url?.startsWith(url)) q.url = q.url.slice(url.length);
  return q;
}

// products — Map id → { id, chain, name, url, img, price, oldPrice?, unit, category, brand, group }.
// Пише історію (запис ціни на сьогодні), зміни за день, products.json і meta.json. Повертає кількість змін цін.
export async function saveCatalog(chain, slug, products, store) {
  const dir = chainDir(chain, slug);
  const historyDir = path.join(dir, 'history');
  await fs.mkdir(historyDir, { recursive: true });
  const shardFile = (i) => path.join(historyDir, `${String(i).padStart(2, '0')}.json`);
  const shards = [];
  for (let i = 0; i < SHARDS; i++) shards.push(await readJson(shardFile(i), {}));
  let changed = 0;
  for (const p of products.values()) {
    const hist = (shards[p.id % SHARDS][p.id] ||= []);
    if (record(hist, entry(p.price, p.oldPrice ?? null, false, null))) changed++;
    derive(p, hist);
    for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  }
  for (let i = 0; i < SHARDS; i++) await fs.writeFile(shardFile(i), JSON.stringify(shards[i]));
  await writeChanges(dir, shards, products, today, await readJson(path.join(dir, 'products.json'), []));
  const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  await fs.writeFile(path.join(dir, 'products.json'), JSON.stringify(list.map(compact)));
  const meta = { updated: today, updatedAt: new Date().toISOString(), productCount: list.length, store };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return changed;
}

// cities.json мережі — наші міста, для яких є meta.json (у порядку CITIES).
export async function writeCities(chain) {
  const cities = [];
  for (const c of CITIES) {
    const meta = await readJson(path.join(chainDir(chain, c.slug), 'meta.json'), null);
    if (meta) cities.push({ slug: c.slug, address: meta.store.address });
  }
  await fs.mkdir(chainDir(chain), { recursive: true });
  await fs.writeFile(path.join(chainDir(chain), 'cities.json'), JSON.stringify(cities));
  return cities;
}

// Наш розділ товару за назвами категорій мережі (верхньої й нижчих) — ключові слова, перше збігання.
// Спершу точніші правила (ковбаса раніше за м'ясо, дитяче харчування раніше за дитячі товари).
const GROUP_RULES = [
  [/дитяч\S* харчуван|пюре дитяч|дитяч\S* сумiш|дитяч\S* суміш|дитяч\S* каш/i, 'Дитяче харчування'],
  [/ковбас|сосиск|сардел|делікатес|м'ясні вироби|м’ясні вироби|шинк|бекон/i, "Ковбаса і м'ясні делікатеси"],
  [/м'яс|м’яс|птиц|фарш/i, "М'ясо"],
  [/риб|морепродукт|ікр/i, 'Риба і морепродукти'],
  [/овоч|фрукт|ягод|зелен|гриби свіж|соління/i, 'Овочі та фрукти'],
  [/молоч|сир(и|\b)|яйц|йогурт|кефір|масло вершк/i, 'Молочні продукти та яйця'],
  [/хліб|пекарн|випічк|випечк/i, 'Хлібобулочні вироби'],
  [/кулінар|готов\S* їж|готові страви/i, 'Кулінарія'],
  [/заморож|замороз|морозиво/i, 'Заморожені продукти'],
  [/(?<!без)алкогол|^вин|пиво|горілк|коньяк|віскі/i, 'Алкоголь'],
  [/сигарет|цигарк|тютю|стіки|жуйк/i, 'Тютюнові вироби'],
  [/кав|чай|гаряч\S* напо/i, 'Кава, чай'],
  [/напо|вод|сок/i, 'Напої безалкогольні'],
  [/снек|чипс|горіх|сухарик/i, 'Чипси, снеки'],
  [/солодощ|кондитер|цукерк|шоколад|печиво/i, 'Кондитерські вироби'],
  [/бакал|консерв|соус|спеці|круп|макарон|олія|борошн|здоров|дієт|спортивн\S* харч|товари світу|гурман/i, 'Бакалія'],
  [/тварин|зоо/i, 'Товари для тварин'],
  [/дит|іграш|мам/i, 'Товари для дітей'],
  [/гігієн|догляд|краса|космет/i, 'Гігієна і косметика'],
  [/побутова хімія|прання|миюч|чищ/i, 'Побутова хімія та непродовольчі товари'],
  [/канцеляр/i, 'Канцелярські товари'],
  [/одяг|взутт|хобі|відпочин|сад|город|квіти|подарунк|декор|свят|випадки життя/i, 'Дім, одяг і дозвілля'],
  [/дім|дому|кухн|посуд|техн|інтер'єр|інтер’єр|текстил/i, 'Товари для дому'],
];
// top — розділ верхнього рівня мережі, sub — підрозділ. Розділ визначаємо за верхнім рівнем; підрозділ — лише щоб
// розвести «М'ясо та ковбасні вироби» і «Товари для дітей» (дитяче харчування), або коли верхній рівень нічого не дав.
const ruleOf = (t) => (t ? GROUP_RULES.find(([re]) => re.test(t))?.[1] : null);
export const groupOf = (top, sub) => {
  if (/м'яс|м’яс/i.test(top || '') && /ковбас/i.test(top) && sub) return /ковбас|сосиск|сардел|делікатес|вироби/i.test(sub) ? "Ковбаса і м'ясні делікатеси" : "М'ясо";
  if (/дит/i.test(top || '') && /харчуван/i.test(sub || '')) return 'Дитяче харчування';
  return ruleOf(top) || ruleOf(sub) || 'Інше';
};
