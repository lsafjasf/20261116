import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 5173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
  const rel = urlPath === '/' ? '/web/index.html' : urlPath;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`场景图检查器运行中: http://localhost:${port}/web/index.html`);
});
