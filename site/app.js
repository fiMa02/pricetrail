const PAGE = 48;
const SHARDS = 100;
const DAY = 86400000;

const $ = (sel) => document.querySelector(sel);
// Сортування живе над сіткою результатів (рядок «Знайдено»), тож з DOM воно то зникає, то повертається — тримаємо посилання.
const sortEl = document.getElementById('sort');
const app = $('#app');
const state = { cities: [], chainCities: {}, chain: 'atb', city: null, chains: ['atb'], thrash: [], all: [], products: [], byId: new Map(), meta: null, shown: PAGE, shards: new Map() };

const fmtPrice = (v) => v.toFixed(2).replace('.', ',');
const parseDate = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmtDate = (t, withYear = true) => {
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return withYear ? `${dd}.${mm}.${d.getUTCFullYear()}` : `${dd}.${mm}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// У назвах АТБ трапляються латинські двійники в кириличних словах («Снідaнок», «Днiпромлин») і навпаки:
// зводимо змішане слово до тієї абетки, в яку перекладаються всі «чужі» літери (спершу пробуємо кирилицю).
const TO_CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const TO_LAT = Object.fromEntries(Object.entries(TO_CYR).map(([l, c]) => [c, l]));
const unmix = (w) => {
  if (!/[а-яіїєґ]/.test(w) || !/[a-z]/.test(w)) return w;
  if (/^[^a-z]*$/.test(w.replace(/[abcehikmoptxy]/g, ''))) return w.replace(/[a-z]/g, (c) => TO_CYR[c]);
  if (/^[^а-яіїєґ]*$/.test(w.replace(/[авсенікмортху]/g, ''))) return w.replace(/[авсенікмортху]/g, (c) => TO_LAT[c]);
  return w;
};
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[’'`ʼ]/g, '').replace(/[^\s]+/g, unmix);
const discount = (p) => (p.oldPrice ? 1 - p.price / p.oldPrice : 0);
// «Найнижча ціна за N днів»: скільки днів ціна не опускалась нижче поточної (lowFrom рахує парсер); показуємо від тижня.
const LOW_MIN_DAYS = 7;
const lowDays = (p) => (p.lowFrom ? Math.round((parseDate(state.meta.updated) - parseDate(p.lowFrom)) / DAY) : 0);
// Чесна знижка — відносно найнижчої ціни за 30 днів до акції (min30), а не «ціни до знижки».
const honestPct = (p) => (p.oldPrice && p.min30 ? pct(p.price, p.min30) : null);
const dishonest = (p) => honestPct(p) != null && honestPct(p) < Math.round(discount(p) * 100) - 2;
const dayMonth = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
// Позначка на картці, коли знижка менша за заявлену: мінімум був на попередній акції — «повторна акція»,
// звичайною ціною — реальна знижка, а якщо ціна не нижча за мінімум — так і кажемо.
function honestTag(p) {
  const h = honestPct(p);
  const title = `Найнижча ціна за 30 днів до акції — ${fmtPrice(p.min30)} грн${p.min30At ? ` (${fmtDate(parseDate(p.min30At))}${p.min30Sale ? ', на акції' : ''})` : ''}`;
  const text = p.min30Sale
    ? `<span>🔁 повторна акція:</span> <span>було ${fmtPrice(p.min30)}${p.min30At ? ` (${dayMonth(p.min30At)})` : ''}</span>`
    : h > 0
      ? `⚠ реальна знижка −${h}%`
      : '⚠ не дешевше, ніж до акції';
  return `<span class="tag tag--warn tag--wrap" title="${title}">${text}</span>`;
}
const lowTag = (p) =>
  lowDays(p) >= LOW_MIN_DAYS
    ? `<span class="tag tag--low" title="Нижчої ціни не було з ${fmtDate(parseDate(p.lowFrom))}">★ найнижча за ${lowDays(p)} дн.</span>`
    : '';
const inflation = (p) => (isInflated(p.oldPrice, p.regular) ? p.oldPrice / p.regular - 1 : 0);

// ---------- Ціна за кг / л / шт ----------
// Кількість беремо з назви: «0,5 кг», «170мл», «4х115 г», «(76 ф/п х 2г)», «200+100 мл», «30 шт».
const QTY_UNIT = { кг: ['кг', 1], г: ['кг', 1e-3], гр: ['кг', 1e-3], л: ['л', 1], мл: ['л', 1e-3] };
const QTY_MULTI = /(\d+|\(\d+\+\d+\))\s*(?:ф\/п|пак\.?|шт\.?|капс\.?)?\s*[хx*]\s*(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
// «18г x 10 шт», «200 мл х 2» — вага першою, далі кількість (без одиниці виміру або «шт»/«пак»).
const QTY_MULTI_REV = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)\s*[хx*]\s*(\d+)(?![\d.,])(?!\s*(?:кг|гр|г|мл|л|см|мм|м)(?![а-яіїєґa-z]))/i;
// «200+100 мл», «140 г+15 г», «350г + 100г» — акційна упаковка з бонусом.
const QTY_SUM = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)?\s*\+\s*(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
const QTY_ONE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л)(?![а-яіїєґa-z])/i;
const QTY_PCS = /(?<![\d.,])(\d+)\s*шт(?![а-яіїєґa-z])/i;
const QTY_PCS_SUM = /(?<![\d.,])(\d+)\s*\+\s*(\d+)\s*шт(?![а-яіїєґa-z])/i;
// Тут «150 мл», «20 л» — місткість речі, а не вміст: рахуємо лише за штуку.
const PCS_ONLY = new Set(['Дім, одяг і дозвілля', 'Канцелярські товари']);
// Тут штуки важливіші за вагу («Пакети 30 шт 35 л», «Підгузки 40 шт»).
const PCS_FIRST = new Set(['Товари для дому', 'Товари для дітей']);
// Набори тут — різні речі в одній упаковці («дез стік 50 мл / гель 250 мл»): лише за штуку.
// В інших розділах («Набір кормів 340 г», «Набір Шоколад 255г (3шт*85г)») вага — це весь вміст.
const SET_PCS_ONLY = new Set([...PCS_ONLY, ...PCS_FIRST, 'Гігієна і косметика']);
// «12», «2,5» або «(20+2)»
const qtyNum = (s) => (s[0] === '(' ? s.slice(1, -1).split('+').reduce((a, b) => a + +b, 0) : parseFloat(s.replace(',', '.')));

function parseWeight(name) {
  let m = name.match(QTY_MULTI);
  if (m) {
    const [unit, k] = QTY_UNIT[m[3].toLowerCase()];
    return { unit, qty: qtyNum(m[1]) * qtyNum(m[2]) * k };
  }
  m = name.match(QTY_MULTI_REV);
  if (m) {
    const [unit, k] = QTY_UNIT[m[2].toLowerCase()];
    return { unit, qty: qtyNum(m[1]) * qtyNum(m[3]) * k };
  }
  const one = name.match(QTY_ONE);
  m = name.match(QTY_SUM);
  // Сума — лише якщо стоїть не пізніше за звичайну вагу («Хліб 350 г … 1г+2г» — це 350 г).
  if (m && m.index <= one.index) {
    const [unit, k2] = QTY_UNIT[m[4].toLowerCase()];
    const k1 = m[2] ? QTY_UNIT[m[2].toLowerCase()] : [unit, k2];
    if (k1[0] === unit) return { unit, qty: qtyNum(m[1]) * k1[1] + qtyNum(m[3]) * k2 };
  }
  if (one) {
    const [unit, k] = QTY_UNIT[one[2].toLowerCase()];
    return { unit, qty: qtyNum(one[1]) * k };
  }
  return null;
}
function parsePieces(name) {
  const s = name.match(QTY_PCS_SUM);
  if (s) return { unit: 'шт', qty: +s[1] + +s[2] };
  const m = name.match(QTY_PCS);
  return m && +m[1] > 1 ? { unit: 'шт', qty: +m[1] } : null;
}

// { price, unit } — ціна за 1 кг / л / шт; null, якщо кількість невідома або це й так ціна за одиницю.
function perUnit(p) {
  if (p.unit === 'кг') return null; // вагові товари вже мають ціну за кг
  // Таблетки, вітаміни: «0,5 г №60» — вага однієї таблетки, а не вміст упаковки.
  if (p.category === 'Медикаменти') return null;
  const g = p.group || '';
  // Набори в неїстівних розділах — лише за штуку; у «штучних» розділах навіть «1 шт» означає, що вага там — не вміст.
  const pcsOnly = PCS_ONLY.has(g) || (SET_PCS_ONLY.has(g) && /^наб[іi]р/i.test(p.name)) || (PCS_FIRST.has(g) && QTY_PCS.test(p.name));
  const q = pcsOnly ? parsePieces(p.name) : parseWeight(p.name) || parsePieces(p.name);
  if (!q || !(q.qty > 0) || q.qty === 1) return null;
  return { price: p.price / q.qty, unit: q.unit };
}
// Ціна за кг / л / шт — лише якщо її ввімкнено в налаштуваннях (типово вимкнено).
const showPer = () => store.get('per') === '1';
// Порівняння з іншими мережами на плитках — теж лише якщо ввімкнено (типово вимкнено).
const showTileVs = () => MULTI_CHAIN && store.get('tileVs') === '1';
const perHtml = (p, cls = 'per') => (p._per && showPer() ? `<span class="${cls}">${fmtPrice(p._per.price)} ₴/${p._per.unit}</span>` : '');

// ---------- Дані ----------

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const cityDir = () => `data/cities/${state.city.slug}`;

// ---------- ТЕСТ: кілька мереж ----------
// Каталоги інших мереж (поки Сільпо — один магазин у Хмельницькому) лежать у data/chains/<мережа>/<місто>/
// у форматі АТБ, з полем chain; будує scraper/silpo.js. Товари АТБ поля chain не мають.
// «Траш!» — лише акції, одні на всю мережу: data/chains/thrash/ без міст (будує scraper/thrash.js).
// Інші мережі (Сільпо, «Траш!») і порівняння з ними — поки лише в тестовій копії (/test/). Основний сайт — тільки АТБ;
// код той самий, тож зміни переносяться з тесту на основний простим копіюванням файлів.
const MULTI_CHAIN = /\/test\//.test(location.pathname);
const CHAINS = {
  atb: 'АТБ', silpo: 'Сільпо', fora: 'Фора', thrash: 'Траш!', metro: 'Метро', auchan: 'Ашан', novus: 'Новус',
  tavriav: 'Таврія В', megamarket: 'МегаМаркет', ekomarket: 'ЕкоМаркет', grosh: 'Грош',
};
const CHAIN_SITE = {
  atb: ['https://www.atbmarket.com', 'atbmarket.com'], silpo: ['https://silpo.ua', 'silpo.ua'], thrash: ['https://thrash.ua', 'thrash.ua'],
  fora: ['https://fora.ua', 'fora.ua'], metro: ['https://metro.zakaz.ua', 'metro.zakaz.ua'], auchan: ['https://auchan.zakaz.ua', 'auchan.zakaz.ua'],
  novus: ['https://novus.zakaz.ua', 'novus.zakaz.ua'], tavriav: ['https://tavriav.zakaz.ua', 'tavriav.zakaz.ua'],
  megamarket: ['https://megamarket.zakaz.ua', 'megamarket.zakaz.ua'], ekomarket: ['https://eko.zakaz.ua', 'eko.zakaz.ua'],
  grosh: ['https://online.grosh.ua', 'online.grosh.ua'],
};
// Мережі з каталогом по містах (data/chains/<мережа>/<місто>/), крім АТБ; «Траш!» — один каталог на всі міста.
const CITY_CHAINS = ['silpo', 'fora', 'metro', 'auchan', 'novus', 'tavriav', 'megamarket', 'ekomarket', 'grosh'];
// id товару = база мережі + код. У «сім'ї» мереж коди спільні (той самий товар — той самий код):
// f — Сільпо, «Траш!», Фора (Fozzy); z — мережі zakaz.ua (номер штрихкоду, scraper/zakaz-ids.json).
const ID_BASE = { silpo: 10e6, thrash: 20e6, metro: 30e6, auchan: 40e6, novus: 50e6, tavriav: 60e6, megamarket: 70e6, ekomarket: 80e6, fora: 90e6, grosh: 100e6 };
const FAMILY = { silpo: 'f', thrash: 'f', fora: 'f', metro: 'z', auchan: 'z', novus: 'z', tavriav: 'z', megamarket: 'z', ekomarket: 'z' };
// Стислий запис товару інших мереж (scraper/chain-store.js, compact): без chain (мережа — за діапазоном id) і без
// спільних початків адрес фото й посилань. Префікси — ті самі, що в chain-store.js.
const ZAKAZ = new Set(['metro', 'auchan', 'novus', 'tavriav', 'megamarket', 'ekomarket']);
const PREFIX = {
  img: {
    silpo: 'https://images.silpo.ua/products/300x300/webp/',
    fora: 'https://content.fora.ua/sku/ecommerce/',
    grosh: 'https://d3og57k1dk4307.cloudfront.net/grosh/',
    zakaz: 'https://img2.zakaz.ua/',
  },
  url: { silpo: '/product/', fora: '/product/', zakaz: '/uk/products/' },
};
function expand(p) {
  if (p.id < ID_BASE.silpo) return p;
  p.chain ||= chainById(p.id);
  const key = ZAKAZ.has(p.chain) ? 'zakaz' : p.chain;
  if (p.img && !/^https?:/.test(p.img) && PREFIX.img[key]) p.img = PREFIX.img[key] + p.img;
  if (p.url && PREFIX.url[key] && !p.url.startsWith('/')) p.url = PREFIX.url[key] + p.url;
  return p;
}
const chainById = (id) => Object.entries(ID_BASE).reduce((best, [c, b]) => (id >= b && b >= (ID_BASE[best] || 0) ? c : best), 'atb');
const chainOf = (p) => p.chain || 'atb';
// Мережі з одним каталогом на всі свої міста: «Траш!» (акції однакові всюди), Грош (ціни інтернет-магазину у Вінниці).
const NATIONAL = new Set(['thrash', 'grosh']);
const chainDir = (chain, slug = state.city.slug) =>
  chain === 'atb' ? `data/cities/${slug}` : NATIONAL.has(chain) ? `data/chains/${chain}` : `data/chains/${chain}/${slug}`;
// Позначка мережі (на сторінці товару й у порівнянні).
const chainTag = (p) => (MULTI_CHAIN ? `<span class="chain chain--${chainOf(p)}">${CHAINS[chainOf(p)]}</span>` : '');

// Місто й магазин (мережу, state.chain) вибирають у налаштуваннях: спершу місто, тоді — одна з мереж, що в ньому є.
// Міста мережі — data/chains/<мережа>/cities.json: [{ slug, address }] (адреса магазину цієї мережі);
// state.cities — завжди всі міста АТБ (порівняння між містами, мапи); АТБ є в кожному з них.
const chainCities = () => state.chainCities[state.chain];
const chainsIn = (slug) => Object.keys(CHAINS).filter((c) => state.chainCities[c]?.some((x) => x.slug === slug));
// Підпис у шапці: місто й магазин (посилання на налаштування).
function showPlace() {
  $('#cityName').textContent = state.city.name;
  const tag = $('#chainName');
  tag.hidden = !MULTI_CHAIN;
  tag.className = `chain chain--${state.chain}`;
  tag.textContent = CHAINS[state.chain];
  $('#placeChip').title = MULTI_CHAIN ? `${state.city.name}, ${CHAINS[state.chain]} — змінити в налаштуваннях` : `${state.city.name} — змінити в налаштуваннях`;
}

async function loadCities() {
  state.cities = await fetch('data/cities.json').then((r) => r.json());
  state.chainCities = { atb: state.cities };
  if (MULTI_CHAIN) {
    // Міста інших мереж — ті з наших, де мережа є (адреса — її магазину). «Траш!» — лише акції, однакові в усіх його магазинах.
    const lists = await Promise.all(
      [...CITY_CHAINS, 'thrash'].map((c) =>
        fetch(`data/chains/${c}/cities.json`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ),
    );
    [...CITY_CHAINS, 'thrash'].forEach((c, i) => {
      const own = lists[i].map((x) => state.cities.find((y) => y.slug === x.slug) && { ...state.cities.find((y) => y.slug === x.slug), ...(x.address ? { address: x.address } : {}) }).filter(Boolean);
      if (own.length) state.chainCities[c] = own;
    });
  }
  const saved = store.get('city');
  const city = state.cities.find((c) => c.slug === saved) || state.cities.find((c) => c.slug === 'kyiv') || state.cities[0];
  const chain = store.get('chain');
  state.chain = chainsIn(city.slug).includes(chain) ? chain : 'atb';
  state.city = chainCities().find((c) => c.slug === city.slug);
  showPlace();
}

// Зміна міста чи магазину (з налаштувань). Якщо вибраної мережі в новому місті немає — магазин АТБ.
async function setPlace(slug, chain = state.chain) {
  if (!chainsIn(slug).includes(chain)) chain = 'atb';
  if (slug === state.city.slug && chain === state.chain) return;
  state.chain = chain;
  state.city = chainCities().find((c) => c.slug === slug);
  store.set('chain', chain);
  store.set('city', slug);
  showPlace();
  const onSettings = location.hash === '#/settings';
  if (onSettings) app.querySelector('.place')?.classList.add('is-loading');
  else app.innerHTML = skeleton();
  await loadData();
  state.shown = PAGE;
  if (onSettings) renderSettings(true);
  else route();
}

// ---------- Налаштування (#/settings) ----------
// Зберігаються в браузері (store). Кожен розділ — панель з рядками «назва — перемикач»; нові налаштування — нові рядки.

// Тема: як у системі, світла чи темна. Саму тему ставить applyTheme з index.html (до першого малювання).
const THEMES = {
  auto: ['Як у системі', '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/>'],
  light: [
    'Світла',
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  ],
  dark: ['Темна', '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>'],
};
const currentTheme = () => (THEMES[store.get('theme')] ? store.get('theme') : 'auto');
function setTheme(t) {
  if (t === 'auto') {
    try {
      localStorage.removeItem('theme');
    } catch {}
  } else store.set('theme', t);
  window.applyTheme?.();
}

// Сортування за ціною за кг / л / шт — лише коли цю ціну показуємо; інакше вибране сортування скидаємо.
function applyPerSetting() {
  const on = showPer();
  for (const o of sortEl.options) {
    if (!o.value.startsWith('per-')) continue;
    o.hidden = !on;
    o.disabled = !on;
  }
  if (!on && filters.sort.startsWith('per-')) {
    filters.sort = 'name';
    sortEl.value = 'name';
    try {
      sessionStorage.setItem('filters', JSON.stringify(filters));
    } catch {}
  }
}

// Примітка під назвою мережі на картці магазину (замість адреси).
const STORE_NOTE = {
  thrash: 'Лише акції — однакові в усіх магазинах мережі',
  grosh: 'Ціни інтернет-магазину у Вінниці',
};
// Позначка на картці магазину (за замовчуванням — дві перші літери назви).
const STORE_MARK = { megamarket: 'ММ', ekomarket: 'ЕМ', tavriav: 'ТВ' };
const PIN = '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/>';
function placeHtml() {
  const slug = state.city.slug;
  const stores = chainsIn(slug)
    .map((c) => {
      const here = state.chainCities[c].find((x) => x.slug === slug);
      const sub = STORE_NOTE[c] || here.address || '';
      return `<button type="button" class="store-card" data-chain="${c}" aria-pressed="${c === state.chain}">
          <span class="store-card__mark chain--${c}" aria-hidden="true">${esc(STORE_MARK[c] || CHAINS[c].replace(/[^\p{L}]/gu, '').slice(0, 2))}</span>
          <span class="store-card__text"><b>${esc(CHAINS[c])}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
          <svg class="store-card__check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        </button>`;
    })
    .join('');
  return `<section class="panel settings place">
      <div class="panel__head"><h2>${MULTI_CHAIN ? 'Місто і магазин' : 'Місто'}</h2></div>
      <div class="place__current"><svg viewBox="0 0 24 24" aria-hidden="true">${PIN}</svg><b>${esc(state.city.name)}</b>${MULTI_CHAIN ? `<span class="chain chain--${state.chain}">${esc(CHAINS[state.chain])}</span>` : ''}</div>
      <label class="place__search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" id="placeQ" placeholder="Знайти місто" autocomplete="off" aria-label="Знайти місто"></label>
      <div class="place__cities" id="placeCities" role="listbox" aria-label="Місто"></div>
      ${
        MULTI_CHAIN
          ? `<h3 class="place__h">Магазин у місті ${esc(state.city.name)}</h3>
      <p class="note place__hint">Від магазину залежать товари в пошуку й на головній; ціни інших мереж міста — у порівнянні на сторінці товару.</p>
      <div class="store-grid" role="group" aria-label="Магазин">${stores}</div>`
          : `<p class="note place__hint">Ціни магазину АТБ у вибраному місті: ${esc(state.city.address || '')}</p>`
      }
    </section>`;
}
function initPlace() {
  const q = $('#placeQ');
  const list = $('#placeCities');
  const sorted = [...state.cities].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  const paint = () => {
    const words = norm(q.value).split(/\s+/).filter(Boolean);
    const shown = sorted.filter((c) => words.every((w) => norm(c.name).includes(w)));
    list.innerHTML = shown.length
      ? shown
          .map((c) => {
            const n = MULTI_CHAIN ? chainsIn(c.slug).length : 0;
            return `<button type="button" class="place__city" role="option" data-slug="${c.slug}" aria-selected="${c.slug === state.city.slug}">${esc(c.name)}${n > 1 ? `<small>${n} мереж${n < 5 ? 'і' : ''}</small>` : ''}</button>`;
          })
          .join('')
      : '<p class="note">Такого міста немає</p>';
    const sel = !words.length && list.querySelector('[aria-selected=true]');
    if (sel) list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
  };
  q.oninput = paint;
  q.onkeydown = (e) => {
    const first = list.querySelector('[data-slug]');
    if (e.key === 'Enter' && first) setPlace(first.dataset.slug);
  };
  list.onclick = (e) => {
    const b = e.target.closest('[data-slug]');
    if (b) setPlace(b.dataset.slug);
  };
  app.querySelector('.store-grid')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chain]');
    if (b) setPlace(state.city.slug, b.dataset.chain);
  });
  paint();
}

