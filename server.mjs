import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const path = join(root, relative || "index.html");
    if (!path.startsWith(root)) throw new Error("Forbidden");
    const info = await stat(path);
    const finalPath = info.isDirectory() ? join(path, "index.html") : path;
    const body = await readFile(finalPath);
    response.writeHead(200, {
      "Content-Type": mime[extname(finalPath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PRISM / 03 ready at http://127.0.0.1:${port}`);
});
