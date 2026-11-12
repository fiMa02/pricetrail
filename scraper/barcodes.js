// ТЕСТ: покажчик штрихкодів для пошуку на сайті — site/data/barcodes/NN.json (NN — дві останні цифри штрихкоду):
//   { "4820016254855": { "n": "Молоко … 900г", "r": ["z123", "f28735"] }, … }
// n — назва товару (з будь-якої мережі): за нею сайт знаходить такий самий товар в АТБ і Грош, не вантажачи каталогів.
// z<номер> — товар мереж zakaz.ua (id = база мережі + номер; scraper/zakaz-ids.json),
// f<код>   — товар групи Fozzy: Сільпо (10 млн + код), «Траш!» (20 млн + код), Фора (90 млн + код); scraper/silpo-barcodes.json.
// Штрихкод — без початкових нулів. АТБ і Грош штрихкодів не публікують — на сайті до них веде такий самий товар інших мереж.
//
//   node scraper/barcodes.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, chainDir } from './chain-store.js';
import { ZAKAZ_BASES } from './zakaz-bases.js';

const OUT = path.resolve('site/data/barcodes');
const SHARDS = 100;
const index = new Map();
const add = (code, ref) => {
  const b = String(code).replace(/^0+/, '');
  if (b.length < 8 || !/^\d+$/.test(b)) return;
  const refs = index.get(b) || index.set(b, []).get(b);
  if (!refs.includes(ref)) refs.push(ref);
};
for (const [ean, n] of Object.entries(await readJson(path.resolve('scraper/zakaz-ids.json'), {}))) if (ean !== '_next') add(ean, `z${n}`);
for (const [code, list] of Object.entries(await readJson(path.resolve('scraper/silpo-barcodes.json'), {}))) for (const b of list) add(b, `f${code}`);

// Назви: z<номер> — з каталогів мереж zakaz.ua, f<код> — Сільпо або Фори (будь-яке місто).
const names = new Map();
const scan = async (chain, base, prefix) => {
  for (const slug of await fs.readdir(chainDir(chain)).catch(() => [])) {
    for (const p of await readJson(path.join(chainDir(chain), slug, 'products.json'), [])) {
      const ref = `${prefix}${p.id - base}`;
      if (!names.has(ref)) names.set(ref, p.name);
    }
  }
};
for (const [chain, base] of Object.entries(ZAKAZ_BASES)) await scan(chain, base, 'z');
await scan('silpo', 10_000_000, 'f');
await scan('fora', 90_000_000, 'f');

const shards = Array.from({ length: SHARDS }, () => ({}));
for (const [b, refs] of index) {
  const n = refs.map((r) => names.get(r)).find(Boolean);
  shards[Number(b.slice(-2)) % SHARDS][b] = n ? { n, r: refs } : { r: refs };
}
await fs.mkdir(OUT, { recursive: true });
for (let i = 0; i < SHARDS; i++) await fs.writeFile(path.join(OUT, `${String(i).padStart(2, '0')}.json`), JSON.stringify(shards[i]));
console.log(`Штрихкоди: ${index.size} у покажчику`);