function renderSettings(keepScroll = false) {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Налаштування — Жаба';
  if (!keepScroll) scrollTo(0, 0);
  const seg = (name, options, value) =>
    `<div class="seg settings-seg" role="group" aria-label="${esc(name)}">${Object.entries(options)
      .map(([k, [label, icon]]) => `<button type="button" data-set="${name}" data-v="${k}" aria-pressed="${k === value}">${icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ''}${esc(label)}</button>`)
      .join('')}</div>`;
  app.innerHTML = `${backLink()}<h1 class="page-title">Налаштування</h1>
    ${placeHtml()}
    <section class="panel settings settings--view">
      <div class="panel__head"><h2>Вигляд</h2></div>
      <div class="settings-row">
        <div><b>Тема</b><span class="note">«Як у системі» — світла чи темна, як налаштовано на пристрої.</span></div>
        ${seg('theme', THEMES, currentTheme())}
      </div>
      <div class="settings-row">
        <div><b>Ціна за кг / л / шт</b><span class="note">На плитках і сторінці товару, а також сортування «Дешевші за 1 кг / л / шт».</span></div>
        ${seg('per', { off: ['Не показувати'], on: ['Показувати'] }, showPer() ? 'on' : 'off')}
      </div>
      <div class="settings-row"${MULTI_CHAIN ? '' : ' hidden'}>
        <div><b>Порівняння на плитках</b><span class="note">Ціна такого самого товару в інших мережах міста під кожною плиткою.</span></div>
        ${seg('tileVs', { off: ['Не показувати'], on: ['Показувати'] }, showTileVs() ? 'on' : 'off')}
      </div>
    </section>
    <p class="note settings-note">Налаштування зберігаються лише в цьому браузері.</p>`;
  initPlace();
  app.querySelector('.settings--view').onclick = (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    if (b.dataset.set === 'theme') setTheme(b.dataset.v);
    if (b.dataset.set === 'tileVs') store.set('tileVs', b.dataset.v === 'on' ? '1' : '0');
    if (b.dataset.set === 'per') {
      store.set('per', b.dataset.v === 'on' ? '1' : '0');
      applyPerSetting();
    }
    for (const x of app.querySelectorAll(`[data-set="${b.dataset.set}"]`)) x.setAttribute('aria-pressed', x === b);
  };
}

// Висота шапки — щоб «← назад» прилипав одразу під нею (шапка змінюється: фільтри, перенос рядків).
const topBar = $('.top');
new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${topBar.offsetHeight}px`)).observe(topBar);

// Незмінні поля товарів мережі (назва, фото, розділ…) однакові в усіх її містах — лежать один раз
// у data/chains/<мережа>/catalog.json (scraper/chain-pack.js); у products.json міста — ціни й те, що відрізняється.
const chainCatalogs = {};
const chainCatalog = (c) =>
  (chainCatalogs[c] ||= fetch(`data/chains/${c}/catalog.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})));
async function chainProducts(c) {
  const [list, cat] = await Promise.all([
    fetch(`${chainDir(c)}/products.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    NATIONAL.has(c) ? {} : chainCatalog(c),
  ]);
  return list.map((p) => (cat[p.id] ? { ...cat[p.id], ...p } : p));
}

// Товари інших мереж міста, яких ще немає в state.all (усі разом — десятки тисяч, тож вантажимо лише потрібні).
async function ensureChains(chains) {
  const need = [...new Set(chains)].filter((c) => CITY_CHAINS.includes(c) && state.chains.includes(c) && !state.loaded.has(c));
  if (!need.length) return;
  const slug = state.city.slug;
  const lists = await Promise.all(need.map(chainProducts));
  if (state.city.slug !== slug) return;
  need.forEach((c, i) => {
    if (state.loaded.has(c)) return;
    state.loaded.add(c);
    for (const p of lists[i]) {
      expand(p);
      p._q = norm(`${p.name} ${p.brand ?? ''}`);
      p._per = perUnit(p);
      state.byId.set(p.id, p);
      state.all.push(p);
    }
  });
  peersFor = null;
}
// extra.json може бути стислим — лише ціни й місто (from); назви, фото, розділи — у спільному data/catalog.json
// (однакові для всіх міст; будує scraper/fallback.js).
let catalogCache;
async function withCatalog(extra) {
  if (!extra.length || extra[0].name) return;
  catalogCache ||= fetch('data/catalog.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const cat = await catalogCache;
  for (const p of extra) Object.assign(p, cat[p.id]);
  for (let i = extra.length - 1; i >= 0; i--) if (!extra[i].name) extra.splice(i, 1);
}

async function loadData() {
  // Каталог спільний для всіх міст: products.json — товари цього міста, extra.json — решта,
  // з цінами найближчого міста, де вони є (поле from), — будує scraper/fallback.js.
  const optional = (file, fallback) =>
    fetch(file)
      .then((r) => (r.ok ? r.json() : fallback))
      .catch(() => fallback);
  // Інші мережі міста: одразу вантажимо Сільпо (порівняння на плитках) і вибрану мережу; решту — коли знадобляться
  // (порівняння на сторінці товару, пошук за штрихкодом) — ensureChains.
  const inCity = (c) => state.chainCities[c]?.some((x) => x.slug === state.city.slug);
  const eager = [...new Set(['silpo', state.chain])].filter((c) => CITY_CHAINS.includes(c) && inCity(c));
  const [own, extra, meta, chainMeta, ...lists] = await Promise.all([
    fetch(`${cityDir()}/products.json`).then((r) => r.json()),
    optional(`${cityDir()}/extra.json`, []),
    fetch(`${cityDir()}/meta.json`).then((r) => r.json()),
    CITY_CHAINS.includes(state.chain) ? optional(`${chainDir(state.chain)}/meta.json`, null) : null,
    ...eager.map(chainProducts),
  ]);
  await withCatalog(extra);
  // Акції «Траш!» — якщо в місті є його магазини. До state.chains (порівняння каталогів) не входять: це лише акції.
  const hasThrash = state.chainCities.thrash?.some((c) => c.slug === state.city.slug);
  const [thrash, thrashMeta] = hasThrash
    ? await Promise.all([optional('data/chains/thrash/products.json', []), optional('data/chains/thrash/meta.json', null)])
    : [[], null];
  state.thrash = thrash;
  // Мережі, що є в цьому місті (для порівняння на сторінці товару); state.loaded — чиї товари вже в state.all.
  state.chains = ['atb', ...CITY_CHAINS.filter(inCity)];
  state.loaded = new Set(['atb', ...eager, ...(thrash.length ? ['thrash'] : [])]);
  const collator = new Intl.Collator('uk');
  // state.all — товари всіх мереж міста (сторінки товарів, обране, порівняння); state.products — лише вибраної мережі.
  state.all = own.concat(extra, ...lists, thrash).sort((a, b) => collator.compare(a.name, b.name));
  state.byId = new Map();
  state.shards = new Map();
  for (const p of state.all) {
    expand(p);
    p._q = norm(`${p.name} ${p.brand ?? ''}`);
    p._per = perUnit(p);
    state.byId.set(p.id, p);
  }
  const products = state.all.filter((p) => chainOf(p) === state.chain);
  // Картка АТБ є лише в АТБ: в інших мережах фільтра не показуємо (і він не діє).
  $('#card').closest('label').hidden = state.chain !== 'atb';
  state.products = products;
  const m = (state.chain === 'thrash' && thrashMeta) || chainMeta || meta;
  state.meta = m;
  state.changes = await fetch(`${chainDir(state.chain)}/changes.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  for (const p of state.changes?.removed || []) expand(p);
  $('#updated').textContent =
    state.chain === 'thrash'
      ? `${state.city.name}, «Траш!»: лише акції, однакові в усіх магазинах мережі · ${m.productCount.toLocaleString('uk')} товарів · оновлено ${fmtDate(parseDate(m.updated))}`
      : `${state.city.name}, магазин ${CHAINS[state.chain]}: ${m.store.address} · ${m.productCount.toLocaleString('uk')} товарів · оновлено ${fmtDate(parseDate(m.updated))}`;

  const groups = new Map();
  for (const p of products) groups.set(p.group || 'Інше', (groups.get(p.group || 'Інше') || 0) + 1);
  const order = (g) => (GROUPS.has(g) ? [...GROUPS.keys()].indexOf(g) : GROUPS.size);
  state.groups = [...groups].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'uk'));
  // Якщо вибраного розділу в цьому місті немає — скидаємо фільтр.
  if (filters.group && !groups.has(filters.group)) filters.group = '';
  fillCategories();
  syncFavs();
  syncCart();
}

// Підкатегорії лише вибраного розділу.
function fillCategories() {
  const counts = new Map();
  for (const p of state.products) {
    if (p.category && (!filters.group || (p.group || 'Інше') === filters.group)) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  }
  const cats = [...counts].sort((a, b) => a[0].localeCompare(b[0], 'uk'));
  if (filters.cat && !counts.has(filters.cat)) filters.cat = '';
  $('#cat').innerHTML =
    `<option value="">${filters.group ? 'Усі підкатегорії' : 'Усі категорії'}</option>` +
    cats.map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join('');
  $('#cat').value = filters.cat;
}

// Розділи в порядку показу та їхні іконки.
const GROUPS = new Map([
  ['Овочі та фрукти', '🥦'],
  ['Молочні продукти та яйця', '🥛'],
  ["М'ясо", '🥩'],
  ["Ковбаса і м'ясні делікатеси", '🥓'],
  ['Риба і морепродукти', '🐟'],
  ['Хлібобулочні вироби', '🍞'],
  ['Бакалія', '🌾'],
  ['Кондитерські вироби', '🍫'],
  ['Заморожені продукти', '🧊'],
  ['Кулінарія', '🍲'],
  ['Японська кухня', '🍣'],
  ['Чипси, снеки', '🍿'],
  ['Кава, чай', '☕'],
  ['Напої безалкогольні', '🥤'],
  ['Алкоголь', '🍷'],
  ['Дитяче харчування', '🍼'],
  ['Товари для дітей', '🧸'],
  ['Гігієна і косметика', '🧼'],
  ['Побутова хімія та непродовольчі товари', '🧴'],
  ['Товари для дому', '🏠'],
  ['Дім, одяг і дозвілля', '🛋️'],
  ['Товари для тварин', '🐾'],
  ['Канцелярські товари', '✏️'],
  ['Тютюнові вироби', '🚬'],
  ['Сертифікати та платіжні картки', '💳'],
]);

// slug — місто, з якого історія (для товарів, яких у вибраному місті немає, — місто-джерело ціни).
async function loadHistory(id, slug = state.city.slug, chain = 'atb') {
  const shard = String(id % SHARDS).padStart(2, '0');
  const key = `${chain}/${slug}/${shard}`;
  if (!state.shards.has(key)) state.shards.set(key, fetch(`${chainDir(chain, slug)}/history/${shard}.json`).then((r) => r.json()));
  return (await state.shards.get(key))[id] || [];
}
const cityName = (slug) => state.cities.find((c) => c.slug === slug)?.name || slug;

// ---------- Обране і сповіщення ----------
// favs[id] = { name, img, unit, target, seen: { місто: ціна } }.
// seen — остання ціна, яку користувач бачив; «подешевшало» = поточна ціна нижча за seen
// (і не вища за target, якщо його задано). Подорожчання тихо піднімає seen, щоб наступне зниження теж помітили.
// Копія лежить у Cache Storage — її читає service worker для фонової перевірки (localStorage йому недоступний).

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.6-4.7-9.4-9.6C1.4 7.6 3.6 4.5 7 4.5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.4 0 5.6 3.1 4.4 6.4-1.8 4.9-9.4 9.6-9.4 9.6Z"/></svg>';
const STATE_CACHE = 'pricetrail-state';
let favs = {};
try {
  favs = JSON.parse(store.get('favs') || '{}');
} catch {}
const isFav = (id) => id in favs;

function saveFavs() {
  store.set('favs', JSON.stringify(favs));
  if ('caches' in window) {
    caches
      .open(STATE_CACHE)
      .then((c) => c.put('state/favs', new Response(JSON.stringify({ favs, city: state.city.slug }))))
      .catch(() => {});
  }
  updateFavBadge();
}

function toggleFav(p) {
  if (isFav(p.id)) delete favs[p.id];
  else favs[p.id] = { name: p.name, img: p.img, unit: p.unit, target: null, seen: { [state.city.slug]: p.price } };
  saveFavs();
}

const favDrop = (p, f) => {
  const seen = f.seen?.[state.city.slug];
  return seen != null && p.price < seen - 0.004 && (!f.target || p.price <= f.target);
};
const favHits = () =>
  Object.entries(favs)
    .map(([id, f]) => ({ p: state.byId.get(+id), f }))
    .filter(({ p, f }) => p && favDrop(p, f));

function markSeen(ids) {
  for (const id of ids) {
    const p = state.byId.get(id);
    if (p && favs[id]) favs[id].seen = { ...favs[id].seen, [state.city.slug]: p.price };
  }
  saveFavs();
}

// Після завантаження міста: ціна, яку ще не бачили, стає «баченою»; подорожчання піднімає seen.
function syncFavs() {
  for (const [id, f] of Object.entries(favs)) {
    const p = state.byId.get(+id);
    if (!p) continue;
    Object.assign(f, { name: p.name, img: p.img, unit: p.unit });
    const seen = f.seen?.[state.city.slug];
    if (seen == null || p.price > seen) f.seen = { ...f.seen, [state.city.slug]: p.price };
  }
  saveFavs();
}

function updateFavBadge() {
  const n = state.byId.size ? favHits().length : 0;
  const el = $('#favN');
  el.textContent = n;
  el.hidden = !n;
  $('#favLink').setAttribute('aria-label', n ? `Обране: подешевшало ${n}` : 'Обране');
}

// Підказка при відкритті сайту — раз за сесію на той самий набір знижок.
function favToast() {
  const hits = favHits();
  const sig = hits.map(({ p }) => `${p.id}:${p.price}`).join();
  if (!hits.length || location.hash === '#/fav') return;
  try {
    if (sessionStorage.getItem('favToast') === sig) return;
    sessionStorage.setItem('favToast', sig);
  } catch {}
  const t = document.createElement('a');
  t.className = 'toast';
  t.href = '#/fav';
  t.innerHTML = `${HEART}<span>${hits.length === 1 ? `Подешевшало: ${esc(hits[0].p.name)}` : `З обраного подешевшало товарів: ${hits.length}`}</span>`;
  t.onclick = () => t.remove();
  document.body.append(t);
  setTimeout(() => t.remove(), 7000);
}

// Фонова перевірка (Periodic Background Sync): Chrome/Edge, коли сайт встановлено як застосунок.
async function registerPeriodicCheck() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return false;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state !== 'granted') return false;
    await reg.periodicSync.register('prices', { minInterval: 12 * 3600 * 1000 });
    return true;
  } catch {
    return false;
  }
}

async function notifyPanel() {
  const el = $('#notify');
  if (!el) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    el.innerHTML = '<p class="note">Цей браузер не підтримує сповіщення. Подешевшання з обраного видно тут і на значку ♥ угорі.</p>';
    return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    el.innerHTML = '<p class="note">🔕 Сповіщення заблоковано в налаштуваннях браузера для цього сайту.</p>';
    return;
  }
  if (perm === 'default') {
    el.innerHTML = `<button class="btn btn--primary" id="notifyOn">🔔 Увімкнути сповіщення</button>
      <p class="note">Повідомимо, коли товар з обраного подешевшає або ціна опуститься до вказаної вами.</p>`;
    $('#notifyOn').onclick = async () => {
      await Notification.requestPermission();
      notifyPanel();
    };
    return;
  }
  const bg = await registerPeriodicCheck();
  if (!$('#notify')) return;
  el.innerHTML = bg
    ? '<p class="note">🔔 Сповіщення увімкнено: ціни з обраного перевіряються у фоні раз на день, навіть коли сайт закрито.</p>'
    : '<p class="note">🔔 Сповіщення дозволено, але фонова перевірка в цьому браузері недоступна. Вона працює в Chrome або Edge, якщо встановити Жабу як застосунок (меню браузера → «Встановити» / «Додати на головний екран»). Доти подешевшання видно тут і на значку ♥ угорі.</p>';
}

function renderFavs() {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Обране — Жаба';
  scrollTo(0, 0);
  const items = Object.entries(favs).map(([id, f]) => ({ id: +id, f, p: state.byId.get(+id) }));
  const hits = items.filter(({ p, f }) => p && favDrop(p, f));
  const rest = items
    .filter((x) => !hits.includes(x))
    .sort((a, b) => (a.p ? 0 : 1) - (b.p ? 0 : 1) || a.f.name.localeCompare(b.f.name, 'uk'));
  const missing = ({ id, f }) => `<div class="card card--missing">
      <div class="card__media"><img class="card__img" src="${esc(f.img)}" alt="" loading="lazy"><button class="fav-btn" data-fav="${id}" aria-pressed="true" aria-label="Прибрати з обраного">${HEART}</button></div>
      <div class="card__body"><div class="card__name">${esc(f.name)}</div><div class="note">Немає в цьому магазині</div></div>
    </div>`;
  const tile = (x) => (x.p ? card(x.p, x.f.seen?.[state.city.slug]) : missing(x));
  let html = `${backLink(favFrom)}<h1 class="page-title">Обране</h1><div class="panel notify" id="notify"></div>`;
  if (!items.length) {
    html += '<div class="empty"><b>♡</b>Тут поки порожньо<br><span class="note">Натисніть ♡ на картці товару — і ми підкажемо, коли він подешевшає</span></div>';
  } else {
    if (hits.length) {
      html += `<div class="section-head"><h2>Подешевшало · ${hits.length}</h2><button id="seenAll">Позначити переглянутим</button></div>
        <div class="grid">${hits.map(tile).join('')}</div>`;
    }
    if (rest.length) {
      html += `<div class="section-head"><h2>${hits.length ? 'Решта обраного' : 'Усі обрані'} · ${rest.length}</h2></div>
        <div class="grid">${rest.map(tile).join('')}</div>`;
    }
  }
  app.innerHTML = html;
  notifyPanel();
  const seenAll = $('#seenAll');
  if (seenAll) {
    seenAll.onclick = () => {
      markSeen(hits.map((x) => x.id));
      renderFavs();
    };
  }
}

function favActions(p) {
  const f = favs[p.id];
  return `<button class="btn fav-toggle" data-fav="${p.id}" aria-pressed="${!!f}">${HEART}${f ? 'В обраному' : 'Стежити за ціною'}</button>
    ${
      f
        ? `<label class="fav-target">Сповістити, коли подешевшає, або лише коли ціна не вища за
            <input type="number" id="favTarget" min="0" step="0.01" inputmode="decimal" placeholder="${fmtPrice(p.price * 0.9)}" value="${f.target ?? ''}"> грн</label>`
        : ''
    }`;
}

function bindFavTarget(p) {
  const input = $('#favTarget');
  if (!input) return;
  input.onchange = () => {
    const v = parseFloat(input.value.replace(',', '.'));
    favs[p.id].target = v > 0 ? v : null;
    saveFavs();
  };
}

// ---------- Список покупок ----------
// cart[id] = { q: кількість (шт або кг), done: куплено, name, img, unit, chain } — зберігається в браузері.
// Список поділено за мережами: у кожної своя сума (купують у різних магазинах).
// Ціни беремо поточні: у вибраному місті (state.byId) і в інших містах (data/compare).

const BAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>';
let cart = {};
try {
  cart = JSON.parse(store.get('cart') || '{}');
} catch {}
const inCart = (id) => id in cart;
// Вагові товари — кроком 0,1 кг, решта — поштучно.
const qtyStep = (unit) => (unit === 'кг' ? 0.1 : 1);
const fmtQty = (q, unit) => `${String(+q.toFixed(2)).replace('.', ',')} ${unit === 'кг' ? 'кг' : 'шт'}`;

function saveCart() {
  store.set('cart', JSON.stringify(cart));
  updateCartBadge();
}

