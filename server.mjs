import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT) || 4174;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".otf": "font/otf"
};

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

let usedFallbackPort = false;
function announce() {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Canvas acceptance app: http://127.0.0.1:${actualPort}`);
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !process.env.PORT && !usedFallbackPort) {
    usedFallbackPort = true;
    server.listen(0, "127.0.0.1");
    return;
  }
  console.error(`Unable to start server: ${error.message}`);
  process.exitCode = 1;
});

server.once("listening", announce);
server.listen(port, "127.0.0.1");
