/**
 * Storage adapters for the two shells.
 *
 * The `Storage` interface is synchronous, which is a deliberate constraint:
 * every user action — typing a character, ticking a box — writes operations,
 * and threading promises through that path would make the editor's state
 * depend on I/O timing. So both adapters keep the log in memory and treat the
 * durable copy as a write-behind.
 *
 * The cost is bounded and worth naming: a crash between an edit and its flush
 * loses that edit. Flushes happen per user action, so the window is
 * milliseconds, and the log is append-only so a partial flush is a prefix
 * rather than a corruption.
 */

import type { Storage as ReplicaStorage } from "../src/core/replica.js";
import type { ReplicaId, VersionVector } from "../src/core/clock.js";
import type { Op } from "../src/core/ops.js";

/**
 * Browser storage, backed by localStorage.
 *
 * `namespace` is what makes the two-device demo work: two tabs on the same
 * origin share localStorage, so each simulated device gets its own prefix and
 * therefore its own replica id and its own log. They are as independent as two
 * laptops, and they can only learn about each other through the relay.
 */
export class LocalStorageAdapter implements ReplicaStorage {
  private ops: Op[] = [];
  private index = new Set<string>();

  constructor(private readonly namespace: string) {
    const raw = localStorage.getItem(this.key("ops"));
    if (raw) {
      try {
        this.ops = JSON.parse(raw) as Op[];
        for (const op of this.ops) this.index.add(`${op.id.replica}:${op.id.seq}`);
      } catch {
        // A corrupt log is recoverable: the relay still holds everything that
        // was ever synced, so starting empty costs unsynced local edits only.
        this.ops = [];
      }
    }
  }

  private key(name: string): string {
    return `tether:${this.namespace}:${name}`;
  }

  readReplicaId(): ReplicaId | null {
    return localStorage.getItem(this.key("replica"));
  }
  writeReplicaId(id: ReplicaId): void {
    localStorage.setItem(this.key("replica"), id);
  }
  readOps(): Op[] {
    return this.ops;
  }
  appendOps(ops: Op[]): void {
    let changed = false;
    for (const op of ops) {
      const key = `${op.id.replica}:${op.id.seq}`;
      if (this.index.has(key)) continue;
      this.index.add(key);
      this.ops.push(op);
      changed = true;
    }
    if (changed) localStorage.setItem(this.key("ops"), JSON.stringify(this.ops));
  }
  readPeerVersion(peer: string): VersionVector {
    const raw = localStorage.getItem(this.key(`peer:${peer}`));
    return raw ? (JSON.parse(raw) as VersionVector) : {};
  }
  writePeerVersion(peer: string, vv: VersionVector): void {
    localStorage.setItem(this.key(`peer:${peer}`), JSON.stringify(vv));
  }
  close(): void {}

  /** Bytes held locally, for the storage readout in the UI. */
  get bytes(): number {
    return (localStorage.getItem(this.key("ops")) ?? "").length;
  }
  get opCount(): number {
    return this.ops.length;
  }
  wipe(): void {
    for (const name of ["ops", "replica", "peer:relay"]) localStorage.removeItem(this.key(name));
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Desktop storage, backed by the Rust side's SQLite file.
 *
 * Tauri's `invoke` is asynchronous and the interface is not, so the log is
 * loaded once at startup and writes are queued. `create` is the async door;
 * everything after it is synchronous.
 */
export class TauriAdapter implements ReplicaStorage {
  private queue: Op[] = [];
  private flushing = false;

  private constructor(
    private readonly invoke: Invoke,
    private ops: Op[],
    private replicaId: ReplicaId | null,
    private peers: Record<string, VersionVector>,
  ) {}

  static async create(invoke: Invoke): Promise<TauriAdapter> {
    const bodies = (await invoke("load_ops")) as string[];
    const ops = bodies.map((b) => JSON.parse(b) as Op);
    const replicaId = (await invoke("read_meta", { key: "replica_id" })) as string | null;
    const peerRaw = (await invoke("read_meta", { key: "peer:relay" })) as string | null;
    const peers: Record<string, VersionVector> = {};
    if (peerRaw) peers.relay = JSON.parse(peerRaw) as VersionVector;
    return new TauriAdapter(invoke, ops, replicaId, peers);
  }

  readReplicaId(): ReplicaId | null {
    return this.replicaId;
  }
  writeReplicaId(id: ReplicaId): void {
    this.replicaId = id;
    void this.invoke("write_meta", { key: "replica_id", value: id });
  }
  readOps(): Op[] {
    return this.ops;
  }
  appendOps(ops: Op[]): void {
    this.queue.push(...ops);
    void this.flush();
  }

  /**
   * Serialise flushes so batches reach SQLite in order and never overlap. A
   * second call while one is in flight simply lets the running flush pick up
   * the newly queued operations.
   */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.queue.length);
        await this.invoke("append_ops", {
          ops: batch.map((op) => ({
            key: `${op.id.replica}:${op.id.seq}`,
            replica: op.id.replica,
            seq: op.id.seq,
            lamport: op.id.lamport,
            body: JSON.stringify(op),
          })),
        });
      }
    } finally {
      this.flushing = false;
    }
  }

  readPeerVersion(peer: string): VersionVector {
    return this.peers[peer] ?? {};
  }
  writePeerVersion(peer: string, vv: VersionVector): void {
    this.peers[peer] = vv;
    void this.invoke("write_meta", { key: `peer:${peer}`, value: JSON.stringify(vv) });
  }
  close(): void {}
}
