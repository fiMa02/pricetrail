// Локальний перегляд сайту так, як його публікує .github/workflows/deploy.yml, — щоб перевіряти зміни до публікації.
//   http://localhost:8765/       — основний сайт (site/ з цієї теки, гілка main)
//   http://localhost:8765/test/  — тестова копія: сторінка з гілки silpo-test (сусідня тека «<ця тека>-silpo»,
//                                  git worktree), дані — спільні з основним сайтом
//   /test/set.html?chain=thrash&city=kyiv#/all — кладе значення в localStorage і відкриває сторінку
//
//   node scripts/preview.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'site');
const TEST = path.join(`${ROOT}-silpo`, 'site');
const PORT = 8765;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p === '/test/set.html') {
      const q = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      return res.end(`<script>for (const [k, v] of Object.entries(${JSON.stringify(q)})) localStorage.setItem(k, v);location.href = '/test/' + location.hash</script>`);
    }
    let file;
    if (p === '/test' || p.startsWith('/test/')) {
      const rel = p.slice(6) || 'index.html';
      if (!rel.startsWith('data/')) file = path.join(TEST, rel);
      // Як у deploy.yml: тестова сторінка лежить у /test/, а дані беруться з ../data.
      if (rel === 'app.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(file, 'utf8').replace(/(['`])data\//g, '$1../data/'));
      }
    }
    if (!file) file = path.join(MAIN, p.endsWith('/') ? `${p}index.html` : p);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}/test/`));
