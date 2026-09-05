/**
 * The sync protocol.
 *
 * # The relay knows nothing
 *
 * It stores operations keyed by `(replica, seq)` and hands back the ones a
 * caller lacks. It never inspects an operation's contents, never merges, never
 * resolves a conflict, and has no idea what a task or a note is. Two
 * consequences follow, and they are the reason for the design:
 *
 *   * **The server cannot corrupt the data.** All resolution happens on
 *     devices, from the same operations, by the same deterministic rules. A
 *     buggy relay can lose or delay or duplicate operations, and duplication
 *     and reordering are already handled; loss is repaired by the next sync.
 *   * **It is replaceable.** Anything that can store and list opaque blobs —
 *     S3, a shared folder, a USB stick — can carry this protocol. Nothing here
 *     depends on it being online, ordered, or even the same relay twice.
 *
 * # One round trip, and only the difference
 *
 * ```
 *   client → { have: clientVV, ops: [ops the relay is thought to lack] }
 *   client ← { have: relayVV,  ops: [ops the client lacks] }
 * ```
 *
 * The client remembers the relay's version vector from last time, so it can
 * decide what to upload without asking first. If that cache is stale it sends
 * a few operations the relay already has, which cost bandwidth and nothing
 * else — operations are idempotent, so a wrong guess is never a correctness
 * problem. If the cache is missing entirely the first sync is a full upload,
 * which is also correct, just slower.
 *
 * Transfer is proportional to the number of operations either side is missing.
 * `tests/sync.test.ts` asserts that a one-character edit on a log with
 * thousands of operations transfers exactly one.
 */

import { VersionVector, vvGet, vvSet, vvClone, vvMerge } from "../core/clock.js";
import { Op, wireSize } from "../core/ops.js";
import { Replica } from "../core/replica.js";

export interface SyncRequest {
  have: VersionVector;
  ops: Op[];
}

export interface SyncResponse {
  have: VersionVector;
  ops: Op[];
}

export interface SyncStats {
  sent: number;
  received: number;
  applied: number;
  duplicate: number;
  pending: number;
  bytesSent: number;
  bytesReceived: number;
}

/** Anything that can carry a request to a relay. */
export interface Transport {
  exchange(request: SyncRequest): Promise<SyncResponse>;
}

/**
 * The relay's operation store.
 *
 * Dense per-replica arrays indexed by `seq - 1`, so answering "what am I
 * missing" starts at the caller's high-water mark instead of scanning.
 */
export class RelayStore {
  private byReplica = new Map<string, Op[]>();
  private vv: VersionVector = {};

  get version(): VersionVector {
    return vvClone(this.vv);
  }

  get size(): number {
    let n = 0;
    for (const ops of this.byReplica.values()) n += ops.filter(Boolean).length;
    return n;
  }

  ingest(ops: Op[]): number {
    let stored = 0;
    for (const op of ops) {
      let list = this.byReplica.get(op.id.replica);
      if (!list) {
        list = [];
        this.byReplica.set(op.id.replica, list);
      }
      if (list[op.id.seq - 1]) continue; // already held
      list[op.id.seq - 1] = op;
      stored++;
    }
    // Advance only over a contiguous prefix, for the same reason the client
    // does: the vector is a promise that nothing below it is missing.
    for (const [replica, list] of this.byReplica) {
      let seq = vvGet(this.vv, replica);
      while (list[seq]) seq++;
      vvSet(this.vv, replica, seq);
    }
    return stored;
  }

  since(theirs: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [replica, list] of this.byReplica) {
      for (let i = vvGet(theirs, replica); i < list.length; i++) {
        if (list[i]) out.push(list[i]);
      }
    }
    return out.sort((a, b) => a.id.lamport - b.id.lamport);
  }

  /** All operations, for a relay that persists and restarts. */
  all(): Op[] {
    return this.since({});
  }
}

/** The relay's entire request handler. */
export function handleSync(store: RelayStore, request: SyncRequest): SyncResponse {
  store.ingest(request.ops ?? []);
  return { have: store.version, ops: store.since(request.have ?? {}) };
}

/** In-process transport: the relay called directly, for tests. */
export class DirectTransport implements Transport {
  constructor(private readonly store: RelayStore) {}
  async exchange(request: SyncRequest): Promise<SyncResponse> {
    // Round-trip through JSON so tests exercise the same serialisation the
    // network path uses, and catch anything that is not wire-safe.
    const wire = JSON.parse(JSON.stringify(request)) as SyncRequest;
    return JSON.parse(JSON.stringify(handleSync(this.store, wire))) as SyncResponse;
  }
}

/** A transport that fails, for testing behaviour while offline. */
export class OfflineTransport implements Transport {
  async exchange(): Promise<SyncResponse> {
    throw new Error("offline");
  }
}

export class HttpTransport implements Transport {
  constructor(private readonly url: string) {}
  async exchange(request: SyncRequest): Promise<SyncResponse> {
    const response = await fetch(`${this.url}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`relay returned ${response.status}`);
    return (await response.json()) as SyncResponse;
  }
}

/**
 * Run one sync.
 *
 * Ordering matters here. The peer's version is only recorded *after* its
 * response has been applied, so an exception anywhere in between leaves the
 * cached version untouched and the next attempt simply resends. There is no
 * partial-success state to reason about: a sync either advances the cache or
 * changes nothing.
 */
export async function sync(
  replica: Replica,
  transport: Transport,
  peer = "relay",
): Promise<SyncStats> {
  const cached = replica.peerVersion(peer);
  const outgoing = replica.since(cached);

  const response = await transport.exchange({ have: replica.version, ops: outgoing });
  const report = replica.receive(response.ops ?? []);

  // The relay now holds everything it had plus what was just uploaded.
  const uploaded: VersionVector = {};
  for (const op of outgoing) vvSet(uploaded, op.id.replica, op.id.seq);
  replica.rememberPeerVersion(peer, vvMerge(response.have ?? {}, uploaded));

  return {
    sent: outgoing.length,
    received: (response.ops ?? []).length,
    applied: report.applied,
    duplicate: report.duplicate,
    pending: report.pending,
    bytesSent: outgoing.reduce((n, op) => n + wireSize(op), 0),
    bytesReceived: (response.ops ?? []).reduce((n, op) => n + wireSize(op), 0),
  };
}

/**
 * Background sync with backoff.
 *
 * Failure is the expected case, not an error path — a laptop closes, a train
 * enters a tunnel. Failing quietly and retrying later is the correct
 * behaviour, so `onError` exists for the interface to show a status dot rather
 * than for anything to recover from.
 */
export class AutoSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private running = false;

  constructor(
    private readonly replica: Replica,
    private readonly transport: Transport,
    private readonly options: {
      interval?: number;
      maxInterval?: number;
      onSync?: (stats: SyncStats) => void;
      onError?: (err: unknown) => void;
    } = {},
  ) {
    this.delay = options.interval ?? 2000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    const base = this.options.interval ?? 2000;
    const max = this.options.maxInterval ?? 60000;
    try {
      const stats = await sync(this.replica, this.transport);
      this.delay = base; // reachable again: back to the normal cadence
      this.options.onSync?.(stats);
    } catch (err) {
      this.delay = Math.min(this.delay * 2, max);
      this.options.onError?.(err);
    }
    this.schedule(this.delay);
  }
}