function toggleCart(p) {
  if (inCart(p.id)) delete cart[p.id];
  else cart[p.id] = { q: qtyStep(p.unit) === 1 ? 1 : 0.5, done: false, name: p.name, img: p.img, unit: p.unit, chain: chainOf(p) };
  saveCart();
}

function syncCart() {
  for (const [id, c] of Object.entries(cart)) {
    const p = state.byId.get(+id);
    if (p) Object.assign(c, { name: p.name, img: p.img, unit: p.unit, chain: chainOf(p) });
  }
  saveCart();
}

function updateCartBadge() {
  const n = Object.values(cart).filter((c) => !c.done).length;
  const el = $('#cartN');
  el.textContent = n;
  el.hidden = !n;
  $('#cartLink').setAttribute('aria-label', n ? `Список покупок: ${n}` : 'Список покупок');
}

const cartBtn = (p) =>
  `<button class="cart-btn" data-cart="${p.id}" aria-pressed="${inCart(p.id)}" aria-label="${inCart(p.id) ? 'Прибрати зі списку покупок' : 'Додати до списку покупок'}">${BAG}</button>`;
// На сторінці товару: кнопка списку, а коли товар у списку — ще й кількість (шт або кг).
const cartToggle = (p) =>
  `<span class="cart-ctl" data-cart-ctl="${p.id}"><button class="btn cart-toggle" data-cart="${p.id}" aria-pressed="${inCart(p.id)}">${BAG}${inCart(p.id) ? 'У списку покупок' : 'До списку покупок'}</button>${
    inCart(p.id)
      ? `<span class="cart-row__qty"><button data-qty="${p.id}" data-d="-1" aria-label="Менше">−</button><span>${fmtQty(cart[p.id].q, cart[p.id].unit)}</span><button data-qty="${p.id}" data-d="1" aria-label="Більше">+</button></span>`
      : ''
  }</span>`;

let cartFrom = '#/';
function renderCart() {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Список покупок — Жаба';
  const ids = Object.keys(cart).map(Number);
  let html = `${backLink(cartFrom)}<h1 class="page-title">Список покупок</h1>`;
  if (!ids.length) {
    app.innerHTML = `${html}<div class="empty"><b>🛍</b>Список порожній<br><span class="note">Натисніть кошик на картці товару — і тут з'явиться сума покупки та порівняння з іншими містами</span></div>`;
    return;
  }
  const items = ids
    .map((id) => ({ id, c: cart[id], p: state.byId.get(id) }))
    .sort((a, b) => a.c.done - b.c.done || a.c.name.localeCompare(b.c.name, 'uk'));
  const priced = items.filter((x) => x.p);
  const sum = (list) => list.reduce((s, x) => s + x.p.price * x.c.q, 0);
  const total = sum(priced);
  const left = sum(priced.filter((x) => !x.c.done));
  const elsewhere = priced.filter((x) => x.p.from).length;
  const missing = items.length - priced.length;
  // Мережа — із запису (старі записи без неї — за діапазоном id: Сільпо від 10 млн, «Траш!» від 20 млн).
  const chainId = ({ id, c }) => c.chain || chainById(id);
  const byChain = Object.keys(CHAINS)
    .map((chain) => [chain, items.filter((x) => chainId(x) === chain)])
    .filter(([, list]) => list.length);
  const row = ({ id, c, p }) => `<div class="cart-row${c.done ? ' is-done' : ''}">
      <label class="cart-row__check" title="${c.done ? 'Повернути в список' : 'Позначити купленим'}"><input type="checkbox" data-done="${id}"${c.done ? ' checked' : ''}><span aria-hidden="true"></span></label>
      <img src="${esc(c.img)}" alt="" loading="lazy">
      <div class="cart-row__main">
        <a href="#/p/${id}" class="cart-row__name">${esc(c.name)}</a>
        <span class="note">${
          p
            ? `${fmtPrice(p.price)} грн/${esc(p.unit)}${p.oldPrice ? ' · акція' : ''}${p.until ? ` до ${fmtDate(parseDate(p.until), false)}` : ''}${p.from ? ` · ціна з міста ${esc(cityName(p.from))}` : ''}`
            : chainId({ id, c }) === 'thrash'
              ? 'акція закінчилась або в місті немає «Траш!»'
              : 'немає в каталозі'
        }</span>
      </div>
      <div class="cart-row__qty">
        <button data-qty="${id}" data-d="-1" aria-label="Менше">−</button><span>${fmtQty(c.q, c.unit)}</span><button data-qty="${id}" data-d="1" aria-label="Більше">+</button>
      </div>
      <b class="cart-row__sum">${p ? fmtPrice(p.price * c.q) : '—'}</b>
      <button class="cart-row__del" data-uncart="${id}" aria-label="Прибрати зі списку">×</button>
    </div>`;
  const notes = [
    elsewhere && `${elsewhere} ${plural(elsewhere, 'товару', 'товарів', 'товарів')} немає у вибраному місті — порахована ціна з іншого міста`,
    missing && `${missing} ${plural(missing, 'товару', 'товарів', 'товарів')} немає в каталозі — не враховано`,
  ].filter(Boolean);
  html += `<div class="panel cart">
      ${byChain
        .map(([chain, list]) => {
          const got = list.filter((x) => x.p);
          const rest = sum(got.filter((x) => !x.c.done));
          return `<div class="cart-chain">
            ${
              byChain.length > 1
                ? `<div class="cart-chain__head"><span class="chain chain--${chain}">${CHAINS[chain]}</span>
                    <span class="note">${list.length} ${plural(list.length, 'товар', 'товари', 'товарів')}${got.length && !rest ? ' · усе куплено' : rest !== sum(got) ? ` · ще купити ${fmtPrice(rest)} грн` : ''}</span>
                    <b>${fmtPrice(sum(got))} грн</b></div>`
                : ''
            }
            <div class="cart-rows">${list.map(row).join('')}</div>
          </div>`;
        })
        .join('')}
      <div class="cart-total">
        <span>Разом у місті ${esc(state.city.name)}${byChain.length > 1 ? ` (${byChain.map(([c]) => CHAINS[c]).join(', ')})` : ''}</span><b>${fmtPrice(total)} грн</b>
        ${left !== total ? `<span class="note">Ще купити: ${fmtPrice(left)} грн</span>` : ''}
      </div>
      ${notes.length ? `<p class="note">${notes.join('; ')}.</p>` : ''}
      <div class="cart-actions">
        ${items.some((x) => x.c.done) ? '<button id="cartClearDone">Прибрати куплене</button>' : ''}
        <button id="cartClear">Очистити список</button>
      </div>
    </div>
    ${byChain.some(([c]) => c === 'atb') ? `<section class="panel" id="cartCompare"><div class="panel__head"><h2>${byChain.length > 1 ? 'Товари АТБ' : 'Цей список'} в інших містах</h2></div><div class="sk" style="height:120px;border-radius:12px"></div></section>` : ''}`;
  // Зміна кількості перемальовує сторінку — лишаємось на тому самому місці.
  const y = scrollY;
  app.innerHTML = html;
  scrollTo(0, y);
  // Ціни в інших містах є лише для АТБ.
  if ($('#cartCompare')) renderCartCompare($('#cartCompare'), priced.filter((x) => chainId(x) === 'atb'));
}

// Список в інших містах (data/compare): кожне місто порівнюємо з вибраним за товарами, що є в обох;
// скільки товарів у місті бракує — пишемо поруч. Сума — за тими товарами, що там є.
async function renderCartCompare(el, priced) {
  const title = el.querySelector('h2').textContent;
  const prices = await Promise.all(priced.map((x) => loadCompare(x.id)));
  if (!el.isConnected) return;
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const mine = state.city.slug;
  const rows = state.cities
    .filter((c) => c.slug !== mine)
    .map((city) => {
      let sum = 0;
      let both = 0;
      let bothHere = 0;
      let lack = 0;
      priced.forEach((x, i) => {
        const v = prices[i][city.slug];
        if (v == null) return lack++;
        sum += one(v) * x.c.q;
        const h = prices[i][mine];
        if (h != null) {
          both += one(v) * x.c.q;
          bothHere += one(h) * x.c.q;
        }
      });
      return { city, sum, lack, d: bothHere ? (both / bothHere - 1) * 100 : null };
    })
    .filter((r) => r.d != null)
    .sort((a, b) => a.d - b.d || a.lack - b.lack);
  if (!rows.length) {
    el.innerHTML = `<div class="panel__head"><h2>${esc(title)}</h2></div><p class="note">Порівняти немає з чим: товарів зі списку немає в інших містах або у вибраному.</p>`;
    return;
  }
  const lo = rows[0].d;
  const hi = rows.at(-1).d;
  const pos = (v) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50);
  const diff = (d) =>
    Math.abs(d) < 0.5
      ? '<span class="crow__diff">так само</span>'
      : `<span class="crow__diff crow__diff--${d < 0 ? 'down' : 'up'}">${d < 0 ? '−' : '+'}${Math.abs(d) < 1 ? '<1' : Math.round(Math.abs(d))}%</span>`;
  const line = (r) => `<div class="crow">
      <span class="crow__city">${esc(r.city.name)}${r.lack ? ` <small class="note">без ${r.lack}</small>` : ''}</span>
      <span class="crow__track" aria-hidden="true"><i style="left:${pos(r.d).toFixed(1)}%"></i></span>
      <span class="crow__price">${fmtPrice(r.sum)}</span>${diff(r.d)}
    </div>`;
  // Найдешевше — серед міст, де бракує найменше товарів (rows уже впорядковані за відсотком).
  const fewest = Math.min(...rows.map((r) => r.lack));
  const best = rows.find((r) => r.lack === fewest);
  const same = rows.every((r) => Math.abs(r.d) < 0.5);
  const summary = same
    ? `У всіх ${rows.length + 1} містах ціни на цей список однакові.`
    : best.d < -0.5
      ? `Найдешевше — у місті ${esc(best.city.name)}: на <b>${Math.round(-best.d) || '<1'}%</b> менше, ніж у місті ${esc(state.city.name)}${best.lack ? ` (без ${best.lack} ${plural(best.lack, 'товару', 'товарів', 'товарів')})` : ''}.`
      : `У місті ${esc(state.city.name)} цей список не дорожчий, ніж деінде.`;
  // Перші 8 — найдешевші; решта згорнута.
  const TOP = 8;
  el.innerHTML = `<div class="panel__head"><h2>${esc(title)}</h2></div>
    <p class="compare__summary">${summary}</p>
    ${
      same
        ? ''
        : `<div class="crows">${rows.slice(0, TOP).map(line).join('')}</div>${
            rows.length > TOP ? `<details class="compare__list"><summary>Ще ${rows.length - TOP} ${plural(rows.length - TOP, 'місто', 'міста', 'міст')}</summary><div class="crows">${rows.slice(TOP).map(line).join('')}</div></details>` : ''
          }`
    }
    <p class="note">${same ? '' : `Відсоток — порівняння з містом ${esc(state.city.name)} за товарами, що є в обох містах; «без N» — стільки товарів зі списку в місті немає, сума — без них. `}Ціни за ${fmtDate(parseDate(state.meta.updated))}, по одному магазину в кожному місті, з урахуванням поточних акцій.</p>`;
}

function bindCart() {
  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cart], [data-qty], [data-uncart], #cartClear, #cartClearDone');
    if (!t) return;
    if (t.dataset.cart) {
      // Кнопка на картці (картка — посилання, тож не даємо перейти) або на сторінці товару.
      e.preventDefault();
      e.stopPropagation();
      const p = state.byId.get(Number(t.dataset.cart));
      if (!p) return;
      toggleCart(p);
      if (t.classList.contains('cart-toggle')) t.closest('.cart-ctl').outerHTML = cartToggle(p);
      else {
        t.setAttribute('aria-pressed', inCart(p.id));
        t.setAttribute('aria-label', inCart(p.id) ? 'Прибрати зі списку покупок' : 'Додати до списку покупок');
      }
      return;
    }
    if (t.dataset.qty) {
      const c = cart[t.dataset.qty];
      const step = qtyStep(c.unit);
      c.q = Math.round((c.q + step * Number(t.dataset.d)) * 100) / 100;
      if (c.q < step / 2) delete cart[t.dataset.qty];
      // На сторінці товару — оновлюємо лише кнопку з кількістю, а не всю сторінку.
      const ctl = t.closest('.cart-ctl');
      if (ctl) {
        e.preventDefault();
        saveCart();
        const p = state.byId.get(Number(t.dataset.qty));
        if (p) ctl.outerHTML = cartToggle(p);
        return;
      }
    } else if (t.dataset.uncart) delete cart[t.dataset.uncart];
    else if (t.id === 'cartClearDone') {
      for (const [id, c] of Object.entries(cart)) if (c.done) delete cart[id];
    } else if (t.id === 'cartClear') {
      // Без системного confirm(): друге натискання протягом 3 секунд підтверджує.
      if (!t.dataset.sure) {
        t.dataset.sure = '1';
        t.textContent = 'Точно очистити?';
        setTimeout(() => {
          if (!t.isConnected) return;
          t.textContent = 'Очистити список';
          delete t.dataset.sure;
        }, 3000);
        return;
      }
      cart = {};
    }
    saveCart();
    renderCart();
  });
  app.addEventListener('change', (e) => {
    const id = e.target.dataset?.done;
    if (!id || !cart[id]) return;
    cart[id].done = e.target.checked;
    saveCart();
    renderCart();
  });
}

// ---------- Фільтри ----------

const filters = { q: '', group: '', cat: '', sort: 'name', sale: false, card: false, inflated: false, local: false };
try {
  Object.assign(filters, JSON.parse(sessionStorage.getItem('filters') || '{}'));
} catch {}
// Параметри з адреси (?q=молоко&sale=1&inflated=1) мають пріоритет — щоб можна було ділитися посиланнями.
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k === 'sale' || k === 'card' || k === 'inflated' || k === 'local') filters[k] = v === '1';
  else if (k in filters) filters[k] = v;
}
delete filters.low; // прибраний фільтр «★ Найнижча ціна» (міг лишитися в sessionStorage)
if (filters.sort === 'per-asc') filters.sort = 'per-kg'; // колишнє «Дешевші за кг/л»
// Колишні сортування «Спершу завищені/реальні акції»: завищені тепер — фільтр.
if (filters.sort === 'inflated') filters.inflated = true;
if (filters.sort === 'inflated' || filters.sort === 'real') filters.sort = 'discount';
if (filters.sort === 'changed') filters.sort = 'name'; // прибране «Нещодавно змінені»

function applyFilters() {
  try {
    sessionStorage.setItem('filters', JSON.stringify(filters));
  } catch {}
  state.shown = PAGE;
  if (BETA) {
    if (location.hash !== '#/all') location.hash = '#/all';
    else renderList();
  } else if (location.hash.startsWith('#/p/') || location.hash === '#/fav' || location.hash === '#/list' || location.hash.startsWith('#/today')) location.hash = '#/';
  else renderList();
}

function bindFilters() {
  $('#q').value = filters.q;
  // На вузькому екрані поруч стоїть сортування — довга підказка не вміщається.
  $('#q').placeholder = 'Товар, бренд або штрихкод';
  if (matchMedia('(max-width: 520px)').matches) $('#q').placeholder = 'Пошук';
  $('#cat').value = filters.cat;
  applyPerSetting();
  sortEl.value = filters.sort;
  $('#sale').checked = filters.sale;
  $('#card').checked = filters.card;
  $('#inflated').checked = filters.inflated;
  $('#local').checked = filters.local;
  let t;
  const update = () => {
    filters.q = $('#q').value;
    filters.cat = $('#cat').value;
    filters.sort = sortEl.value;
    filters.sale = $('#sale').checked;
    filters.card = $('#card').checked;
    filters.inflated = $('#inflated').checked;
    filters.local = $('#local').checked;
    applyFilters();
  };
  // Серце на картці (вона — посилання, тож не даємо перейти) і кнопка на сторінці товару.
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fav]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(b.dataset.fav);
    const p = state.byId.get(id);
    if (p) toggleFav(p);
    else {
      delete favs[id];
      saveFavs();
    }
    if (location.hash === '#/fav') return renderFavs();
    if (b.classList.contains('fav-toggle')) {
      $('.fav-actions').innerHTML = favActions(p);
      bindFavTarget(p);
      return;
    }
    b.setAttribute('aria-pressed', isFav(id));
    b.setAttribute('aria-label', isFav(id) ? 'Прибрати з обраного' : 'Додати в обране');
  });
  initFilterPanel();
  // Бета-головна: натискання на пошук відкриває всі товари з фільтрами й сортуванням.
  $('#q').addEventListener('focus', () => {
    if (isHome()) location.hash = '#/all';
  });
  const scan = $('#scanBtn');
  if (scan) {
    scan.hidden = false;
    scan.onclick = (e) => {
      e.preventDefault();
      openScanner();
    };
  }
  $('#q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(update, 150);
  });
  for (const id of ['#cat', '#sale', '#card', '#inflated', '#local']) $(id).addEventListener('change', update);
  sortEl.addEventListener('change', update);
}

// Ціна за 1 кг / л / шт (вагові товари — за їхньою ціною); null, якщо для цієї одиниці невідома.
const PER_SORT = { 'per-kg': 'кг', 'per-l': 'л', 'per-pcs': 'шт' };
const perIn = (p, unit) => (p.unit === 'кг' ? (unit === 'кг' ? p.price : null) : p._per?.unit === unit ? p._per.price : null);
// Спершу товари з ціною за потрібну одиницю (від найдешевших), далі решта — за звичайною ціною.
const perSorter = (unit) => (a, b) => {
  const x = perIn(a, unit);
  const y = perIn(b, unit);
  return (x == null) - (y == null) || (x ?? a.price) - (y ?? b.price);
};

