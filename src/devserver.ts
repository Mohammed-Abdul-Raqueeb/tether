/**
 * Development server: the UI and the relay on one origin.
 *
 * Same origin only so the browser demo needs no CORS dance. The desktop build
 * talks to a relay on a different host, which is why the relay sets permissive
 * CORS headers of its own.
 *
 * Two tabs pointed at `?device=a` and `?device=b` are two independent replicas
 * with separate logs, so the whole merge story is demonstrable on one machine.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handleSync, RelayStore, SyncRequest } from "./sync/protocol.js";

const ROOT = new URL("../../ui/", import.meta.url).pathname;
const store = new RelayStore();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/sync") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const request = JSON.parse(body || "{}") as SyncRequest;
      const response = handleSync(store, request);
      const payload = JSON.stringify(response);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(payload);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(err) }));
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ops: store.size, have: store.version }));
  }

  // Static files, with the path normalised so `..` cannot escape the folder.
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const path = join(ROOT, rel);
  if (!path.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const file = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

const port = Number(process.env.PORT ?? 5173);
server.listen(port, () => {
  console.log(`tether  http://127.0.0.1:${port}/?device=a`);
  console.log(`        http://127.0.0.1:${port}/?device=b   (a second device)`);
});
