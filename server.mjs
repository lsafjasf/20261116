import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const root = process.cwd();
const preferredPort = Number(process.env.PORT || 4173);
const fallbackLimit = process.env.PORT ? preferredPort : preferredPort + 20;
let port = preferredPort;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(root, relative));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

function listen() {
  server.listen(port, "127.0.0.1");
}

server.once("listening", () => {
  console.log(`FRAME editor: http://127.0.0.1:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && port < fallbackLimit) {
    port += 1;
    listen();
    return;
  }
  throw error;
});

listen();
