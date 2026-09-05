/**
 * Persistence.
 *
 * The operation log is the database. State is a fold over it, never written
 * back, which means there is exactly one source of truth and no possibility of
 * a cached view drifting from the log that produced it. It also makes recovery
 * trivial: replay.
 *
 * Two backends. SQLite for the desktop app, memory for tests — the tests use
 * both, because "works in memory" and "survives a restart" are different
 * claims and only one of them is what a user cares about.
 */

import { DatabaseSync } from "node:sqlite";
import { ReplicaId, VersionVector } from "../core/clock.js";
import { Op, opKey, subject } from "../core/ops.js";
import { Storage } from "../core/replica.js";

export class MemoryStorage implements Storage {
  private replicaId: ReplicaId | null = null;
  private ops = new Map<string, Op>();
  private peers = new Map<string, VersionVector>();

  readReplicaId(): ReplicaId | null {
    return this.replicaId;
  }
  writeReplicaId(id: ReplicaId): void {
    this.replicaId = id;
  }
  readOps(): Op[] {
    return [...this.ops.values()];
  }
  appendOps(ops: Op[]): void {
    for (const op of ops) this.ops.set(opKey(op), op);
  }
  readPeerVersion(peer: string): VersionVector {
    return { ...(this.peers.get(peer) ?? {}) };
  }
  writePeerVersion(peer: string, vv: VersionVector): void {
    this.peers.set(peer, { ...vv });
  }
  close(): void {}
}

export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The log is append-only and each write is a user keystroke or a sync
    // batch, so durability per commit matters more than throughput. WAL keeps
    // the UI's reads from blocking behind a sync's writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- The whole database. Primary key is the operation id, which makes
      -- redelivery a no-op at the storage layer as well as in the log.
      CREATE TABLE IF NOT EXISTS ops (
        key     TEXT PRIMARY KEY,
        replica TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        lamport INTEGER NOT NULL,
        subject TEXT NOT NULL,
        body    TEXT NOT NULL
      );

      -- Sync enumerates by (replica, seq); replay reads in Lamport order.
      CREATE INDEX IF NOT EXISTS ops_by_replica ON ops(replica, seq);
      CREATE INDEX IF NOT EXISTS ops_by_lamport ON ops(lamport);
      CREATE INDEX IF NOT EXISTS ops_by_subject ON ops(subject);
    `);
  }

  readReplicaId(): ReplicaId | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'replica_id'").get() as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  writeReplicaId(id: ReplicaId): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('replica_id', ?)")
      .run(id);
  }

  readOps(): Op[] {
    const rows = this.db.prepare("SELECT body FROM ops ORDER BY lamport, replica, seq").all() as {
      body: string;
    }[];
    return rows.map((r) => JSON.parse(r.body) as Op);
  }

  appendOps(ops: Op[]): void {
    if (!ops.length) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO ops(key, replica, seq, lamport, subject, body) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // One transaction per batch: a keystroke is one row, a sync is thousands,
    // and neither should pay a separate fsync per operation.
    this.db.exec("BEGIN");
    try {
      for (const op of ops) {
        insert.run(opKey(op), op.id.replica, op.id.seq, op.id.lamport, subject(op), JSON.stringify(op));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  readPeerVersion(peer: string): VersionVector {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`peer:${peer}`) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as VersionVector) : {};
  }

  writePeerVersion(peer: string, vv: VersionVector): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(`peer:${peer}`, JSON.stringify(vv));
  }

  /** Operation count, for the storage-growth figures in the README. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
