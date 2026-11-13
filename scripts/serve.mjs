// Static file server for the repo root with the cross-origin isolation
// headers that SharedArrayBuffer (wasm threads) requires. Requests with a
// `no-isolation` query parameter get no such headers, so a page loaded that way
// is not isolated (and gets the single-threaded build).
// Usage: node scripts/serve.mjs [port]   (0 picks a free port)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".json": "application/json",
};

/**
 * @param {number} port
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => boolean} [hook]
 *   Return true if the request was handled.
 */
export function serve(port, hook) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.searchParams.has("no-isolation")) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    res.setHeader("Cache-Control", "no-store");
    if (hook?.(req, res)) return;
    const path = normalize(decodeURIComponent(url.pathname));
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    if (path.endsWith("/")) file = join(file, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await serve(Number(process.argv[2] ?? 8080));
  console.log(`serving ${ROOT} on http://127.0.0.1:${server.address().port}/`);
}
