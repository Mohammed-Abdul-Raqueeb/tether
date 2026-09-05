/**
 * The relay server.
 *
 * Roughly a hundred lines, on purpose. Everything that could be wrong with a
 * sync server — merge bugs, conflict policy, schema migrations tied to the
 * client's data model — is absent because it does not understand the payload.
 * It appends opaque rows and lists them back.
 *
 * Persistence is a single SQLite table so a restart does not force every
 * device into a full re-upload. The relay holding no state at all would also
 * be correct, just slower to recover.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Op } from "../core/ops.js";
import { handleSync, RelayStore, SyncRequest } from "./protocol.js";

export interface RelayOptions {
  port?: number;
  /** SQLite file. Omit for an in-memory relay. */
  dbPath?: string;
  quiet?: boolean;
}

/** Durable backing for a relay, so a restart does not lose the mailbox. */
class RelayDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ops (
        replica TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        lamport INTEGER NOT NULL,
        body    TEXT NOT NULL,
        PRIMARY KEY (replica, seq)
      )
    `);
  }

  load(): Op[] {
    const rows = this.db.prepare("SELECT body FROM ops ORDER BY lamport").all() as {
      body: string;
    }[];
    return rows.map((r) => JSON.parse(r.body) as Op);
  }

  save(ops: Op[]): void {
    if (!ops.length) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO ops(replica, seq, lamport, body) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const op of ops) {
        insert.run(op.id.replica, op.id.seq, op.id.lamport, JSON.stringify(op));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function startRelay(options: RelayOptions = {}) {
  const store = new RelayStore();
  const db = options.dbPath ? new RelayDb(options.dbPath) : null;
  if (db) {
    const restored = db.load();
    store.ingest(restored);
    if (!options.quiet && restored.length) {
      console.log(`relay restored ${restored.length} operations`);
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Local-first tool: the relay is expected to be on a LAN or a personal
    // host, and the UI is served from a different origin during development.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return end(res, 204, "");

    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, ops: store.size, have: store.version });
    }

    if (req.method !== "POST" || req.url !== "/sync") {
      return json(res, 404, { error: "POST /sync or GET /health" });
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // A device that has been offline for a month can legitimately push a
      // large batch, but not an unbounded one.
      if (body.length > 64 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const request = JSON.parse(body || "{}") as SyncRequest;
        const response = handleSync(store, request);
        db?.save(request.ops ?? []);
        if (!options.quiet && (request.ops?.length || response.ops.length)) {
          console.log(`sync  in:${request.ops?.length ?? 0}  out:${response.ops.length}  held:${store.size}`);
        }
        json(res, 200, response);
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
    });
  });

  const port = options.port ?? 8787;
  server.listen(port, () => {
    if (!options.quiet) console.log(`relay listening on http://127.0.0.1:${port}`);
  });

  return {
    server,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db?.close();
          resolve();
        });
      }),
  };
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function end(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code);
  res.end(body);
}

// `node dist/sync/server.js --port 8787 --db relay.db`
const isMain = process.argv[1]?.endsWith("server.js");
if (isMain) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  startRelay({ port: Number(arg("port") ?? 8787), dbPath: arg("db") });
}
