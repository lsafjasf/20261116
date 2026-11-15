import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = rel === '/' ? '/index.html' : rel;
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(8731, '127.0.0.1', () => {
  console.log('http://127.0.0.1:8731/');
});