// ---------- Пошук за штрихкодом ----------
// data/barcodes/NN.json (NN — дві останні цифри): штрихкод → { n: назва, r: [z<номер> | f<код>] } — товари мереж
// zakaz.ua і групи Fozzy (будує scraper/barcodes.js). АТБ і Грош штрихкодів не публікують: їхній товар шукаємо
// за назвою (той самий товар — за назвою й фасовкою, autoMatch). На основному сайті — лише АТБ.
const isBarcode = (q) => /^\d{8,14}$/.test(q.trim());
// Найсхожий товар мережі chain за назвою (sample — { name }), якщо це той самий товар.
function sameByName(sample, chain) {
  let best = null;
  let top = 0;
  for (const x of state.all) {
    if (chainOf(x) !== chain) continue;
    const sc = matchScore(sample, x);
    if (sc > top && autoMatch(sample, x, sc)) [best, top] = [x, sc];
  }
  return best;
}
async function lookupBarcode(q) {
  const code = q.trim().replace(/^0+/, '');
  const shard = await fetch(`data/barcodes/${code.slice(-2).padStart(2, '0')}.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const entry = shard[code];
  const refs = Array.isArray(entry) ? entry : entry?.r || [];
  const hits = [];
  if (MULTI_CHAIN) {
    const ids = [];
    for (const ref of refs) {
      for (const [c, fam] of Object.entries(FAMILY)) if (fam === ref[0]) ids.push([c, ID_BASE[c] + Number(ref.slice(1))]);
    }
    await ensureChains([...ids.map(([c]) => c), 'grosh']);
    hits.push(...new Set(ids.map(([, id]) => state.byId.get(id)).filter((p) => p && !p.from)));
  }
  // АТБ (і Грош) — такий самий товар за назвою: з покажчика або знайденого в іншій мережі.
  const samples = [...(entry?.n ? [{ name: entry.n }] : []), ...hits];
  for (const c of MULTI_CHAIN ? ['atb', 'grosh'] : ['atb']) {
    if (c !== 'atb' && !state.loaded?.has(c)) continue;
    const x = samples.map((h) => sameByName(h, c)).find(Boolean);
    if (x && !hits.includes(x)) hits.unshift(x);
  }
  return { hits, name: entry?.n || '' };
}

// Сканер штрихкоду: живе зображення з камери в сторінці (браузер дає сайту лише потік із камери — нічого не записується),
// або знімок штрихкоду звичайною камерою телефону («Сфотографувати»: її автофокус краще бере дрібні штрихкоди).
// Розпізнає вбудований BarcodeDetector (Chrome, Android), інакше — бібліотека ZXing (Safari, iPhone).
const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
const hasDetector = async () => 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats().catch(() => [])).includes('ean_13');
// Задня камера з високою роздільністю (щоб штрихкод читався з відстані, коли камера близько не фокусується).
const CAMERA = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
async function decodePhoto(file) {
  if (await hasDetector()) {
    const codes = await new BarcodeDetector({ formats: SCAN_FORMATS }).detect(await createImageBitmap(file));
    return codes[0]?.rawValue || null;
  }
  const { BrowserMultiFormatReader } = await import(ZXING);
  const url = URL.createObjectURL(file);
  try {
    return (await new BrowserMultiFormatReader().decodeFromImageUrl(url)).getText();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function openScanner() {
  const box = document.createElement('div');
  box.className = 'scanner';
  box.innerHTML = `<div class="scanner__box"><div class="scanner__view"><video playsinline muted></video><div class="scanner__frame"></div></div>
      <p class="scanner__note">Наведіть камеру на штрихкод товару</p>
      <div class="scanner__actions"><label class="btn scanner__photo">Сфотографувати<input type="file" accept="image/*" capture="environment" hidden></label>
      <button type="button" class="btn scanner__close">Закрити</button></div></div>`;
  document.body.append(box);
  const video = box.querySelector('video');
  const note = box.querySelector('.scanner__note');
  let stream = null;
  let stop = () => {};
  const close = () => {
    stop();
    stream?.getTracks().forEach((t) => t.stop());
    box.remove();
  };
  box.querySelector('.scanner__close').onclick = close;
  const found = (code) => {
    close();
    $('#q').value = code;
    $('#q').dispatchEvent(new Event('input'));
  };
  box.querySelector('.scanner__photo input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    note.textContent = 'Читаю штрихкод…';
    const code = await decodePhoto(file).catch(() => null);
    if (code) return found(code);
    note.textContent = 'На знімку не вдалося прочитати штрихкод. Сфотографуйте ближче й рівніше, щоб штрихкод був різким, або введіть цифри в пошук.';
    e.target.value = '';
  };
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('браузер не дає доступу до камери');
    if (await hasDetector()) {
      stream = await navigator.mediaDevices.getUserMedia(CAMERA);
      // Безперервний автофокус, якщо камера вміє (інакше близький штрихкод лишається розмитим).
      const track = stream.getVideoTracks()[0];
      if (track?.getCapabilities?.().focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      video.srcObject = stream;
      await video.play();
      const det = new BarcodeDetector({ formats: SCAN_FORMATS });
      let on = true;
      stop = () => (on = false);
      const tick = async () => {
        if (!on) return;
        const codes = await det.detect(video).catch(() => []);
        if (codes[0]?.rawValue) return found(codes[0].rawValue);
        setTimeout(tick, 200);
      };
      tick();
    } else {
      const { BrowserMultiFormatReader } = await import(ZXING);
      const controls = await new BrowserMultiFormatReader().decodeFromConstraints(CAMERA, video, (res) => {
        if (res) found(res.getText());
      });
      stop = () => controls.stop();
    }
  } catch (err) {
    box.querySelector('.scanner__view').hidden = true;
    note.textContent = `Камера в сторінці недоступна (${err.message || err}). Сфотографуйте штрихкод або введіть його цифри в пошук.`;
  }
}

function filtered() {
  // Штрихкод у пошуку — товари з ним у мережах міста (знаходить lookupBarcode; фільтри й мережа не діють).
  if (isBarcode(filters.q)) return state.barcode?.q === filters.q.trim() ? state.barcode.hits : [];
  const words = norm(filters.q).split(/\s+/).filter(Boolean);
  let list = state.products.filter(
    (p) =>
      (!filters.group || (p.group || 'Інше') === filters.group) &&
      (!filters.cat || p.category === filters.cat) &&
      (!filters.sale || p.oldPrice) &&
      (!filters.card || state.chain !== 'atb' || p.cardPrice) &&
      (!filters.inflated || inflation(p) > 0) &&
      (!filters.local || !p.from) &&
      words.every((w) => p._q.includes(w)),
  );
  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    discount: (a, b) => discount(b) - discount(a),
    ...Object.fromEntries(Object.entries(PER_SORT).map(([k, u]) => [k, perSorter(u)])),
  };
  // Товари, яких у вибраному місті немає (ціни з іншого міста), сортуються разом з усіма.
  return sorters[filters.sort] ? [...list].sort(sorters[filters.sort]) : list;
}

// ---------- Список ----------

// from — попередня ціна, яку показуємо поруч («↓ було 34,90»): на сторінках «Обране» і «Що змінилося».
const CARD_ICON = '<svg class="atbcard__icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg>';

// extra — додаткова позначка (HTML) на початку рядка позначок.
function card(p, from, extra = '') {
  const sale = p.oldPrice ? `<span class="badge">−${Math.round(discount(p) * 100)}%</span>` : '';
  // «★ найнижча за N дн.» на плитці не показуємо (лише на сторінці товару) — плитки нею переповнені.
  let flags = '';
  if (isInflated(p.oldPrice, p.regular)) {
    flags += `<span class="tag tag--warn" title="Перед акцією було ${fmtPrice(p.regular)} грн — ціну до знижки завищено">⚠ до акції ${fmtPrice(p.regular)}</span>`;
  } else if (dishonest(p) && !p.min30Sale) {
    // «Повторну акцію» на плитці не показуємо (лише на сторінці товару) — плитки нею переповнені.
    flags += honestTag(p);
  }
  if (from != null && Math.abs(p.price - from) > 0.004) {
    const up = p.price > from;
    flags += `<span class="tag tag--${up ? 'up' : 'down'}" title="Попередня ціна ${fmtPrice(from)} грн">${up ? '↑' : '↓'} було ${fmtPrice(from)}</span>`;
  } else if (p.prev && p.prev !== p.price && !p.oldPrice) {
    const up = p.price > p.prev;
    const change = Math.abs((p.price / p.prev - 1) * 100);
    flags += `<span class="tag tag--${up ? 'up' : 'down'}" title="Було ${fmtPrice(p.prev)}">${up ? '↑' : '↓'} ${change < 1 ? change.toFixed(1).replace('.', ',') : Math.round(change)}%</span>`;
  }
  return `<a class="card" href="#/p/${p.id}">
    <div class="card__media">
      <img class="card__img" src="${esc(p.img)}" alt="" loading="lazy" decoding="async">
      <div class="card__corner">${p.from ? `<span class="elsewhere" title="Ціна з міста ${esc(cityName(p.from))} — найближчого, де є цей товар">Немає у вибраному місті</span>` : ''}${sale}</div>
      <button class="fav-btn" data-fav="${p.id}" aria-pressed="${isFav(p.id)}" aria-label="${isFav(p.id) ? 'Прибрати з обраного' : 'Додати в обране'}">${HEART}</button>
      ${cartBtn(p)}
    </div>
    <div class="card__body">
      ${MULTI_CHAIN && chainOf(p) !== state.chain ? chainTag(p) : ''}
      <div class="card__name">${esc(p.name)}</div>
      <div class="card__price">
        <span class="price ${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} <small>₴/${esc(p.unit)}</small></span>
        ${p.oldPrice ? `<span class="old">${fmtPrice(p.oldPrice)}</span>` : ''}
        ${perHtml(p)}
      </div>
      ${p.cardPrice ? `<div class="atbcard" title="Ціна при оплаті карткою АТБ">${CARD_ICON}<b>${fmtPrice(p.cardPrice)}</b> з карткою</div>` : ''}
      <div class="card__flags">${extra}${flags}</div>
      ${p._view || p.from || !showTileVs() ? '' : vsTileHtml(p)}
    </div>
  </a>`;
}

const skeleton = (n = 12) =>
  `<p class="count">&nbsp;</p><div class="grid">${'<div class="card skeleton"><div class="card__media"></div><div class="card__body"><div class="sk"></div><div class="sk" style="width:60%"></div><div class="sk" style="width:40%;height:18px;margin-top:8px"></div></div></div>'.repeat(n)}</div>`;

// ---------- Що змінилося ----------
// changes.json будує scraper/changes.js: зміни останнього збору відносно попереднього дня.

const changeKind = (c) => (!c.fromOld && c.toOld ? 'sale' : c.fromOld && !c.toOld ? 'saleEnd' : c.to < c.from ? 'down' : 'up');
// Українські форми числівника: 1 товар, 2 товари, 5 товарів.
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
const pctChange = (c) => (c.to / c.from - 1) * 100;

const bySaleWas = (a, b) => a.c.from / a.c.fromOld - b.c.from / b.c.fromOld;

function todayData() {
  const ch = state.changes;
  if (!ch) return null;
  const rows = ch.prices.map((c) => ({ c, p: state.byId.get(c.id), kind: changeKind(c) })).filter((r) => r.p);
  const tabs = [
    // Лише звичайне здешевлення: без акції ні до, ні після (акції — окрема вкладка «Нові акції»).
    ['down', '↓ Подешевшало', rows.filter((r) => r.c.to < r.c.from && !r.c.fromOld && !r.c.toOld).sort((a, b) => pctChange(a.c) - pctChange(b.c))],
    // Лише звичайне подорожчання: без акції ні до, ні після (кінець акції — окрема вкладка «Акція закінчилась»).
    ['up', '↑ Подорожчало', rows.filter((r) => r.c.to > r.c.from && !r.c.fromOld && !r.c.toOld).sort((a, b) => pctChange(b.c) - pctChange(a.c))],
    // Акція з'явилась або змінились її умови (інша акційна ціна) — від найбільшої знижки.
    ['sale', '% Нові акції', rows.filter((r) => r.kind === 'sale' || (r.c.fromOld && r.c.toOld)).sort((a, b) => discount(b.p) - discount(a.p))],
    // Нові акції, де ціна не нижча (з допуском), ніж на попередній акції за 30 днів до цієї.
    ['repeat', '🔁 Повторні акції', rows.filter((r) => (r.kind === 'sale' || (r.c.fromOld && r.c.toOld)) && r.p.min30Sale && dishonest(r.p)).sort((a, b) => discount(b.p) - discount(a.p))],
    // Акція закінчилась і ціна змінилась (зазвичай повернулась до звичайної) — від найбільшої колишньої знижки.
    ['saleEnd', '⌛ Акція закінчилась', rows.filter((r) => r.kind === 'saleEnd' && r.c.to !== r.c.from && r.c.to <= r.c.fromOld).sort(bySaleWas)],
    // Після акції ціна вища, ніж «ціна до знижки» під час акції, — фактичне подорожчання. Від найбільшого.
    ['saleUp', '⇧ Дорожче, ніж до акції', rows.filter((r) => r.kind === 'saleEnd' && r.c.to !== r.c.from && r.c.to > r.c.fromOld).sort((a, b) => b.c.to / b.c.fromOld - a.c.to / a.c.fromOld)],
    // Акція «закінчилась», але ціна та сама — прибрали лише закреслену «ціну до знижки».
    ['saleKept', '＝ Ціна після акції та сама', rows.filter((r) => r.kind === 'saleEnd' && r.c.to === r.c.from).sort(bySaleWas)],
    ['new', '✦ Нові товари', ch.added.map((id) => ({ p: state.byId.get(id) })).filter((r) => r.p)],
  ];
  return { date: ch.date, tabs };
}

function todayBanner() {
  const d = todayData();
  if (!d) return '';
  const n = (k) => d.tabs.find((t) => t[0] === k)[2].length;
  // На телефоні лишаються тільки значки з числами — підписи (tb__w) ховає CSS, повний текст у title.
  // ↓ і ↑ зрозумілі й без підпису — їм він не потрібен навіть на комп'ютері.
  const part = (k, icon, words, cls = '', label = true) => {
    const v = n(k);
    return v && `<span${cls ? ` class="${cls}"` : ''} title="${v} ${words}"><i class="tb__i">${icon}</i>${v}${label ? `<span class="tb__w"> ${words}</span>` : ''}</span>`;
  };
  const parts = [
    part('down', '↓', plural(n('down'), 'товар подешевшав', 'товари подешевшали', 'товарів подешевшало'), 'tb__down', false),
    part('up', '↑', plural(n('up'), 'товар подорожчав', 'товари подорожчали', 'товарів подорожчало'), 'tb__up', false),
    part('sale', '%', plural(n('sale'), 'нова акція', 'нові акції', 'нових акцій')),
    part('repeat', '🔁', plural(n('repeat'), 'повторна акція', 'повторні акції', 'повторних акцій')),
    part('saleEnd', '⌛', plural(n('saleEnd'), 'акція закінчилась', 'акції закінчились', 'акцій закінчилось')),
    part('saleUp', '⇧', 'дорожче, ніж до акції', 'tb__up'),
    part('saleKept', '＝', 'без зміни ціни після акції'),
    part('new', '✦', plural(n('new'), 'новий товар', 'нові товари', 'нових товарів')),
  ].filter(Boolean);
  if (!parts.length) return '';
  return `<a class="today-banner" href="#/today"><b>Що змінилося ${fmtDate(parseDate(d.date), false)}</b>${parts.join('')}<span class="today-banner__go"><span class="tb__w">Переглянути </span>→</span></a>`;
}

// Сортування в «Що змінилося». Вкладки вже впорядковані від найбільшої зміни (чи знижки) —
// «change-desc» лишає цей порядок, «change-asc» перевертає його.
const TODAY_SORTS = {
  'change-desc': ['Спершу найбільша зміна'],
  'change-asc': ['Спершу найменша зміна', 'reverse'],
  'price-asc': ['Спершу дешевші', (a, b) => a.price - b.price],
  'price-desc': ['Спершу дорожчі', (a, b) => b.price - a.price],
  'per-asc': ['Дешевші за кг/л/шт', (a, b) => (a._per?.price ?? Infinity) - (b._per?.price ?? Infinity)],
  name: ['За назвою', (a, b) => a.name.localeCompare(b.name, 'uk')],
};
let todaySort = 'change-desc';
try {
  todaySort = sessionStorage.getItem('todaySort') || todaySort;
} catch {}
if (!TODAY_SORTS[todaySort]) todaySort = 'change-desc'; // зокрема колишні «change» і «discount»

// Картка у вкладці «Що змінилося» k (і в блоках бета-головної).
function todayTile(k, r) {
  return card(
    r.p,
    // У «Нові акції» і «Повторні акції» стара ціна вже видна закресленою — позначка «було» там зайва.
    // У «Дорожче, ніж до акції» «було» — це ціна до знижки, з якою й порівнюємо.
    k === 'saleUp' ? r.c.fromOld : r.c && r.c.to !== r.c.from && k !== 'sale' && k !== 'repeat' ? r.c.from : undefined,
    k === 'saleUp'
      ? `<span class="tag tag--warn tag--wrap" title="Під час акції: ${fmtPrice(r.c.from)} грн замість ${fmtPrice(r.c.fromOld)} грн; тепер ${fmtPrice(r.c.to)} грн"><span>⇧ Була акція −${pct(r.c.from, r.c.fromOld)}%</span> <span>${fmtPrice(r.c.from)} грн</span></span>`
      : r.kind === 'saleEnd' && (k === 'saleEnd' || k === 'saleKept')
        ? `<span class="tag tag--warn" title="Акційна ціна була ${fmtPrice(r.c.from)} грн замість ${fmtPrice(r.c.fromOld)} грн${r.c.to === r.c.from ? '; після акції ціна не змінилась' : ''}">⌛ ${
            r.c.to === r.c.from ? `акція −${pct(r.c.from, r.c.fromOld)}% скінчилась` : `була акція −${pct(r.c.from, r.c.fromOld)}%`
          }</span>`
        : '',
  );
}

// ---------- Головна зі змінами за сьогодні ----------
// На головній — мапа рівня цін і блоки змін за останній збір; усі товари з пошуком, фільтрами й сортуванням —
// на #/all (відкривається натисканням на пошук). ?beta=0 повертає стару головну зі списком усіх товарів
// (запам'ятовується в браузері), ?beta=1 — знову нову.
const BETA = (() => {
  const v = new URLSearchParams(location.search).get('beta');
  if (v != null) store.set('beta', v === '0' ? '0' : '1');
  return store.get('beta') !== '0';
})();
const isHome = () => BETA && (location.hash === '' || location.hash === '#/' || location.hash === '#');
const HOME_BLOCK = 8;

// Мапа на бета-головній: на скільки % у кожному місті дорожче чи дешевше за середній рівень цін по всіх містах
// (avg у data/compare/index.json); не залежить від вибраного міста — воно лише виділене.
// Джерело — data/levels.json (одноразовий знімок усіх міст АТБ, scraper/snapshot.js); якщо його немає —
// щоденний індекс наших міст (avg у data/compare/index.json).
let priceLevels;
const loadLevels = () =>
  (priceLevels ||= fetch('data/levels.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(async (lv) => {
      if (lv?.cities?.length) return lv;
      const idx = await fetch('data/compare/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!idx?.avg) return null;
      const at = new Map(idx.cities.map((slug, i) => [slug, i]));
      return { cities: state.cities.filter((c) => at.has(c.slug)).map((c) => ({ ...c, v: idx.avg[at.get(c.slug)] })) };
    }));
const fmtPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${String(Math.abs(v).toFixed(1)).replace('.', ',')}%`;

// Історія знімків: data/levels/index.json — дати, data/levels/<дата>.json — знімок того тижня.
let levelWeeks;
const loadWeeks = () =>
  (levelWeeks ||= fetch('data/levels/index.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []));
const weekCache = new Map();
const loadWeek = (date) => {
  if (!weekCache.has(date)) weekCache.set(date, fetch(`data/levels/${date}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return weekCache.get(date);
};

// ТЕСТ: рівень цін у містах для Сільпо (будує scraper/silpo-snapshot.js).
let silpoLevels;
const loadSilpoLevels = () =>
  !MULTI_CHAIN ? Promise.resolve(null) : (silpoLevels ||= fetch('data/chains/silpo/levels.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null));

async function renderHomeMap(el) {
  const [lv0, map, weeks, slv] = await Promise.all([loadLevels(), loadMap().catch(() => null), loadWeeks(), loadSilpoLevels()]);
  if (!el.isConnected) return;
  if (!map || !lv0) return el.remove();
  // Мережа на мапі: типово — вибрана в шапці; перемикач поруч дає подивитись і іншу (повзунок тижнів — лише АТБ).
  const levelsOf = { atb: lv0, ...(slv?.cities?.length ? { silpo: slv } : {}) };
  let chain = levelsOf[state.chain] ? state.chain : 'atb';
  // Дані тижня (перераховуються, коли повзунком вибирають інший тиждень).
  // Кожен пункт — і місто (c), і його значення (r.v); наші щоденні міста мають slug.
  let lv, list, lo, hi, span, tone, pts, here, sums;
  const setData = (data) => {
    lv = data;
    list = lv.cities.filter((x) => x.lat != null);
    const vals = list.map((x) => x.v);
    lo = Math.min(...vals);
    hi = Math.max(...vals);
    // Насиченість кольору — однакова для однакового відхилення в обидва боки (зелений — дешевше, сірий — як
    // у середньому, червоний — дорожче), тому span — найбільше відхилення; шкала ж показує справжні мінімум і максимум.
    span = Math.max(-lo, hi, 0.5);
    tone = (v) =>
      v <= 0
        ? `color-mix(in oklab, var(--good) ${Math.round(Math.min(1, -v / span) * 100)}%, var(--map-mid))`
        : `color-mix(in oklab, var(--sale) ${Math.round(Math.min(1, v / span) * 100)}%, var(--map-mid))`;
    pts = list.map((x) => ({ c: x, r: x, xy: mapXY(map, x) }));
    here = list.find((x) => x.slug === state.city.slug);
    sums = new Map();
    for (const { r, xy } of pts) {
      const i = regionAt(map, xy);
      const s = sums.get(i) || [0, 0];
      sums.set(i, [s[0] + r.v, s[1] + 1]);
    }
  };
  setData(levelsOf[chain]);
  // Наближення: k — масштаб, tx/ty — зсув (у координатах мапи). Області масштабуються,
  // а точки й підписи малюються заново на нових місцях і лишаються сталого розміру на екрані.
  const view = { k: 1, tx: 0, ty: 0 };
  const K_MAX = 8;
  // Назви областей — завжди (на телефоні — з наближення OBLAST_LABELS_AT, бо без нього вони там злипаються);
  // назви міст — при наближенні (наші міста раніше, малі пункти — пізніше). Ваше місто підписане завжди.
  const OBLAST_LABELS_AT = 2;
  const NARROW = 600; // ширина мапи на екрані, px, нижче якої — «телефон»
  const CITY_LABELS_AT = 2;
  const SMALL_LABELS_AT = 3;
  const marksHtml = (m, px) => {
    const { k, tx, ty } = view;
    // Назви областей на маленькому екрані без наближення — дрібніші (8,5 px), щоб не налазили одна на одну.
    const mo = Math.min(m, Math.max(1, (8.5 + 3 * (k - 1)) / (11.5 * px)));
    const vis = pts
      .map((p) => ({ ...p, xy: [p.xy[0] * k + tx, p.xy[1] * k + ty] }))
      .filter(({ xy: [x, y] }) => x > -20 && y > -20 && x < map.w + 20 && y < map.h + 20);
    const all = map.w * px >= NARROW || k >= OBLAST_LABELS_AT ? map.names || [] : [];
    const box = ({ name, x, y }) => {
      const w = name.length * 6.6 * mo;
      return [x - w / 2, y - 9 * mo, x + w / 2, y + 5 * mo];
    };
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    // Назву, що налазила б на вже поставлену, пропускаємо.
    const oblasts = [];
    const oblastBoxes = [];
    for (const [i, name] of all.entries()) {
      const o = name && map.labels[i] && { name, x: map.labels[i][0] * k + tx, y: map.labels[i][1] * k + ty };
      if (!o || o.x <= 0 || o.y <= 0 || o.x >= map.w || o.y >= map.h) continue;
      const b = box(o);
      if (oblastBoxes.some((x) => hit(x, b))) continue;
      oblasts.push(o);
      oblastBoxes.push(b);
    }
    const labels = placeLabels(
      vis.map((p) => (p.c === here || (p.c.slug ? k >= CITY_LABELS_AT : k >= SMALL_LABELS_AT) ? p : { ...p, r: null })),
      here,
      map,
      (c, r) => Math.max(c.name.length * 7.2, fmtPct(r.v).length * 9.5),
      m,
      oblastBoxes,
    );
    // Назву області, на яку налазить підпис вашого міста, ховаємо — підпис важливіший.
    const hb = labels.hereBox;
    const oblastHtml = oblasts
      .filter((o, i) => !hb || !hit(oblastBoxes[i], hb))
      .map(({ name, x, y }) => `<text class="umap__oblast" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${mo.toFixed(3)})" text-anchor="middle">${esc(name)}</text>`)
      .join('');
    // Точки: на всій мапі — пропорційні мапі (на телефоні дрібні, щоб не зливались), з наближенням ростуть до
    // екранного розміру підписів; md — їхній масштаб, m — масштаб підписів.
    const md = Math.min(m, Math.max(1, k));
    return vis
      .sort((a, b) => !!a.c.slug - !!b.c.slug || (a.c === here) - (b.c === here)) // наші міста й ваше — зверху
      .map(({ c, r, xy: [x, y] }) => {
        const lb = labels.get(c);
        const text = lb
          ? `<text class="mcity__label" x="${lb[0]}" y="${lb[1]}" text-anchor="${lb[2]}"><tspan class="mcity__name" x="${lb[0]}">${esc(c.name)}</tspan><tspan class="mcity__price" x="${lb[0]}" dy="17">${fmtPct(r.v)}</tspan></text>`
          : '';
        return `<g class="mcity${r === here ? ' is-here' : ''}${c.slug ? '' : ' mcity--small'}" data-i="${list.indexOf(c)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" style="--tone:${tone(r.v)}">
            <g transform="scale(${md.toFixed(3)})">${r === here ? '<circle class="mcity__ring" r="15"/>' : ''}<circle class="mcity__dot" r="${c.slug ? 9 : 5}"/></g>${text ? `<g transform="scale(${m.toFixed(3)})">${text}</g>` : ''}</g>`;
      })
      .join('') + oblastHtml; // назви областей — поверх точок
  };
  const verdict = (v) => (Math.abs(v) < 0.5 ? 'приблизно як у середньому' : `на ${fmtPct(v).slice(1)} ${v < 0 ? 'дешевше' : 'дорожче'} за середнє`);
  const summaryHtml = () => {
    const sorted = [...list].sort((a, b) => a.v - b.v);
    const [cheap, dear] = [sorted[0], sorted.at(-1)];
    return `Найдешевше — ${esc(cheap.name)} (${fmtPct(cheap.v)}), найдорожче — ${esc(dear.name)} (${fmtPct(dear.v)}).${
      here ? ` У місті ${esc(state.city.name)} — ${verdict(here.v)}.` : ''
    }`;
  };
  const noteHtml = () =>
    chain === 'silpo'
      ? `Відсоток — на скільки поточні ціни Сільпо (з акціями) у місті вищі чи нижчі за середні по ${list.length} ${plural(list.length, 'місту', 'містах', 'містах')}, де є Сільпо, за спільними товарами; по одному магазину в кожному місті.${
          lv.date ? ` Знімок за ${fmtDate(parseDate(lv.date))}: молочні продукти, напої, хліб, ковбаси, кава й чай, побутова хімія.` : ''
        } Колір області — середнє її міст.`
      : `Відсоток — на скільки поточні ціни (з акціями) у місті вищі чи нижчі за середні по ${list.length} ${plural(list.length, 'місту', 'містах', 'містах')}, за спільними товарами; по одному магазину в кожному місті.${
          lv.date ? ` Знімок за ${fmtDate(parseDate(lv.date))}: молочні продукти, напої, хліб, ковбаси, кава й чай, побутова хімія.` : ''
        } Колір області — середнє її міст.`;
  // Повзунок тижнів — коли знімків щонайменше два; типово — останній.
  const weekAt = Math.max(0, weeks.indexOf(lv0.date));
  const weeksHtml =
    weeks.length > 1
      ? `<div class="umap__weeks">
          <input type="range" min="0" max="${weeks.length - 1}" step="1" value="${weekAt}" aria-label="Тиждень">
          <span class="umap__week"></span>
        </div>`
      : '';
  el.innerHTML = `<div class="panel__head"><h2>Рівень цін у містах</h2>${
    levelsOf.silpo
      ? `<div class="seg map-chain" role="group" aria-label="Мережа">${Object.keys(levelsOf)
          .map((k) => `<button type="button" data-chain="${k}" aria-pressed="${k === chain}">${CHAINS[k]}</button>`)
          .join('')}</div>`
      : ''
  }</div>
    <p class="compare__summary">${summaryHtml()}</p>
    <div class="umap umap--zoom">
      <svg viewBox="0 0 ${map.w} ${map.h}" role="img" aria-label="Мапа: різниця цін між містами">
        <g class="umap__regions">${map.regions.map((d) => `<path d="${d}"/>`).join('')}</g>
        <g class="umap__marks"></g>
      </svg>
      <div class="umap__zoom">
        <button type="button" data-z="in" aria-label="Наблизити">+</button>
        <button type="button" data-z="out" aria-label="Віддалити">−</button>
        <button type="button" data-z="reset" aria-label="Уся мапа" hidden>⟲</button>
      </div>
      <div class="tip umap__tip" hidden></div>
    </div>
    ${weeksHtml}
    <div class="umap__legend">
      <span class="umap__scale"><b class="umap__lo"></b><i aria-hidden="true"></i><b class="umap__hi"></b></span>
      <span><i class="lg-here" aria-hidden="true"></i>ваше місто</span>
    </div>
    <p class="note umap__note"></p>`;
  const svg = el.querySelector('svg');
  const tip = el.querySelector('.umap__tip');
  const regionsG = svg.querySelector('.umap__regions');
  const marksG = svg.querySelector('.umap__marks');
  const resetBtn = el.querySelector('[data-z=reset]');
  const draw = () => {
    if (!svg.isConnected) return;
    // Скільки екранних пікселів в одиниці мапи; точки й підписи — не дрібніші, ніж на комп'ютері.
    const px = svg.clientWidth / map.w || 1;
    const m = Math.max(1, 0.9 / px);
    regionsG.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    marksG.innerHTML = marksHtml(m, px);
    resetBtn.hidden = view.k === 1;
    // Поки мапу не наблизили, один палець прокручує сторінку; після — рухає мапу.
    svg.style.touchAction = view.k > 1 ? 'none' : 'pan-y';
  };
  let raf = 0;
  const redraw = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
  };
  const clampView = () => {
    view.tx = Math.min(0, Math.max(map.w * (1 - view.k), view.tx));
    view.ty = Math.min(0, Math.max(map.h * (1 - view.k), view.ty));
  };
  // Наблизити в f разів довкола точки (x, y) у координатах екрана мапи.
  const zoomAt = (x, y, f) => {
    const k = Math.min(K_MAX, Math.max(1, view.k * f));
    view.tx = x - ((x - view.tx) * k) / view.k;
    view.ty = y - ((y - view.ty) * k) / view.k;
    view.k = k;
    clampView();
    tip.hidden = true;
    redraw();
  };
  const toMap = (cx, cy) => {
    const b = svg.getBoundingClientRect();
    return [((cx - b.left) / b.width) * map.w, ((cy - b.top) / b.height) * map.h];
  };
  el.querySelector('.umap__zoom').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'reset') {
      Object.assign(view, { k: 1, tx: 0, ty: 0 });
      tip.hidden = true;
      redraw();
    } else if (z) zoomAt(map.w / 2, map.h / 2, z === 'in' ? 2 : 0.5);
  });
  // Колесо миші — з Ctrl (щоб звичайна прокрутка сторінки не наближала мапу) або коли мапу вже наближено.
  svg.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && view.k === 1) return;
      e.preventDefault();
      zoomAt(...toMap(e.clientX, e.clientY), Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  svg.addEventListener('dblclick', (e) => zoomAt(...toMap(e.clientX, e.clientY), 2));
  // Перетягування й «щипок» двома пальцями.
  const ptrs = new Map();
  let moved = false;
  let pinch = null;
  svg.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
    }
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    if (ptrs.size === 2 && pinch) {
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(...toMap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), d / pinch.d);
      pinch.d = d;
      moved = true;
      return;
    }
    if (view.k === 1) return;
    const dx = e.clientX - prev[0];
    const dy = e.clientY - prev[1];
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) svg.setPointerCapture(e.pointerId);
    moved = true;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    const b = svg.getBoundingClientRect();
    view.tx += (dx / b.width) * map.w;
    view.ty += (dy / b.height) * map.h;
    clampView();
    tip.hidden = true;
    redraw();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  addEventListener('resize', redraw);
  // Кольори областей, підсумок, шкала й примітка — під дані вибраного тижня.
  const paint = () => {
    regionsG.querySelectorAll('path').forEach((path, i) => {
      const s = sums.get(i);
      path.style.setProperty('--rtone', s ? tone(s[0] / s[1]) : '');
    });
    el.querySelector('.compare__summary').innerHTML = summaryHtml();
    el.querySelector('.umap__lo').textContent = fmtPct(lo);
    el.querySelector('.umap__hi').textContent = fmtPct(hi);
    // Сірий (0%) — на своєму місці між мінімумом і максимумом.
    const zero = hi > lo ? Math.min(100, Math.max(0, (-lo / (hi - lo)) * 100)) : 50;
    el.querySelector('.umap__scale i').style.background = `linear-gradient(90deg, ${tone(lo)}, var(--map-mid) ${zero.toFixed(0)}%, ${tone(hi)})`;
    el.querySelector('.umap__note').innerHTML = noteHtml();
    const weeksBar = el.querySelector('.umap__weeks');
    if (weeksBar) weeksBar.hidden = chain !== 'atb';
    const week = el.querySelector('.umap__week');
    if (week) week.textContent = `тиждень ${fmtDate(parseDate(lv.date))}${lv.date === weeks.at(-1) ? ' (останній)' : ''}`;
    tip.hidden = true;
    draw();
  };
  el.querySelector('.map-chain')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chain]');
    if (!b || b.dataset.chain === chain) return;
    chain = b.dataset.chain;
    for (const x of el.querySelectorAll('.map-chain button')) x.setAttribute('aria-pressed', x === b);
    const slider = el.querySelector('.umap__weeks input');
    // АТБ — з останнього тижня.
    setData(levelsOf[chain]);
    if (slider) slider.value = weekAt;
    paint();
  });
  const slider = el.querySelector('.umap__weeks input');
  if (slider) {
    slider.addEventListener('input', async () => {
      const date = weeks[slider.value];
      const data = date === lv0.date ? lv0 : await loadWeek(date);
      if (!data || weeks[slider.value] !== date || !el.isConnected) return;
      setData(data);
      paint();
    });
  }
  paint();
  const show = (g) => {
    const r = list[g.dataset.i];
    tip.innerHTML = `<b>${esc(r.name)}</b>${r === here ? ' (ваше місто)' : ''}<br>${verdict(r.v)}`;
    tip.hidden = false;
    const box = el.querySelector('.umap').getBoundingClientRect();
    const dot = g.querySelector('.mcity__dot').getBoundingClientRect();
    const cx = dot.left + dot.width / 2 - box.left;
    tip.style.left = `${Math.min(Math.max(cx, tip.offsetWidth / 2 + 4), box.width - tip.offsetWidth / 2 - 4)}px`;
    tip.style.top = `${dot.top - box.top - 10}px`; // над точкою, з проміжком під курсор
  };
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || ptrs.size) return;
    const g = e.target.closest('.mcity');
    if (g) show(g);
    else tip.hidden = true;
  });
  svg.addEventListener('pointerleave', () => (tip.hidden = true));
  svg.addEventListener('click', (e) => {
    if (moved) return; // це було перетягування
    const g = e.target.closest('.mcity');
    if (g) show(g);
    else tip.hidden = true;
  });
}

