import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicRoot = join(root, "src", "public");
const coreRoot = join(root, "src", "core");
const port = Number(process.env.PORT ?? 6280);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const target = resolve(base, `.${normalize(decoded)}`);
  return target.startsWith(base) ? target : null;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "stable-sprite-atlas-lab" }));
      return;
    }
    let filePath;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      filePath = join(publicRoot, "index.html");
    } else if (url.pathname.startsWith("/core/")) {
      filePath = safeJoin(coreRoot, url.pathname.slice("/core".length));
    } else {
      filePath = safeJoin(publicRoot, url.pathname);
    }
    if (!filePath) throw new Error("Invalid path");
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "content-length": info.size,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Stable Sprite Atlas Lab: http://127.0.0.1:${port}`);
});
