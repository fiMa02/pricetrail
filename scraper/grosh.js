// ТЕСТ: каталог Грош — інтернет-магазин online.grosh.ua (доставка й самовивіз у Вінниці).
// Дані — з відкритого API платформи Salesbox, якою користується сам сайт (prod.salesbox.me).
//
//   node scraper/grosh.js
//
// Результат — як у Сільпо: site/data/chains/grosh/vinnytsia/… (див. chain-store.js).
// id товару = GROSH_ID_BASE + vendorCode (внутрішній код Грош). Штрихкодів API не віддає (поле barcode порожнє) —
// до штрихкодів товари Грош прив'язуються лише через такий самий товар інших мереж (як АТБ).
import { fetchJson, saveCatalog, writeCities, groupOf, sleep } from './chain-store.js';

const API = 'https://prod.salesbox.me/api/v5/companies/grosh';
const GROSH_ID_BASE = 100_000_000;
const CITY = 'vinnytsia';
const STORE = { id: 'online.grosh.ua', address: 'інтернет-магазин (Вінниця)' };
const PAGE = 100;
const DELAY_MS = 400;

const get = (url) => fetchJson(`${API}${url}${url.includes('?') ? '&' : '?'}lang=uk`, { headers: { Origin: 'https://online.grosh.ua' } });
const nameOf = (c) => (c.names?.find((n) => n.lang === 'uk')?.name || c.name || '').trim();
// «КОВБАСНІ ВИРОБИ» → «Ковбасні вироби».
const tidy = (s) => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);

const started = Date.now();
const cats = (await get('/categories')).data;
// parentId посилається то на id, то на internalId батька.
const byId = new Map(cats.flatMap((c) => [[c.id, c], [c.internalId, c]]));
const topOf = (c) => {
  while (c.parentId && byId.get(c.parentId)) c = byId.get(c.parentId);
  return c;
};
// Обходимо кінцеві розділи (без підрозділів): у них — усі товари.
const leaves = cats.filter((c) => c.parentId && !cats.some((x) => x.parentId === c.id || x.parentId === c.internalId));
const products = new Map();
for (const leaf of leaves) {
  const top = tidy(nameOf(topOf(leaf)));
  const sub = tidy(nameOf(leaf));
  for (let page = 1; ; page++) {
    const j = await get(`/offers/filter?page=${page}&pageSize=${PAGE}&categoryId=${leaf.id}&categoryInternalId=${leaf.internalId}`);
    for (const x of j.data || []) {
      const code = Number(x.vendorCode);
      if (!Number.isInteger(code) || code <= 0 || code >= 100_000_000 || !(x.price > 0)) continue;
      const id = GROSH_ID_BASE + code;
      if (products.has(id)) continue;
      const sale = x.priceWithDiscount > 0 && x.priceWithDiscount < x.price;
      products.set(id, {
        id,
        chain: 'grosh',
        name: x.name.trim(),
        url: '',
        img: x.previewURL || null,
        price: sale ? x.priceWithDiscount : x.price,
        oldPrice: sale ? x.price : null,
        unit: /кг/i.test(x.units || '') ? 'кг' : 'шт',
        category: sub,
        group: groupOf(top, sub),
      });
    }
    await sleep(DELAY_MS);
    if (page >= (j.payload?.pagesCount || 1)) break;
  }
}
const changed = await saveCatalog('grosh', CITY, products, STORE);
await writeCities('grosh');
console.log(`[Грош, Вінниця] ${products.size} товарів, змін цін: ${changed}, ${Math.round((Date.now() - started) / 1000)} с`);