function renderHome() {
  const top = document.querySelector('.top');
  top.classList.remove('is-product');
  top.classList.add('is-home');
  document.title = 'Жаба — історія цін';
  const d = todayData();
  const tabs = d ? d.tabs.filter((t) => t[2].length) : [];
  const all = `<a class="home-all" href="#/all">Усі товари <b>${state.products.length.toLocaleString('uk')}</b> →</a>`;
  // «Траш!» — лише акції (кілька сотень), тож на його головній — плитки всіх акцій, найбільші знижки першими.
  const offers =
    state.chain === 'thrash'
      ? `<section class="home-block"><div class="section-head"><h2>Усі акції «Траш!» <small>${state.products.length}</small></h2></div>
          <div class="grid">${[...state.products]
            .sort((a, b) => (a.oldPrice ? a.price / a.oldPrice : 1) - (b.oldPrice ? b.price / b.oldPrice : 1))
            .map((p) => card(p))
            .join('')}</div></section>`
      : '';
  // Мапа рівня цін — для мереж з повним каталогом; у «Траш!» лише акції, тож мапи немає.
  const map = state.chain === 'thrash' ? '' : '<section class="panel home-map" id="homeMap"><div class="sk" style="height:320px;border-radius:12px"></div></section>';
  if (!tabs.length) {
    app.innerHTML = `${map}
      ${offers || `<div class="empty"><b>😌</b>${d ? 'Сьогодні ціни не змінилися' : 'Змін поки немає'}<br><span class="note">Знайдіть товар через пошук угорі</span></div>${all}`}`;
    if (map) renderHomeMap($('#homeMap'));
    return;
  }
  const stale = d.date !== state.meta.updated ? ` (останній збір у цьому місті — ${fmtDate(parseDate(state.meta.updated))})` : '';
  app.innerHTML = `${map}
    <div class="home-head"><div><h1 class="page-title">Що змінилося ${fmtDate(parseDate(d.date), false)}</h1>
      <p class="note today-sub">${esc(state.city.name)}: зміни порівняно з попереднім днем${stale}.</p></div>${all}</div>
    ${tabs
      .map(
        ([k, label, list]) => `<section class="home-block">
          <div class="section-head"><h2>${label} <small>${list.length}</small></h2>${list.length > HOME_BLOCK ? `<a href="#/today/${k}">Усі ${list.length} →</a>` : ''}</div>
          <div class="grid">${list.slice(0, HOME_BLOCK).map((r) => todayTile(k, r)).join('')}</div>
        </section>`,
      )
      .join('')}${offers}`;
  if (map) renderHomeMap($('#homeMap'));
}

function renderToday(tab) {
  document.querySelector('.top').classList.add('is-product');
  document.title = 'Що змінилося — Жаба';
  scrollTo(0, 0);
  const d = todayData();
  const head = `<a class="back" href="#/">← ${BETA ? 'Головна' : 'Усі товари'}</a><h1 class="page-title">Що змінилося</h1>`;
  if (!d) {
    app.innerHTML = `${head}<div class="empty"><b>🗓</b>Змін поки немає<br><span class="note">Стрічка з'явиться після наступного щоденного збору цін</span></div>`;
    return;
  }
  const tabs = d.tabs.filter((t) => t[2].length);
  const cur = tabs.find((t) => t[0] === tab) || tabs[0];
  const stale = d.date !== state.meta.updated ? ` (останній збір у цьому місті — ${fmtDate(parseDate(state.meta.updated))})` : '';
  let html = `${head}<p class="note today-sub">${state.city.name}: зміни за ${fmtDate(parseDate(d.date))} порівняно з попереднім днем${stale}.</p>`;
  if (!cur) {
    app.innerHTML = `${html}<div class="empty"><b>😌</b>Ціни не змінилися<br><span class="note">Порівняно з попереднім днем — жодних змін</span></div>`;
    return;
  }
  html += `<div class="today-bar"><div class="today-tabs" role="tablist">${tabs
    .map(([k, label, list]) => `<a href="#/today/${k}" role="tab" aria-selected="${k === cur[0]}">${label} <small>${list.length}</small></a>`)
    .join('')}</div>
    <select id="todaySort" class="pill today-sort" aria-label="Сортування">${Object.entries(TODAY_SORTS)
      .map(([k, [label]]) => `<option value="${k}"${k === todaySort ? ' selected' : ''}>${label}</option>`)
      .join('')}</select></div>`;
  const tile = (r) => todayTile(cur[0], r);
  const sorter = TODAY_SORTS[todaySort][1];
  const list = sorter === 'reverse' ? [...cur[2]].reverse() : sorter ? [...cur[2]].sort((a, b) => sorter(a.p, b.p)) : cur[2];
  // Товари — за розділами каталогу (у порядку каталогу), усередині — за вибраним сортуванням.
  const byGroup = new Map(state.groups.map(([g]) => [g, []]));
  for (const x of list) {
    const g = x.p.group || 'Інше';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(x);
  }
  const groups = [...byGroup].filter(([, xs]) => xs.length);
  html +=
    groups.length > 1
      ? groups
          .map(
            ([g, xs]) => `<section class="today-group">
              <div class="section-head"><h2>${GROUPS.get(g) || '📦'} ${esc(g)} <small>${xs.length}</small></h2></div>
              <div class="grid">${xs.map(tile).join('')}</div>
            </section>`,
          )
          .join('')
      : `<div class="grid">${list.map(tile).join('')}</div>`;
  app.innerHTML = html;
  $('#todaySort').onchange = (e) => {
    todaySort = e.target.value;
    try {
      sessionStorage.setItem('todaySort', todaySort);
    } catch {}
    renderToday(cur[0]);
  };
}

// Секція «Категорії та фільтри»: список розділів і підсумок увімкнених фільтрів для згорнутого вигляду.
function renderGroups() {
  $('#group').innerHTML =
    `<option value="">Усі розділи</option>` +
    state.groups.map(([g, n]) => `<option value="${esc(g)}">${GROUPS.get(g) || '📦'} ${esc(g)} (${n})</option>`).join('');
  $('#group').value = filters.group;
  const active = [
    filters.group && `${GROUPS.get(filters.group) || '📦'} ${filters.group}`,
    filters.cat,
    filters.sale && '% Акції',
    filters.card && state.chain === 'atb' && '💳 З карткою',
    filters.inflated && '⚠ Завищені',
    filters.local && '📍 Тільки у вибраному місті',
  ].filter(Boolean);
  $('#fActive').innerHTML = active.map((a) => `<span>${esc(a)}</span>`).join('');
  $('#fReset').hidden = !active.length;
}

function initFilterPanel() {
  const panel = $('#fpanel');
  const saved = store.get('fpanel');
  // Типово розгорнута на комп'ютері й згорнута на телефоні; далі — як залишив користувач.
  panel.open = saved ? saved === 'open' : innerWidth > 720;
  let autoClosed = false;
  let from = scrollY; // звідки рахувати прокрутку донизу
  panel.addEventListener('toggle', () => {
    // Автозгортання під час прокрутки не міняє збережений вибір.
    if (!autoClosed) store.set('fpanel', panel.open ? 'open' : 'closed');
    autoClosed = false;
    if (panel.open) from = scrollY;
  });
  // На телефоні відкрита секція займає пів екрана — згортаємо її, коли гортають список донизу.
  const phone = matchMedia('(max-width: 520px)');
  addEventListener(
    'scroll',
    () => {
      if (!panel.open || !phone.matches || document.querySelector('.top').classList.contains('is-product')) {
        from = scrollY;
        return;
      }
      if (scrollY < from) from = scrollY;
      else if (scrollY - from > 40) {
        autoClosed = true;
        keepContent(() => (panel.open = false));
      }
    },
    { passive: true },
  );
  // Шапка закріплена: коли секція змінює висоту, вміст під нею зсувається. Повертаємо його на місце
  // (якщо браузер уже сам це зробив — різниця буде нульова).
  const keepContent = (change) => {
    if (scrollY < 1) return change();
    const before = app.getBoundingClientRect().top;
    change();
    requestAnimationFrame(() => {
      const d = app.getBoundingClientRect().top - before;
      if (d) scrollBy(0, d);
      from = scrollY;
    });
  };
  panel.querySelector('summary').addEventListener('click', (e) => {
    e.preventDefault();
    keepContent(() => (panel.open = !panel.open));
  });
  $('#group').addEventListener('change', (e) => {
    filters.group = e.target.value;
    filters.cat = '';
    fillCategories();
    applyFilters();
  });
  $('#fReset').onclick = () => {
    Object.assign(filters, { group: '', cat: '', sale: false, card: false, inflated: false, local: false });
    for (const id of ['#sale', '#card', '#inflated', '#local']) $(id).checked = false;
    fillCategories();
    applyFilters();
  };
}

