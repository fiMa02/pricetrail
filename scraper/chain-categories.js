// Відповідність підкатегорій АТБ і Сільпо — для порівняння з іншою мережею на сторінці товару (тестова копія):
// коли такого самого товару не знайшли, схожі й пошук показуємо лише з відповідних підкатегорій.
// Назви підкатегорій у мережах різні («Вершки» в АТБ — «Молоко, вершки» в Сільпо), тож відповідність виводимо з
// товарів: у кожному місті, де є обидві мережі, для кожного товару шукаємо найсхожіший за назвою в тому самому
// розділі іншої мережі й рахуємо, в які підкатегорії потрапляють такі пари.
// site/data/chains/silpo/categories.json: { atb: { підкатегорія АТБ: [підкатегорії Сільпо] }, silpo: { …: [АТБ] } }
// — підкатегорії, куди потрапило від 10% пар (від найчастішої).
//
//   node scraper/chain-categories.js — перебудувати з наявних products.json (публікація робить це сама)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_SCORE = 0.5; // менш схожі пари не враховуємо
const MIN_SHARE = 0.1;
// Службові слова й упаковка (за першими 5 літерами) — як у порівнянні на сайті.
const STOP = new Set(
  'з зі із та і й в у на для без по тм гат шт вагов фасов преміум тетра пляшк стака пакет банка фольг флако фільт мрц тек стери пасте ультр натур упако скло пет об ск бут кор'.split(' '),
);
const words = (p) =>
  new Set(
    p.name
      .toLowerCase()
      .replace(/[’'`ʼ]/g, '')
      .replace(/[«»"“”()®™,.!+*]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/\d/.test(w) && !w.includes('/'))
      .map((w) => w.slice(0, 5))
      .filter((w) => !STOP.has(w)),
  );
const readJson = (file) => fs.readFile(file, 'utf8').then(JSON.parse, () => null);

export async function buildChainCategories(dataDir) {
  const silpoDir = path.join(dataDir, 'chains', 'silpo');
  const cities = await readJson(path.join(silpoDir, 'cities.json'));
  if (!cities) return null;
  const counts = { atb: new Map(), silpo: new Map() }; // підкатегорія → Map(підкатегорія іншої мережі → пар)
  const add = (side, from, to) => {
    const m = counts[side].get(from) || counts[side].set(from, new Map()).get(from);
    m.set(to, (m.get(to) || 0) + 1);
  };
  for (const { slug } of cities) {
    const atb = (await readJson(path.join(dataDir, 'cities', slug, 'products.json'))) || [];
    const silpo = (await readJson(path.join(silpoDir, slug, 'products.json'))) || [];
    const all = atb.concat(silpo).filter((p) => p.category);
    // Вага слова — наскільки воно рідкісне (IDF); схожість — косинус за вагами слів.
    const df = new Map();
    for (const p of all) for (const w of (p._w = words(p))) df.set(w, (df.get(w) || 0) + 1);
    const idf2 = new Map([...df].map(([w, n]) => [w, Math.log((all.length + 1) / n) ** 2]));
    for (const p of all) p._n = Math.sqrt([...p._w].reduce((s, w) => s + idf2.get(w), 0)) || 1;
    const byGroup = (chain) => {
      const m = new Map();
      for (const p of all) if ((p.chain || 'atb') === chain) (m.get(p.group) || m.set(p.group, []).get(p.group)).push(p);
      return m;
    };
    const groups = { atb: byGroup('atb'), silpo: byGroup('silpo') };
    for (const [side, other] of [['atb', 'silpo'], ['silpo', 'atb']]) {
      for (const list of groups[side].values()) {
        for (const p of list) {
          let best = null;
          let top = 0;
          for (const q of groups[other].get(p.group) || []) {
            let c = 0;
            for (const w of p._w) if (q._w.has(w)) c += idf2.get(w);
            const s = c / (p._n * q._n);
            if (s > top) [best, top] = [q, s];
          }
          if (best && top >= MIN_SCORE) {
            add(side, p.category, best.category);
            add(other, best.category, p.category);
          }
        }
      }
    }
  }
  const out = {};
  for (const side of ['atb', 'silpo']) {
    out[side] = {};
    for (const [cat, to] of [...counts[side]].sort((a, b) => a[0].localeCompare(b[0], 'uk'))) {
      const total = [...to.values()].reduce((s, n) => s + n, 0);
      out[side][cat] = [...to]
        .filter(([, n]) => n >= 2 && n / total >= MIN_SHARE)
        .sort((a, b) => b[1] - a[1])
        .map(([c]) => c);
    }
  }
  await fs.writeFile(path.join(silpoDir, 'categories.json'), JSON.stringify(out));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await buildChainCategories(path.resolve('site/data'));
  console.log(out ? `categories.json: АТБ ${Object.keys(out.atb).length}, Сільпо ${Object.keys(out.silpo).length} підкатегорій` : 'Каталогу Сільпо немає — пропущено');
}