function renderList() {
  document.querySelector('.top').classList.remove('is-product', 'is-home');
  document.title = 'Жаба — історія цін';
  const q = filters.q.trim();
  if (isBarcode(q) && state.barcode?.q !== q) {
    app.innerHTML = skeleton(4);
    lookupBarcode(q).then(({ hits, name }) => {
      if (filters.q.trim() !== q) return;
      state.barcode = { q, hits, name };
      renderList();
    });
    return;
  }
  const list = filtered();
  renderGroups();
  if (!list.length) {
    const known = isBarcode(q) && state.barcode?.name;
    const why = isBarcode(q)
      ? known
        ? `Штрихкод ${esc(q)} — «${esc(known)}», але ${MULTI_CHAIN ? `у мережах міста ${esc(state.city.name)}` : 'в АТБ'} такого товару не знайшлося.`
        : `Штрихкоду ${esc(q)} немає в нашому покажчику. АТБ штрихкодів не публікує — товари АТБ знаходяться через такий самий товар інших мереж.`
      : filters.inflated
        ? 'Акцій із завищеною «ціною до знижки» тут поки не виявлено'
        : 'Спробуйте іншу назву або приберіть фільтри';
    app.innerHTML = `${BETA ? '<a class="back" href="#/">← Головна</a>' : filters.q ? '' : todayBanner()}<div class="empty"><b>🔍</b>Нічого не знайдено<br><span class="note">${why}</span></div>`;
    return;
  }
  let count = `${isBarcode(q) ? `За штрихкодом ${esc(q)}` : 'Знайдено'}: ${list.length.toLocaleString('uk')}`;
  const perUnitSort = PER_SORT[filters.sort];
  if (perUnitSort) {
    const n = list.filter((p) => perIn(p, perUnitSort) != null).length;
    count += ` · з ціною за 1 ${perUnitSort}: ${n.toLocaleString('uk')}`;
  }
  app.innerHTML = `${BETA ? '<a class="back" href="#/">← Головна</a>' : filters.q ? '' : todayBanner()}<div class="count-row"><p class="count">${count}</p><span id="sortSlot"></span></div>
    <div class="grid" id="grid">${list.slice(0, state.shown).map((p) => card(p)).join('')}</div>
    ${list.length > state.shown ? '<button class="more" id="more">Показати ще</button>' : ''}`;
  $('#sortSlot').replaceWith(sortEl);
  placeAds($('#grid'));
  const more = $('#more');
  if (more) {
    more.onclick = () => {
      state.shown += PAGE;
      const y = scrollY;
      renderList();
      scrollTo(0, y);
    };
    // Автопідвантаження при прокрутці до кінця.
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) {
        obs.disconnect();
        more.click();
      }
    }, { rootMargin: '600px' }).observe(more);
  }
}

// ---------- Реклама (тестовий банер) ----------
// Лише на телефоні (сітка ≤ ADS.wideCols колонок) і лише в загальному списку (не в «Обраному», «Що змінилося»
// і на сторінці товару): банер на всю ширину, заввишки як картка товару.
// Перший — після ADS.firstRows рядів, далі — кожні ADS.everyRows рядів.
const ADS = { firstRows: 3, everyRows: 5, wideCols: 2 };

const adTile = () => `<aside class="card ad ad--wide" aria-label="Реклама">
    <span class="ad__mark">Реклама</span>
    <div class="ad__media"><span aria-hidden="true">📣</span></div>
    <div class="card__body">
      <div class="ad__title">Тут може бути ваша реклама</div>
      <div class="note">Тестовий рекламний блок Жаби</div>
      <span class="ad__btn">Дізнатися більше</span>
    </div>
  </aside>`;

function placeAds(grid) {
  if (!grid) return;
  let cols = 0;
  // Банер на всю ширину — заввишки як картка товару в сусідньому ряду.
  const fitWide = () => {
    const h = grid.querySelector('.card:not(.ad)')?.offsetHeight;
    for (const el of grid.querySelectorAll('.ad--wide')) el.style.height = h ? `${h}px` : '';
  };
  const place = () => {
    if (!grid.isConnected) return ro.disconnect(); // список перемальовано — ця сітка вже не потрібна
    const n = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    if (n === cols) return fitWide();
    cols = n;
    for (const el of grid.querySelectorAll('.ad')) el.remove();
    const cards = [...grid.children];
    if (cols > ADS.wideCols) return; // на широких екранах реклами немає
    for (let i = ADS.firstRows * cols; i < cards.length; i += ADS.everyRows * cols) {
      cards[i].insertAdjacentHTML('beforebegin', adTile());
    }
    fitWide();
  };
  const ro = new ResizeObserver(place);
  place();
  ro.observe(grid);
}

// ---------- Сторінка товару ----------

const RANGES = [
  ['1м', 30],
  ['3м', 91],
  ['6м', 182],
  ['Рік', 365],
  ['Усе', Infinity],
];

// Мітки з сайту АТБ: знижка («-20% до 27.10») і рекламні кампанії, які на АТБ мають лише
// короткий значок («DC») з підказкою («Безмежний всесвіт DC») — показуємо підказку.
const KNOWN_HINTS = { DC: 'Безмежний всесвіт DC' }; // для даних, зібраних до появи поля labels
function labelsHtml(p) {
  const labels = p.labels || (p.label ? [{ text: p.label, hint: KNOWN_HINTS[p.label] }] : []);
  return labels
    .map((l) =>
      l.hint
        ? `<span class="product__promo" title="Рекламна кампанія АТБ">🎁 ${esc(l.hint)}</span>`
        : `<span class="product__label">${esc(l.text)}</span>`,
    )
    .join('');
}

// Картка товару в іншому місті (#/p/<id>/<місто>) — з мапи «Ціна в інших містах»; вибране місто не змінюється.
const cityCatalogs = new Map();
async function cityProduct(slug, id) {
  if (!cityCatalogs.has(slug)) {
    cityCatalogs.set(
      slug,
      fetch(`data/cities/${slug}/products.json`)
        .then((r) => r.json())
        .then((list) => new Map(list.map((x) => [x.id, x])))
        .catch(() => new Map()),
    );
  }
  const base = (await cityCatalogs.get(slug)).get(id);
  return base && { ...base, from: slug, _view: true, _per: perUnit(base) };
}

let productSeq = 0;
// Чесна знижка на сторінці товару. Якщо «ціну до знижки» вже завищено, а мінімум за 30 днів — та сама
// звичайна ціна перед акцією, рамка нічого не додала б до попередження про завищену акцію.
function honestBox(p) {
  const h = honestPct(p);
  if (h == null || (isInflated(p.oldPrice, p.regular) && p.min30 >= p.regular * 0.995)) return '';
  const ok = !dishonest(p);
  const when = p.min30At ? ` (${fmtDate(parseDate(p.min30At))})` : '';
  const what = ok
    ? `Найнижча ціна за 30 днів до акції — <b>${fmtPrice(p.min30)} грн</b>${when}. Знижка чесна: <b>−${h}%</b>.`
    : p.min30Sale
      ? `Повторна акція: ${p.min30At ? fmtDate(parseDate(p.min30At)) : 'нещодавно'} товар уже продавався на акції за <b>${fmtPrice(p.min30)} грн</b>. ${realDiscount(p.price, p.min30)}, а не ${Math.round(discount(p) * 100)}%.`
      : `Найнижча ціна за 30 днів до акції — <b>${fmtPrice(p.min30)} грн</b>${when}. ${realDiscount(p.price, p.min30)}, а не ${Math.round(discount(p) * 100)}%.`;
  return `<p class="${ok ? 'ok-box' : 'warn-box'}"><b>${ok ? '✓' : p.min30Sale ? '🔁' : '⚠'}</b><span>${what}</span></p>`;
}

async function renderProduct(id, slug) {
  document.querySelector('.top').classList.add('is-product');
  const seq = ++productSeq;
  scrollTo(0, 0);
  let p = state.byId.get(id);
  if (slug && slug !== state.city.slug) {
    const own = p;
    app.innerHTML = `${backLink()}<div class="sk" style="height:320px;border-radius:12px"></div>`;
    p = await cityProduct(slug, id);
    if (seq !== productSeq) return;
    if (!p) {
      app.innerHTML = `${backLink()}<p class="status">У місті ${esc(cityName(slug))} цього товару немає.${own ? ` <a href="#/p/${id}">Показати для міста ${esc(state.city.name)}</a>` : ''}</p>`;
      return;
    }
  }
  if (!p) {
    app.innerHTML = `${backLink()}<p class="status">Товар не знайдено — можливо, його вже немає в каталозі.</p>`;
    return;
  }
  document.title = `${p.name} — Жаба`;
  app.innerHTML = `${backLink()}
    <div class="product">
      <div class="product__media"><img class="product__img" src="${esc(p.img)}" alt=""></div>
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="chips">${chainTag(p)}${[p.group, p.category, p.brand].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        ${
          p._view
            ? `<p class="elsewhere-box">Ціни та історія — з міста <b>${esc(cityName(p.from))}</b>.${state.byId.has(id) ? ` <a href="#/p/${id}">Показати для міста ${esc(state.city.name)}</a>` : ''}</p>`
            : p.from
              ? `<p class="elsewhere-box">Цього товару немає в магазині АТБ у місті ${esc(state.city.name)}. Ціни та історія — з міста <b>${esc(cityName(p.from))}</b>, де він є.</p>`
              : chainOf(p) === 'thrash'
                ? `<p class="elsewhere-box">Акція «Траш!»${p.until ? ` до ${fmtDate(parseDate(p.until), false)}` : ''}, у всіх магазинах мережі. Звичайних цін «Траш!» не публікує — є лише ціна до знижки.</p>`
                : ''
        }
        <div class="product__price">
          <span class="price ${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} <small>грн/${esc(p.unit)}</small></span>
          ${p.oldPrice ? `<span class="old">${fmtPrice(p.oldPrice)}</span>` : ''}
          ${labelsHtml(p)}
          ${lowTag(p)}
          ${p._per && showPer() ? `<span class="product__per">${fmtPrice(p._per.price)} грн за 1 ${p._per.unit}</span>` : ''}
        </div>
        ${p.cardPrice ? `<div class="atbcard atbcard--big">${CARD_ICON}<b>${fmtPrice(p.cardPrice)} грн</b> при оплаті карткою АТБ <span class="note">(−${pct(p.cardPrice, p.price)}%)</span></div>` : ''}
        ${honestBox(p)}
        <div id="warn"></div>
        <div class="product__actions"><span class="fav-actions">${favActions(p)}</span>${cartToggle(p)}<a class="btn btn--primary" href="${CHAIN_SITE[chainOf(p)][0]}${esc(p.url)}" target="_blank" rel="noopener">Відкрити на ${CHAIN_SITE[chainOf(p)][1]} ↗</a></div>
      </div>
    </div>
    <section class="panel">
      <div class="panel__head">
        <h2>Історія ціни</h2>
        <div class="seg ranges" role="group" aria-label="Період">${RANGES.map(([l], i) => `<button data-r="${i}" aria-pressed="${i === 4}">${l}</button>`).join('')}</div>
      </div>
      <div class="chart" id="chart"><div class="sk" style="height:280px;border-radius:12px"></div></div>
      <div id="stats"></div>
    </section>
    ${otherChains(p).length && !p._view ? '<section class="panel vs" id="vs"></section>' : ''}
    ${
      chainOf(p) === 'atb'
        ? `<section class="panel" id="compare">
      <div class="panel__head"><h2>Ціна в інших містах</h2></div>
      <div class="sk" style="height:120px;border-radius:12px"></div>
    </section>`
        : ''
    }`;
  bindFavTarget(p);
  if ($('#vs')) renderChainVs($('#vs'), p);
  if ($('#compare')) renderCompare($('#compare'), p);
  // Користувач побачив поточну ціну — знижка «з обраного» для цього товару вже не нова.
  if (!p._view && isFav(id) && favDrop(p, favs[id])) markSeen([id]);

  const hist = await loadHistory(id, p.from, chainOf(p));
  if (seq !== productSeq || !$('#chart')) return;
  const cur = segments(hist, Infinity).at(-1);
  if (p.oldPrice && cur?.inflated) {
    $('#warn').innerHTML = `<p class="warn-box"><b>⚠</b><span>Ціну до знижки завищено: перед акцією товар коштував <b>${fmtPrice(cur.ref)} грн</b>, а не ${fmtPrice(p.oldPrice)} грн.
      ${realDiscount(p.price, cur.ref)}, а не знижка ${pct(p.price, p.oldPrice)}%.</span></p>`;
  }
  let range = 4;
  const draw = () => {
    renderChart($('#chart'), hist, RANGES[range][1], p.unit);
    renderStats($('#stats'), hist, RANGES[range][1], p.unit);
  };
  for (const b of document.querySelectorAll('.ranges button')) {
    b.onclick = () => {
      range = +b.dataset.r;
      for (const x of document.querySelectorAll('.ranges button')) x.setAttribute('aria-pressed', x === b);
      draw();
    };
  }
  draw();
  const ro = new ResizeObserver(() => $('#chart') && draw());
  ro.observe($('#chart'));
  addEventListener('hashchange', () => ro.disconnect(), { once: true });
}

// ---------- ТЕСТ: порівняння з товаром іншої мережі ----------
// Схожі товари шукаємо за словами назви (перші 5 літер — щоб «моцарела» = «моцарелла», «курячий» = «куряче»),
// брендом і вагою/об'ємом. Вибір користувача — pairs['id>мережа'] = id товару тієї мережі (0 — «не порівнювати»),
// в обидва боки. Старі записи pairs[id] (до вкладок мереж) — пара з мережею, з якою тоді порівнювали (vsOther).
let pairs = {};
try {
  pairs = JSON.parse(store.get('pairs') || '{}');
} catch {}
// Службові слова й упаковка (за першими 5 літерами) — не відрізняють товари.
const MATCH_STOP = new Set(
  'з зі із та і й в у на для без по тм гат шт вагов фасов преміум тетра пляшк стака пакет банка фольг флако фільт мрц тек стери пасте ультр натур упако скло пет об ск бут кор'.split(' '),
);
const matchWords = (p) =>
  (p._w ||= new Set(
    norm(p.name)
      .replace(/[«»"“”()®™,.!+*]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/\d/.test(w) && !w.includes('/'))
      .map((w) => w.slice(0, 5))
      .filter((w) => !MATCH_STOP.has(w)),
  ));
const qtyOf = (p) => (p._qty === undefined ? (p._qty = p.unit === 'кг' ? null : parseWeight(p.name)) : p._qty);
// Вага слова — наскільки воно рідкісне в обох каталогах (IDF): збіг смаку чи бренду важить більше, ніж «йогурт».
let idfFor = null;
let idfMap = new Map();
const idf = (w) => {
  if (idfFor !== state.all) {
    idfFor = state.all;
    idfMap = new Map();
    for (const p of state.all) for (const x of matchWords(p)) idfMap.set(x, (idfMap.get(x) || 0) + 1);
    for (const [x, n] of idfMap) idfMap.set(x, Math.log((state.all.length + 1) / n));
  }
  return idfMap.get(w) ?? Math.log(state.all.length + 1);
};
const sameQty = (qa, qb) => qa.unit === qb.unit && Math.abs(qa.qty / qb.qty - 1) < 0.03;
// Сами вибираємо лише той самий товар: схожа назва й та сама фасовка (або обидва вагові).
// Відсоток у назві (жирність, міцність): «Вершки 33%» і «Вершки 10%» — різні товари, хоч слова й фасовка ті самі.
const pctOf = (p) => (p._pct === undefined ? (p._pct = p.name.match(/(\d+(?:[.,]\d+)?)\s*%/)?.[1].replace(',', '.') ?? null) : p._pct);
// Смак, начинка, м'ясо, колір: «Multicake лимон-крем» і «Multicake кокос-крем», «Дольче манго» і «Дольче полуниця» —
// різні товари, хоч бренд, слова й фасовка ті самі. Слова — за початком; перше слово назви (тип товару: «Карамель»)
// і «карамелізований» не рахуємо. «Молоко» — лише цим словом (смак: «Wafers молоко»), а не «молочний»: «молочно-шоколадний
// з кокосом» і «з кокосом» — той самий батончик.
const VARIANTS = Object.entries({
  банан: 'банан', абрик: 'абрик', перси: 'перси', ябл: 'ябл', груш: 'груш', апель: 'апель', манда: 'манда', лимон: 'лимон',
  лайм: 'лайм', манго: 'манго', ківі: 'ківі', анана: 'анана', кавун: 'кавун', слив: 'слив', вишн: 'вишн', череш: 'череш',
  малин: 'малин', полун: 'полун', суниц: 'полун', ожин: 'ожин', смор: 'смор', журав: 'журав', обліп: 'обліп', брусн: 'брусн',
  грана: 'грана', виног: 'виног', цитр: 'цитр', грейп: 'грейп', ягід: 'ягід', ягод: 'ягід',
  кокос: 'кокос', мигда: 'мигда', фунд: 'фунд', горіх: 'горіх', арах: 'арах', фіст: 'фіст', кешь: 'кешь', ваніл: 'ваніл',
  карам: 'карам', марме: 'марме', згущ: 'згущ', мят: 'мят', кориц: 'кориц', імбир: 'імбир', молоко: 'молоко', какао: 'какао',
  часни: 'часни', цибул: 'цибул', сирн: 'сирн', бекон: 'бекон', папри: 'папри', гостр: 'гостр', томат: 'томат', гриб: 'гриб',
  краб: 'краб', кур: 'кур', ялов: 'ялов', свин: 'свин', індич: 'індич', качк: 'качк', качин: 'качк', кроли: 'кроли',
  телят: 'телят', лосос: 'лосос', тунц: 'тунц', форел: 'форел', оселе: 'оселе',
  світл: 'світл', темн: 'темн', червон: 'червон', рожев: 'рожев', біле: 'біл', біла: 'біл', білий: 'біл',
});
const variantsOf = (p) =>
  (p._var ??= [
    ...new Set(
      norm(p.name)
        .split(/[^a-zа-яіїєґ]+/)
        .filter(Boolean)
        .slice(1)
        .filter((w) => !w.startsWith('карамеліз'))
        .map((w) => VARIANTS.find(([pre]) => w.startsWith(pre))?.[1])
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(' '));
const autoMatch = (a, b, score) => {
  const qa = qtyOf(a);
  const qb = qtyOf(b);
  const pa = pctOf(a);
  const pb = pctOf(b);
  if (pa && pb && +pa !== +pb) return false;
  const va = variantsOf(a);
  const vb = variantsOf(b);
  if (va && vb && va !== vb) return false;
  return score >= MATCH_AUTO && (qa && qb ? sameQty(qa, qb) : !qa && !qb && a.unit === b.unit);
};
function matchScore(a, b) {
  const wa = matchWords(a);
  const wb = matchWords(b);
  let common = 0;
  let sa = 0;
  let sb = 0;
  for (const w of wa) {
    sa += idf(w);
    if (wb.has(w)) common += idf(w);
  }
  if (!common) return 0;
  for (const w of wb) sb += idf(w);
  let s = common / Math.sqrt(sa * sb);
  // Рідкісні слова, яких немає в іншій назві, з обох боків — зазвичай різний смак чи різновид
  // («Lay's зі смаком реберець» і «Lay's зі смаком сиру»).
  s -= (0.8 * Math.min(sa - common, sb - common)) / Math.sqrt(sa * sb);
  // Бренд: однаковий — плюс; різні (і бренду одного немає в назві другого) — це інший товар.
  const ba = a.brand && norm(a.brand).slice(0, 5);
  const bb = b.brand && norm(b.brand).slice(0, 5);
  // (В овочах і фруктах «бренд» в АТБ — країна походження, тож різниця там нічого не каже.)
  if (ba && bb) s += ba === bb ? 0.2 : wa.has(bb) || wb.has(ba) || a.group === 'Овочі та фрукти' ? 0 : -0.3;
  const qa = qtyOf(a);
  const qb = qtyOf(b);
  if (qa && qb) s += sameQty(qa, qb) ? 0.15 : -0.1;
  return s;
}
const MATCH_SHOW = 0.3; // показувати серед схожих
const MATCH_AUTO = 0.9; // вибирати самим, якщо користувач ще не вибрав
// Що порівнюємо: ціну за кг/л, якщо вона відома в обох (і в однакових одиницях), інакше — ціну за упаковку.
function vsBasis(a, b) {
  const per = (p) => (p.unit === 'кг' ? { price: p.price, unit: 'кг' } : p._per);
  const pa = per(a);
  const pb = per(b);
  if (pa && pb && pa.unit === pb.unit && pa.unit !== 'шт') return { a: pa.price, b: pb.price, what: `за 1 ${pa.unit}` };
  return { a: a.price, b: b.price, what: 'за упаковку' };
}
function vsRow(p, picked) {
  return `<button type="button" class="vs-row" data-pick="${p.id}" aria-pressed="${p.id === picked}">
    <img src="${esc(p.img)}" alt="" loading="lazy">
    <span class="vs-row__name">${esc(p.name)}</span>
    <span class="vs-row__price"><b class="${p.oldPrice ? 'price--sale' : ''}">${fmtPrice(p.price)} ₴</b>${perHtml(p)}</span>
  </button>`;
}
// Відповідні підкатегорії іншої мережі: { atb: { підкатегорія: [підкатегорії Сільпо] }, silpo: {…} } —
// будує scraper/chain-categories.js (назви підкатегорій у мережах різні).
let chainCats;
const loadChainCats = () =>
  (chainCats ||= fetch('data/chains/silpo/categories.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null));
async function renderVs(el, p, other, onChange) {
  const mine = chainOf(p);
  // Вкладки перемикають швидше, ніж вантажиться відповідність підкатегорій: малюємо лише останній виклик.
  const seq = (el._vsSeq = (el._vsSeq || 0) + 1);
  const cats = await loadChainCats();
  if (seq !== el._vsSeq) return;
  const pool = state.all.filter((x) => chainOf(x) === other && !x.from);
  const ranked = pool
    .map((x) => [x, matchScore(p, x)])
    .filter(([, sc]) => sc >= MATCH_SHOW)
    .sort((a, b) => b[1] - a[1]);
  const chosen = getPair(p, other);
  const pick = peerOf(p, other);
  // Такого самого товару немає — схожі й пошук лише з відповідних підкатегорій іншої мережі
  // (якщо відповідність невідома чи там порожньо — з того самого розділу).
  let near = pool;
  let nearCats = [];
  let nearWhat = 'Підкатегорія';
  if (!pick) {
    const want = new Set(cats?.[mine === 'thrash' ? 'silpo' : mine]?.[p.category] || []);
    if (pool.some((x) => x.category === p.category)) want.add(p.category);
    near = pool.filter((x) => want.has(x.category));
    nearCats = [...want].filter((c) => near.some((x) => x.category === c));
    if (!near.length) {
      near = pool.filter((x) => x.group === p.group);
      nearCats = p.group ? [p.group] : [];
      nearWhat = 'Розділ';
    }
  }
  const nearSet = new Set(near);
  const nearRanked = pick ? ranked : ranked.filter(([x]) => nearSet.has(x));
  let q = '';
  const paint = () => {
    // Висновок — різниця за одиницю товару (шт чи кг), під ним дрібніше — за 1 кг/л (якщо вона відома й інша).
    let verdict = '';
    let cheaper = false;
    if (pick) {
      const diff = (x, y, what) => {
        const d = Math.round((y / x - 1) * 100);
        return d === 0 ? `однаково ${what}` : `на ${Math.abs(d)}% ${d < 0 ? 'дешевше' : 'дорожче'} ${what}`;
      };
      const per = vsBasis(p, pick);
      const same = p.unit === pick.unit;
      const main = same ? { a: p.price, b: pick.price, what: `за 1 ${p.unit}` } : per;
      cheaper = main.b < main.a;
      verdict = `У ${CHAINS[other]} ${diff(main.a, main.b, main.what)}`;
      if (same && p.unit !== 'кг' && per.what !== 'за упаковку') verdict += `<small>${diff(per.a, per.b, per.what).replace(/^./, (c) => c.toUpperCase())}</small>`;
    }
    const words = norm(q).split(/\s+/).filter(Boolean);
    const list = words.length
      ? near
          .filter((x) => words.every((w) => x._q.includes(w)))
          .map((x) => [x, matchScore(p, x)])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
      : nearRanked.slice(0, 6);
    const side = (x) => `<a class="vs-side" href="#/p/${x.id}">
        ${chainTag(x)}
        <img src="${esc(x.img)}" alt="">
        <span class="vs-side__name">${esc(x.name)}</span>
        <span class="vs-side__price"><b class="${x.oldPrice ? 'price--sale' : ''}">${fmtPrice(x.price)} <small>₴/${esc(x.unit)}</small></b>${x.oldPrice ? ` <s>${fmtPrice(x.oldPrice)}</s>` : ''}</span>
        ${perHtml(x)}
      </a>`;
    el.innerHTML = `${
        pick
          ? `<div class="vs-pair">${side(p)}<span class="vs-pair__vs">vs</span>${side(pick)}</div>
             <p class="vs-verdict vs-verdict--${cheaper ? 'cheaper' : 'dearer'}">${verdict}</p>`
          : `<p class="note">${chosen === 0 ? 'Порівняння вимкнено.' : `Такого самого товару в ${CHAINS[other]} не знайшли.`} Виберіть товар нижче або знайдіть його пошуком.</p>`
      }
      <div class="vs-pick">
        <div class="vs-pick__head"><b>${pick ? 'Інший товар для порівняння' : 'Схожі товари'}</b>${pick ? '<button type="button" class="vs-none">Не порівнювати</button>' : ''}</div>
        ${nearCats.length ? `<p class="note">${nearCats.length > 1 ? 'Підкатегорії' : nearWhat} в ${CHAINS[other]}: ${nearCats.map(esc).join(', ')}</p>` : ''}
        <input type="search" class="vs-q" placeholder="Знайти в ${CHAINS[other]}" value="${esc(q)}" autocomplete="off">
        <div class="vs-list">${list.length ? list.map(([x]) => vsRow(x, pick?.id)).join('') : `<p class="note">${words.length ? 'Нічого не знайдено' : 'Схожих товарів немає'}</p>`}</div>
      </div>`;
  };
  const choose = (id) => {
    setPair(p, other, id);
    renderVs(el, p, other, onChange);
    onChange?.();
  };
  paint();
  el.oninput = (e) => {
    if (!e.target.matches('.vs-q')) return;
    q = e.target.value;
    const pos = e.target.selectionStart;
    paint();
    const input = el.querySelector('.vs-q');
    input.focus();
    input.setSelectionRange(pos, pos);
  };
  el.onclick = (e) => {
    const row = e.target.closest('[data-pick]');
    if (row) choose(+row.dataset.pick);
    else if (e.target.closest('.vs-none')) choose(0);
  };
}

// Інші мережі, з якими можна порівняти товар у цьому місті («Траш!» — лише акції, якщо він тут є).
const otherChains = (p) => Object.keys(CHAINS).filter((c) => c !== chainOf(p) && (c === 'thrash' ? state.thrash.length : state.chains.includes(c)));
let vsTab = null; // остання відкрита вкладка — щоб на наступному товарі відкрилась та сама мережа
// Порівняння з іншими мережами — один блок, мережа перемикається вкладками; на вкладці — різниця з тією мережею.
// Згорнуто за замовчуванням (на вкладках і так видно різницю); розгорнутий стан запам'ятовуємо.
const CHEVRON = '<svg class="vs-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
function renderChainVs(el, p) {
  const others = otherChains(p);
  // Товари інших мереж міста — догружаємо (перший раз — кілька секунд), потім малюємо.
  if (others.some((c) => CITY_CHAINS.includes(c) && !state.loaded.has(c))) {
    el.innerHTML = '<div class="panel__head"><h2>Порівняння з іншими мережами</h2></div><p class="note">Завантажуємо ціни інших мереж…</p>';
    ensureChains(others).then(() => el.isConnected && renderChainVs(el, p));
    return;
  }
  let tab = others.includes(vsTab) ? vsTab : others.find((c) => peerOf(p, c)) || others[0];
  let open = store.get('vsOpen') === '1';
  const tabLabel = (c) => {
    const x = peerOf(p, c);
    const d = x && vsDiff(p, x).d;
    return `${CHAINS[c]}${x ? ` <small class="${d > 0 ? 'bad' : d < 0 ? 'good' : ''}">${d === 0 ? '=' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`}</small>` : ''}`;
  };
  const head = () => `<div class="panel__head">
      <button type="button" class="vs-toggle" aria-expanded="${open}"><h2>${others.length > 1 ? 'Порівняння з іншими мережами' : `Порівняння з ${tabLabel(tab)}`}</h2>${CHEVRON}</button>
      ${
        others.length > 1
          ? `<div class="seg vs-tabs" role="tablist">${others
              .map((c) => `<button type="button" role="tab" data-tab="${c}" aria-pressed="${open && c === tab}" aria-selected="${open && c === tab}">${tabLabel(c)}</button>`)
              .join('')}</div>`
          : ''
      }
    </div>`;
  // Порівняння на плитках вимкнено (типово) — підказуємо, де його ввімкнути.
  const hint = showTileVs() ? '' : '<p class="note vs-hint">💡 Таке порівняння можна бачити й під кожною плиткою — увімкніть «Порівняння на плитках» у <a href="#/settings">налаштуваннях</a>.</p>';
  el.innerHTML = `<div class="vs-head">${head()}</div><div class="vs-body"${open ? '' : ' hidden'}></div>${hint}`;
  el.classList.toggle('is-collapsed', !open);
  const body = el.querySelector('.vs-body');
  const refreshHead = () => {
    el.querySelector('.vs-head').innerHTML = head();
  };
  const show = () => {
    body.hidden = !open;
    el.classList.toggle('is-collapsed', !open);
    refreshHead();
    if (open) renderVs(body, p, tab, refreshHead);
  };
  if (open) renderVs(body, p, tab, refreshHead);
  el.querySelector('.vs-head').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) {
      // Вкладка на згорнутому блоці — розгортаємо його одразу на ній.
      if (b.dataset.tab === tab && open) return;
      tab = vsTab = b.dataset.tab;
      open = true;
    } else if (e.target.closest('.vs-toggle')) open = !open;
    else return;
    store.set('vsOpen', open ? '1' : '0');
    show();
  };
}

// ---------- ТЕСТ: акції «Траш!» ----------
// Артикул «Траш!» = код товару Сільпо, тож товар Сільпо знаходимо точно; товар АТБ — за назвою й фасовкою (autoMatch).
// Такий самий товар іншої мережі: Сільпо ↔ «Траш!» — за кодом (артикул «Траш!» = код Сільпо), решта — за назвою
// й фасовкою (autoMatch) у тому самому розділі. Пару, яку користувач вибрав чи вимкнув у «Порівнянні» на сторінці
// товару (pairs), беремо як є. Пари рахуємо раз на місто (state.all змінюється з містом) — плиток сотні.
let peersFor = null;
let peers = new Map();
const vsOther = (p) => (chainOf(p) === 'atb' ? 'silpo' : 'atb'); // з якою мережею порівнювали до вкладок (старі pairs[id])
const pairKey = (id, chain) => `${id}>${chain}`;
function getPair(p, chain) {
  const k = pairKey(p.id, chain);
  if (k in pairs) return pairs[k];
  if (p.id in pairs && chain === vsOther(p)) return pairs[p.id];
  return undefined;
}
// Вибір користувача — в обидва боки; попередню пару (і її зворотний запис) прибираємо.
function setPair(p, chain, id) {
  const mine = chainOf(p);
  const old = getPair(p, chain);
  if (old) {
    delete pairs[pairKey(old, mine)];
    if (pairs[old] === p.id) delete pairs[old];
  }
  if (chain === vsOther(p)) delete pairs[p.id];
  pairs[pairKey(p.id, chain)] = id;
  if (id) pairs[pairKey(id, mine)] = p.id;
  store.set('pairs', JSON.stringify(pairs));
}
function peerOf(p, chain) {
  const mine = chainOf(p);
  if (chain === mine) return null;
  if (peersFor !== state.all) {
    peersFor = state.all;
    peers = new Map();
  }
  const chosen = getPair(p, chain);
  if (chosen === 0) return null;
  if (chosen) {
    const x = state.byId.get(chosen);
    if (x && chainOf(x) === chain) return x;
  }
  const key = `${chain}/${p.id}`;
  if (peers.has(key)) return peers.get(key);
  let best = null;
  if (FAMILY[mine] && FAMILY[mine] === FAMILY[chain]) best = state.byId.get(p.id - ID_BASE[mine] + ID_BASE[chain]) || null;
  else {
    let top = 0;
    for (const x of chain === 'thrash' ? state.thrash : state.all) {
      if (chainOf(x) !== chain || x.from || (p.group && x.group && x.group !== p.group)) continue;
      const sc = matchScore(p, x);
      if (sc > top && autoMatch(p, x, sc)) [best, top] = [x, sc];
    }
  }
  peers.set(key, best);
  return best;
}
// На плитці — ціна такого самого товару в інших мережах міста і на скільки там дорожче (+, червоним)
// чи дешевше (−, зеленим), ніж у цій.
function vsTileHtml(p) {
  const lines = Object.keys(CHAINS)
    .filter((c) => c !== chainOf(p) && state.loaded.has(c))
    .map((chain) => [chain, peerOf(p, chain)])
    .filter(([, x]) => x)
    .map(([chain, x]) => {
      const { d } = vsDiff(p, x);
      return `<span class="card__vs-row"><span>${CHAINS[chain]} ${fmtPrice(x.price)}</span><b class="${d > 0 ? 'bad' : d < 0 ? 'good' : ''}">${d === 0 ? '=' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`}</b></span>`;
    });
  return lines.length ? `<div class="card__vs" title="Ціна такого самого товару в цьому місті; відсоток — на скільки там дорожче (+) чи дешевше (−), ніж у ${CHAINS[chainOf(p)]}">${lines.join('')}</div>` : '';
}
// На скільки товар b дешевший чи дорожчий за a: за одиницю (шт чи кг), а як одиниці різні — за 1 кг/л.
function vsDiff(a, b) {
  const same = a.unit === b.unit;
  const m = same ? { a: a.price, b: b.price, what: `за 1 ${a.unit}` } : vsBasis(a, b);
  const d = Math.round((m.b / m.a - 1) * 100);
  return { d, text: d === 0 ? `однаково ${m.what}` : `на ${Math.abs(d)}% ${d < 0 ? 'дешевше' : 'дорожче'} ${m.what}` };
}


// ---------- Ціни в інших містах ----------
// data/compare/NN.json: { id: { місто: ціна | [ціна, ціна_до_знижки] } } — будує scraper/compare.js.

const compareShards = new Map();
async function loadCompare(id) {
  const shard = String(id % SHARDS).padStart(2, '0');
  if (!compareShards.has(shard)) {
    compareShards.set(shard, fetch(`data/compare/${shard}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return (await compareShards.get(shard))[id] || {};
}

// Мапа: межі областей (Natural Earth, суспільне надбання) у проєкції, з якою зберігали контури.
let mapData;
const loadMap = () => (mapData ||= fetch('data/ukraine.json').then((r) => r.json()));
const mapXY = (m, c) => [(c.lon - m.lonMin) * m.k * m.cos, (m.latMax - c.lat) * m.k];
// Номер області, в якій лежить точка (правило even-odd, як і в заливці контурів).
function regionAt(m, [x, y]) {
  m.rings ||= m.regions.map((d) => d.split('Z').filter(Boolean).map((r) => r.slice(1).split('L').map((p) => p.split(',').map(Number))));
  return m.rings.findIndex((rings) => {
    let inside = false;
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    return inside;
  });
}
// Куди ставити підпис міста, щоб сусідні не налазили один на одного (типово — праворуч).
const LABEL_SIDE = {
  kamianske: 'left',
  'bila-tserkva': 'left',
  mykolaiv: 'left',
  odesa: 'left',
  'kryvyi-rih': 'below',
  kremenchuk: 'above',
  cherkasy: 'left',
  kropyvnytskyi: 'left',
  lutsk: 'left',
  rivne: 'above',
  ternopil: 'left',
  'ivano-frankivsk': 'below',
  chernivtsi: 'below',
  uzhhorod: 'below',
  lviv: 'left',
  khmelnytskyi: 'below',
  krasyliv: 'above',
};
const LABEL_AT = { right: [15, -2, 'start'], left: [-15, -2, 'end'], above: [0, -28, 'middle'], below: [0, 26, 'middle'] };

// Розставляє підписи по черзі: спершу ваше місто, далі в порядку списку міст (обласні раніше за малі).
// Кожен підпис стає на перший бік, де не перекриває точки й інші підписи; якщо місця немає —
// підпису не буде (ціна лишається в підказці при наведенні). Повертає Map місто → [x, y, anchor].
// m — у скільки разів збільшено точки й підписи (мапа з наближенням тримає їх сталого екранного розміру);
// taken — уже зайняті місця (наприклад, назви областей), на які підписи не мають налазити.
function placeLabels(pts, here, map, widthOf, m = 1, taken = []) {
  const boxes = pts.map(({ r, xy: [x, y] }) => {
    const d = (r === here ? 16 : r ? 9 : 6) * m;
    return [x - d, y - d, x + d, y + d];
  });
  boxes.push(...taken);
  const hit = (a) => a[0] < 0 || a[1] < 0 || a[2] > map.w || a[3] > map.h || boxes.some((b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]);
  const out = new Map();
  const order = pts.filter((p) => p.r).sort((a, b) => (b.r === here) - (a.r === here));
  for (const { c, r, xy: [x, y] } of order) {
    const w = widthOf(c, r);
    const sides = [LABEL_SIDE[c.slug] || 'right', 'right', 'left', 'above', 'below'];
    let first = null;
    for (const side of new Set(sides)) {
      let [tx, ty, anchor] = LABEL_AT[side];
      if (r === here) [tx, ty] = [tx * 1.5, ty * 1.25]; // підпис не налазить на кільце «ваше місто»
      const left = x + (tx - (anchor === 'end' ? w : anchor === 'middle' ? w / 2 : 0)) * m;
      const box = [left, y + (ty - 10) * m, left + w * m, y + (ty + 19) * m];
      first ||= { box, at: [tx, ty, anchor] };
      if (hit(box)) continue;
      boxes.push(box);
      out.set(c, [tx, ty, anchor]);
      if (r === here) out.hereBox = box;
      break;
    }
    // Ваше місто підписуємо завжди: якщо вільного боку немає — на першому.
    if (r === here && !out.has(c)) {
      boxes.push(first.box);
      out.set(c, first.at);
      out.hereBox = first.box;
    }
  }
  return out;
}

async function renderCompare(el, p) {
  const [prices, map] = await Promise.all([loadCompare(p.id), loadMap().catch(() => null)]);
  if (!el.isConnected) return;
  const rows = state.cities
    .filter((c) => prices[c.slug] != null)
    .map((c) => {
      const v = prices[c.slug];
      const [price, old] = Array.isArray(v) ? v : [v, null];
      return { c, price, old };
    })
    .sort((a, b) => a.price - b.price || a.c.name.localeCompare(b.c.name, 'uk'));
  if (rows.length < 2) {
    el.remove();
    return;
  }
  const here = rows.find((r) => r.c.slug === state.city.slug);
  // Місто, ціни якого зараз на картці (інше, ніж вибране, — якщо відкрили з мапи).
  const shown = p._view ? rows.find((r) => r.c.slug === p.from) : here;
  const min = rows[0].price;
  const max = rows.at(-1).price;
  const cheapest = rows.filter((r) => r.price === min).map((r) => r.c.name);
  const absent = state.cities.length - rows.length;

  let summary;
  if (min === max) summary = `Однакова ціна в усіх ${rows.length} містах.`;
  else {
    summary = `Найдешевше — ${esc(cheapest.slice(0, 3).join(', '))}${cheapest.length > 3 ? ` і ще ${cheapest.length - 3}` : ''}: <b>${fmtPrice(min)} грн</b>. Найдорожче — <b>${fmtPrice(max)} грн</b>.`;
    if (here) {
      const cheaper = rows.filter((r) => r.price < here.price).length;
      summary += here.price === min ? ` У місті ${esc(here.c.name)} — найнижча ціна.` : ` У місті ${esc(here.c.name)} на ${Math.round((here.price / min - 1) * 100) || '<1'}% дорожче за найдешевше; дешевше — у ${cheaper} з ${rows.length - 1} міст.`;
    }
  }

  const pos = (v) => (max > min ? ((v - min) / (max - min)) * 100 : 50);
  // Колір ціни: зелений (найдешевше) → нейтральний сірий (середина) → червоний (найдорожче).
  const tone = (v) => {
    if (max === min) return 'var(--accent)';
    const t = pos(v) / 100;
    return t <= 0.5
      ? `color-mix(in oklab, var(--good) ${Math.round((1 - 2 * t) * 100)}%, var(--map-mid))`
      : `color-mix(in oklab, var(--sale) ${Math.round((2 * t - 1) * 100)}%, var(--map-mid))`;
  };
  const diffOf = (r) => {
    if (r === here) return { text: 'ваше місто' };
    if (!here) return null;
    const d = (r.price / here.price - 1) * 100;
    if (Math.abs(d) < 0.5) return { text: 'так само' };
    return { text: `${d < 0 ? '−' : '+'}${Math.abs(d) < 1 ? '<1' : Math.round(Math.abs(d))}%`, cls: d < 0 ? 'down' : 'up' };
  };
  const diff = (r) => {
    const d = diffOf(r);
    return d ? `<span class="crow__diff${d.cls ? ` crow__diff--${d.cls}` : ''}">${d.text}</span>` : '';
  };
  const row = (r) => `<button class="crow${r === here ? ' is-here' : ''}${r === shown && r !== here ? ' is-shown' : ''}" data-city="${r.c.slug}"
      title="${r === shown ? 'Ціни цього міста зараз на картці' : `Ціна й історія в місті ${esc(r.c.name)}`}">
      <span class="crow__city">${esc(r.c.name)}</span>
      <span class="crow__track" aria-hidden="true"><i style="left:${pos(r.price).toFixed(1)}%"></i></span>
      <span class="crow__price${r.old ? ' price--sale' : ''}">${fmtPrice(r.price)}${r.old ? ` <span class="old">${fmtPrice(r.old)}</span>` : ''}</span>
      ${diff(r)}
    </button>`;

  // Відсоток до ціни у вибраному місті поруч із ціною на мапі (для самого міста і «так само» — без нього).
  const pctLabel = (r) => {
    const d = diffOf(r);
    return d?.cls ? `<tspan class="mcity__pct mcity__pct--${d.cls}" dx="5">${d.text}</tspan>` : '';
  };
  let mapHtml = '';
  if (map) {
    const byCity = new Map(rows.map((r) => [r.c, r]));
    const pts = state.cities.filter((c) => c.lat != null).map((c) => ({ c, r: byCity.get(c), xy: mapXY(map, c) }));
    // Ширина підпису на око: назва 13px, ціна 15.5px (+ відсоток 13px).
    const labels = placeLabels(pts, here, map, (c, r) =>
      Math.max(c.name.length * 7.2, fmtPrice(r.price).length * 9.5 + (diffOf(r)?.cls ? diffOf(r).text.length * 7.5 + 5 : 0)),
    );
    // Область фарбуємо за середньою ціною міст у ній, де товар є.
    const sums = new Map();
    for (const { r, xy } of pts) {
      if (!r) continue;
      const i = regionAt(map, xy);
      const s = sums.get(i) || [0, 0];
      sums.set(i, [s[0] + r.price, s[1] + 1]);
    }
    const regionTone = (i) => {
      const s = sums.get(i);
      return s && max > min ? ` style="--rtone:${tone(s[0] / s[1])}"` : '';
    };
    const marks = pts
      .map(({ c, r, xy: [x, y] }) => {
        const at = `transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"`;
        if (!r) return `<g class="mcity mcity--none" data-city="${c.slug}" ${at}><circle r="5"/></g>`;
        const lb = labels.get(c);
        const text = lb
          ? `<text class="mcity__label" x="${lb[0]}" y="${lb[1]}" text-anchor="${lb[2]}"><tspan class="mcity__name" x="${lb[0]}">${esc(c.name)}</tspan><tspan class="mcity__price" x="${lb[0]}" dy="17">${fmtPrice(r.price)}</tspan>${pctLabel(r)}</text>`
          : '';
        return `<g class="mcity${r === here ? ' is-here' : ''}${r === shown && r !== here ? ' is-shown' : ''}" data-city="${c.slug}" ${at} style="--tone:${tone(r.price)}">
            ${r === here || r === shown ? '<circle class="mcity__ring" r="15"/>' : ''}<circle class="mcity__dot" r="9"/>${text}
          </g>`;
      })
      .join('');
    mapHtml = `<div class="umap">
        <svg viewBox="0 0 ${map.w} ${map.h}" role="img" aria-label="Мапа цін по містах України">
          <g class="umap__regions">${map.regions.map((d, i) => `<path d="${d}"${regionTone(i)}/>`).join('')}</g>
          ${marks}
        </svg>
        <div class="tip umap__tip" hidden></div>
      </div>
      <div class="umap__legend">
        ${max > min ? `<span class="umap__scale"><b>${fmtPrice(min)}</b><i aria-hidden="true"></i><b>${fmtPrice(max)}</b> грн</span>` : ''}
        ${here ? '<span><i class="lg-here" aria-hidden="true"></i>ваше місто</span>' : ''}
        ${absent ? '<span><i class="lg-none" aria-hidden="true"></i>товару немає</span>' : ''}
      </div>`;
  }

  el.innerHTML = `<div class="panel__head"><h2>Ціна в інших містах</h2></div>
    <p class="compare__summary">${summary}</p>
    ${mapHtml}
    <details class="compare__list"${map ? '' : ' open'}><summary>Показати списком (${rows.length} ${plural(rows.length, 'місто', 'міста', 'міст')})</summary>
      <div class="crows">${rows.map(row).join('')}</div>
    </details>
    <p class="note">Ціни за ${fmtDate(parseDate(state.meta.updated))}, по одному магазину в кожному місті${absent ? `; у ${absent} містах товару немає в асортименті` : ''}. Натисніть місто, щоб побачити ціну й історію в ньому.${map ? `${max > min ? ' Колір області — середня ціна в її містах.' : ''} Межі: Natural Earth.` : ''}</p>`;

  // Картка товару з цінами іншого міста; вибране місто лишається тим самим.
  const go = (slug) => {
    if (slug === (p._view ? p.from : state.city.slug)) return;
    location.hash = slug === state.city.slug ? `#/p/${p.id}` : `#/p/${p.id}/${slug}`;
  };
  const tip = el.querySelector('.umap__tip');
  const showTip = (g, touch) => {
    const c = state.cities.find((x) => x.slug === g.dataset.city);
    const r = rows.find((x) => x.c === c);
    const d = r && diffOf(r);
    const price = r
      ? `<b>${fmtPrice(r.price)} грн</b>${r.old ? ` <span class="old">${fmtPrice(r.old)}</span>` : ''}${d ? ` · <span class="${d.cls ? `crow__diff--${d.cls}` : ''}">${d.text}</span>` : ''}`
      : '<span class="note">товару немає</span>';
    const btn = touch && r && r !== shown ? `<br><button class="umap__go" data-go="${c.slug}">Показати тут →</button>` : '';
    tip.innerHTML = `<b>${esc(c.name)}</b><br>${price}${btn}`;
    tip.hidden = false;
    const box = el.querySelector('.umap').getBoundingClientRect();
    const dot = g.querySelector('circle:last-of-type').getBoundingClientRect();
    const cx = dot.left + dot.width / 2 - box.left;
    tip.style.left = `${Math.min(Math.max(cx, tip.offsetWidth / 2 + 4), box.width - tip.offsetWidth / 2 - 4)}px`;
    tip.style.top = `${dot.top - box.top - 10}px`; // над точкою, з проміжком під курсор
  };
  const svg = el.querySelector('.umap svg');
  if (svg) {
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const g = e.target.closest('.mcity');
      if (g) showTip(g, false);
      else tip.hidden = true;
    });
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') tip.hidden = true;
    });
    // Сенсорний екран: дотик будь-де в області — найближче до дотику місто цієї області.
    const cityInRegion = (region, e) => {
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      let best = null;
      let bestD = Infinity;
      for (const g of svg.querySelectorAll('.mcity')) {
        const { e: x, f: y } = g.transform.baseVal.consolidate().matrix;
        if (!region.isPointInFill(new DOMPoint(x, y))) continue;
        const d = Math.hypot(x - pt.x, y - pt.y);
        if (d < bestD) [best, bestD] = [g, d];
      }
      return best;
    };
    svg.addEventListener('click', (e) => {
      const touch = !matchMedia('(hover: hover)').matches;
      const region = touch && e.target.closest('.umap__regions path');
      const g = e.target.closest('.mcity') || (region && cityInRegion(region, e));
      for (const r of svg.querySelectorAll('.umap__regions .is-picked')) r.classList.remove('is-picked');
      if (!g) {
        tip.hidden = true;
        return;
      }
      // Мишею — одразу перехід; на сенсорному екрані спершу підказка з кнопкою.
      if (!touch) return go(g.dataset.city);
      const { e: x, f: y } = g.transform.baseVal.consolidate().matrix;
      [...svg.querySelectorAll('.umap__regions path')].find((r) => r.isPointInFill(new DOMPoint(x, y)))?.classList.add('is-picked');
      showTip(g, true);
    });
  }
  el.onclick = (e) => {
    const b = e.target.closest('.crow[data-city], [data-go]');
    if (b) go(b.dataset.city || b.dataset.go);
  };
}

// Акцію вважаємо «завищеною», якщо ціна до знижки вища за звичайну ціну перед акцією (з допуском 0,5%).
const isInflated = (old, regular) => !!(old && regular && old > regular * 1.005);
const pct = (a, b) => Math.round((1 - a / b) * 100);
// «Реальна знижка» відносно ціни перед акцією; якщо ціна натомість зросла — так і кажемо.
const realDiscount = (price, ref) =>
  price === ref
    ? 'Насправді <b>ціна та сама</b>'
    : price < ref
    ? `Реальна знижка — <b>${pct(price, ref) || '<1'}%</b>`
    : `Насправді це <b>подорожчання на ${-pct(price, ref) || '<1'}%</b>`;

// Перетворює точки змін у відрізки в межах періоду.
// ref — звичайна ціна, що діяла перед акцією (для перевірки «ціни до знижки»).
function segments(hist, days) {
  // Кінець — останній збір (каталог іншої мережі може бути зібраний пізніше за АТБ).
  const end = Math.max(parseDate(state.meta.updated), hist.length ? parseDate(hist.at(-1)[0]) : 0) + DAY;
  const start = Number.isFinite(days) ? end - days * DAY : -Infinity;
  const segs = [];
  let regular = null;
  // [дата, ціна, стара, _, ціна_з_карткою]; [дата, null] — ціна невідома (розрив на графіку).
  hist.forEach(([d, price, old, , card], i) => {
    const from = parseDate(d);
    const to = i + 1 < hist.length ? parseDate(hist[i + 1][0]) : end;
    if (price != null && !old) regular = price;
    if (price == null || to <= start) return;
    const ref = old ? regular : null;
    segs.push({ from: Math.max(from, start), to, price, old: old ?? null, ref, inflated: isInflated(old, ref), card: card ?? null });
  });
  return segs;
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

function renderChart(el, hist, days, unit) {
  const segs = segments(hist, days);
  if (!segs.length) {
    el.innerHTML = '<p class="note">Немає даних за цей період.</p>';
    return;
  }
  const W = el.clientWidth || 600;
  const H = 260;
  const m = { l: 46, r: 12, t: 12, b: 26 };
  const x0 = segs[0].from;
  const x1 = segs.at(-1).to;
  const values = segs.flatMap((s) => [s.price, s.old, s.card, s.inflated ? s.ref : null]).filter((v) => v != null);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < hi * 0.04) {
    const pad = Math.max(hi * 0.05, 1);
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.ceil(hi / step) * step;
  const X = (t) => m.l + ((t - x0) / Math.max(x1 - x0, DAY)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
  }
  const spanDays = (x1 - x0) / DAY;
  const ticks = Math.max(1, Math.min(6, Math.floor((W - m.l - m.r) / 90), Math.round(spanDays)));
  let xt = '';
  for (let i = 0; i < ticks; i++) {
    const t = ticks === 1 ? x0 : x0 + ((x1 - x0 - DAY) * i) / (ticks - 1);
    const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
    xt += `<text x="${X(t)}" y="${H - 6}" text-anchor="${anchor}">${fmtDate(t, spanDays > 300)}</text>`;
  }

  // Ступінчаста лінія; розрив, якщо товар зникав з каталогу.
  let path = '';
  let cardPath = ''; // ціна при оплаті карткою АТБ
  let area = '';
  let bands = '';
  let oldPath = ''; // «ціна до знижки» під час акцій
  let inflPath = ''; // те саме, коли її завищено
  let refPath = ''; // фактична звичайна ціна перед завищеною акцією
  let salePath = ''; // ціна під час акції — поверх основної лінії червоним
  segs.forEach((s, i) => {
    const p = segs[i - 1];
    if (s.card) cardPath += `${p?.card && p.to === s.from ? `V${Y(s.card)}` : `M${X(s.from)},${Y(s.card)}`}H${X(s.to)}`;
    path += p && p.to === s.from ? `V${Y(s.price)}H${X(s.to)}` : `M${X(s.from)},${Y(s.price)}H${X(s.to)}`;
    area += `M${X(s.from)},${Y(lo)}V${Y(s.price)}H${X(s.to)}V${Y(lo)}Z`;
    if (!s.old) return;
    bands += `<rect class="sale-band" x="${X(s.from)}" y="${m.t}" width="${X(s.to) - X(s.from)}" height="${H - m.t - m.b}"/>`;
    salePath += `M${X(s.from)},${Y(s.price)}H${X(s.to)}`;
    if (s.inflated) {
      inflPath += `M${X(s.from)},${Y(s.ref)}V${Y(s.old)}H${X(s.to)}`;
      refPath += `M${X(s.from)},${Y(s.ref)}H${X(s.to)}`;
    } else {
      oldPath += `M${X(s.from)},${Y(s.old)}H${X(s.to)}`;
    }
  });
  const hasSale = segs.some((s) => s.old);
  const hasInflated = segs.some((s) => s.inflated);
  const swatch = (cls) => `<svg width="18" height="10" aria-hidden="true"><path class="${cls}" d="M1,5H17"/></svg>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Графік ціни">
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--chart-line);stop-opacity:.22"/>
        <stop offset="1" style="stop-color:var(--chart-line);stop-opacity:0"/>
      </linearGradient></defs>
      <g class="axis">${grid}${xt}</g>
      ${bands}
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
      <path class="sale-line" d="${salePath}"/>
      <path class="card-line" d="${cardPath}"/>
      <path class="old-line" d="${oldPath}"/>
      <path class="ref-line" d="${refPath}"/>
      <path class="old-line old-line--inflated" d="${inflPath}"/>
      <line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
      <circle class="dot" r="5" visibility="hidden"/>
      <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>
    </svg>
    <div class="tip" hidden></div>
    <div class="legend">
      <span><i style="background:var(--chart-line)"></i>Ціна, грн/${esc(unit)}</span>
      ${cardPath ? `<span>${swatch('card-line')}З карткою АТБ</span>` : ''}
      ${hasSale ? '<span><i class="sale-swatch"></i>Акція</span>' : ''}
      ${oldPath ? `<span>${swatch('old-line')}Ціна до знижки</span>` : ''}
      ${hasInflated ? `<span>${swatch('old-line old-line--inflated')}⚠ Завищена ціна до знижки</span><span>${swatch('ref-line')}Ціна перед акцією</span>` : ''}
    </div>
    ${spanDays < 3 ? `<p class="note">Історія збирається з ${fmtDate(x0)}. Графік наповнюватиметься щодня.</p>` : ''}`;

  const svg = el.querySelector('svg');
  const cross = el.querySelector('.cross');
  const dot = el.querySelector('.dot');
  const tip = el.querySelector('.tip');
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const day = Math.floor(t / DAY) * DAY;
    const s = segs.find((g) => day >= g.from && day < g.to);
    if (!s) return hide();
    const cx = X(day + DAY / 2);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', Y(s.price));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    let html = `${fmtDate(day)}<br><b>${fmtPrice(s.price)} грн</b>`;
    if (s.old) html += ` <span class="old">${fmtPrice(s.old)}</span> акція −${pct(s.price, s.old)}%`;
    if (s.card) html += `<br><span class="tip__card">з карткою АТБ ${fmtPrice(s.card)} грн</span>`;
    if (s.inflated) {
      html += `<br><span class="warn">⚠ Перед акцією було ${fmtPrice(s.ref)} грн</span><br>${realDiscount(s.price, s.ref)}`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const left = (cx / W) * r.width;
    tip.style.left = `${Math.min(Math.max(left, tip.offsetWidth / 2), r.width - tip.offsetWidth / 2)}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

function renderStats(el, hist, days, unit) {
  const segs = segments(hist, days);
  if (!segs.length) {
    el.innerHTML = '';
    return;
  }
  let sum = 0;
  let len = 0;
  for (const s of segs) {
    sum += s.price * (s.to - s.from);
    len += s.to - s.from;
  }
  const prices = segs.map((s) => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const first = parseDate(hist[0][0]);
  const hasCard = hist.some((h) => h[4]);
  const rows = hist
    .slice()
    .reverse()
    .map(
      ([d, p, o, , card]) =>
        `<tr><td>${fmtDate(parseDate(d))}</td><td>${p == null ? 'ціна невідома' : fmtPrice(p)}</td><td>${o ? fmtPrice(o) : ''}</td>${
          hasCard ? `<td>${card ? fmtPrice(card) : ''}</td>` : ''
        }</tr>`,
    )
    .join('');
  el.innerHTML = `<div class="stats">
      <div class="stat"><div class="stat__k">Мінімум</div><div class="stat__v">${fmtPrice(min)} грн</div></div>
      <div class="stat"><div class="stat__k">Максимум</div><div class="stat__v">${fmtPrice(max)} грн</div></div>
      <div class="stat"><div class="stat__k">Середня</div><div class="stat__v">${fmtPrice(sum / len)} грн</div></div>
      <div class="stat"><div class="stat__k">Відстежується з</div><div class="stat__v">${fmtDate(first)}</div></div>
    </div>
    <details class="table"><summary>Таблиця змін ціни (${hist.length})</summary>
      <div class="tablewrap"><table><thead><tr><th>Дата</th><th>Ціна, грн/${esc(unit)}</th><th>Ціна до знижки</th>${hasCard ? "<th>З карткою АТБ</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
}

// ---------- Маршрутизація ----------

// Повернення зі сторінки товару: туди, звідки її відкрили (список, «Що змінилося», «Обране»), на те саме місце.
const scrollMemo = new Map();
const pageKey = (hash) => (hash || '#/').replace(/^#\/?$/, '#/');
let backTo = '#/';
// «Обране» відкривають із шапки на будь-якій сторінці — повертаємось туди, звідки прийшли.
// Якщо це сторінка товару, запам'ятовуємо і її власне «назад», щоб після повернення воно було тим самим.
let favFrom = '#/';
let favFromBack = '#/';
const backLink = (to = backTo) => {
  const p = to.startsWith('#/p/') && state.byId.get(parseInt(to.slice(4), 10));
  const name = p && (p.name.length > 40 ? `${p.name.slice(0, 38).trim()}…` : p.name);
  const label = p ? name : to.startsWith('#/today') ? 'Що змінилося' : to === '#/fav' ? 'Обране' : to === '#/list' ? 'Список покупок' : to === '#/settings' ? 'Налаштування' : BETA && to !== '#/all' ? 'Головна' : 'Усі товари';
  return `<a class="back" href="${esc(to)}">← ${esc(label)}</a>`;
};

function route(e) {
  const from = e?.oldURL ? pageKey(new URL(e.oldURL).hash) : null;
  if (from && !from.startsWith('#/p/')) {
    scrollMemo.set(from, scrollY);
    backTo = from;
    if (location.hash === '#/fav' && from !== '#/fav') favFrom = from;
  }
  if (from?.startsWith('#/p/') && location.hash === '#/fav') {
    favFrom = from;
    favFromBack = backTo;
  }
  if (from === '#/fav' && favFrom.startsWith('#/p/') && pageKey(location.hash) === favFrom) backTo = favFromBack;
  // Повертаємось зі сторінки товару чи з «Обраного» — відновлюємо прокрутку сторінки, куди повернулись.
  const restore = from?.startsWith('#/p/') || (from === '#/fav' && location.hash !== '#/fav') ? scrollMemo.get(pageKey(location.hash)) : null;
  const m = location.hash.match(/^#\/p\/(\d+)(?:\/([\w-]+))?/);
  const onFavs = location.hash === '#/fav';
  const onSettings = location.hash === '#/settings';
  if (onSettings) $('#settingsLink').setAttribute('aria-current', 'page');
  else $('#settingsLink').removeAttribute('aria-current');
  const onCart = location.hash === '#/list';
  // «Назад» зі списку покупок — туди, звідки його відкрили (але не на товар, відкритий зі списку).
  if (onCart && from && from !== '#/list' && !(from.startsWith('#/p/') && backTo === '#/list')) cartFrom = from;
  if (onCart) $('#cartLink').setAttribute('aria-current', 'page');
  else $('#cartLink').removeAttribute('aria-current');
  if (onFavs) $('#favLink').setAttribute('aria-current', 'page');
  else $('#favLink').removeAttribute('aria-current');
  const today = location.hash.match(/^#\/today(?:\/(\w+))?/);
  const render = () => {
    // Помилка всередині startViewTransition не дійде до жодного обробника — сторінка лишилася б із заглушками.
    try {
      if (m) renderProduct(Number(m[1]), m[2]);
      else if (isHome()) renderHome();
      else if (onFavs) renderFavs();
      else if (onSettings) renderSettings();
      else if (onCart) {
        scrollTo(0, 0);
        renderCart();
      }
      else if (today) renderToday(today[1]);
      else renderList();
    } catch (err) {
      console.error(err);
      app.innerHTML = '<p class="status">Не вдалося показати сторінку.<br><button onclick="location.reload()">Оновити</button></p>';
    }
    if (restore != null) scrollTo(0, restore);
  };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(render);
  else render();
}

// Кнопка «Угору» — з'являється, коли прогорнули більше ніж півтора екрана.
{
  const up = $('#toTop');
  const sync = () => up.classList.toggle('is-on', scrollY > innerHeight * 1.5);
  addEventListener('scroll', sync, { passive: true });
  up.addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  sync();
}

app.innerHTML = skeleton();
loadCities()
  .then(loadData)
  .then(() => {
    bindFilters();
    bindCart();
    addEventListener('hashchange', route);
    route();
    favToast();
  })
  .catch((err) => {
    console.error(err);
    app.innerHTML = '<p class="status">Не вдалося завантажити дані.</p>';
  });

// Тестова копія (/test/) живе поряд з основним сайтом — свій service worker видаляв би кеш основного.
if ('serviceWorker' in navigator && !location.pathname.includes('/test/')) navigator.serviceWorker.register('sw.js').catch(() => {});
