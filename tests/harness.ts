/**
 * Test harness.
 *
 * A `Cluster` is some replicas and a relay, with the network under the test's
 * control. Nothing here is asynchronous in a way a test has to wait for, so
 * "offline for a week" is expressed as "did not call sync", and a partition is
 * a set of replica indices allowed to talk. That makes every scenario exactly
 * reproducible, which is the only way a convergence test is worth anything —
 * a flaky one proves nothing at all.
 */

import assert from "node:assert/strict";
import { Replica } from "../src/core/replica.js";
import { Snapshot } from "../src/core/workspace.js";
import { MemoryStorage } from "../src/storage/storage.js";
import { DirectTransport, RelayStore, sync } from "../src/sync/protocol.js";

export function newReplica(): Replica {
  return Replica.open(new MemoryStorage());
}

export class Cluster {
  readonly relay = new RelayStore();
  readonly replicas: Replica[] = [];
  private readonly transport = new DirectTransport(this.relay);
  /** Every sync performed, for asserting on transfer volume. */
  readonly transfers: { replica: number; sent: number; received: number; bytes: number }[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) this.replicas.push(newReplica());
  }

  at(i: number): Replica {
    return this.replicas[i];
  }

  /** One replica exchanges with the relay once. */
  async syncOne(i: number): Promise<void> {
    const stats = await sync(this.replicas[i], this.transport);
    this.transfers.push({
      replica: i,
      sent: stats.sent,
      received: stats.received,
      bytes: stats.bytesSent + stats.bytesReceived,
    });
  }

  /**
   * Sync the given replicas until nothing moves.
   *
   * A star topology needs more than one pass: the first pass uploads
   * everyone's operations to the relay, and only a later pass can hand them
   * back down. Looping until a full round transfers nothing is both the
   * simplest correct rule and a check in itself — if it never settles, the
   * protocol is not converging and the test hangs instead of quietly passing.
   */
  async settle(which?: number[]): Promise<number> {
    const indices = which ?? this.replicas.map((_, i) => i);
    for (let round = 0; round < 20; round++) {
      let moved = 0;
      for (const i of indices) {
        const before = this.transfers.length;
        await this.syncOne(i);
        const t = this.transfers[before];
        moved += t.sent + t.received;
      }
      if (moved === 0) return round + 1;
    }
    throw new Error("cluster failed to settle within 20 rounds");
  }

  snapshots(which?: number[]): Snapshot[] {
    const indices = which ?? this.replicas.map((_, i) => i);
    return indices.map((i) => this.replicas[i].snapshot());
  }

  /**
   * Assert that every replica holds exactly the same visible state.
   *
   * Compared as canonical JSON, so this covers task ordering, text ordering,
   * conflict sets and every field — not just the parts a test remembered to
   * look at.
   */
  assertConverged(which?: number[]): Snapshot {
    const snaps = this.snapshots(which);
    const first = JSON.stringify(snaps[0], null, 1);
    for (let i = 1; i < snaps.length; i++) {
      const other = JSON.stringify(snaps[i], null, 1);
      assert.equal(other, first, `replica ${i} diverged from replica 0`);
    }
    return snaps[0];
  }

  /** Version vectors must also agree once settled, not just the state. */
  assertSameVersion(): void {
    const first = JSON.stringify(sortKeys(this.replicas[0].version));
    for (let i = 1; i < this.replicas.length; i++) {
      assert.equal(
        JSON.stringify(sortKeys(this.replicas[i].version)),
        first,
        `replica ${i} has a different version vector`,
      );
    }
  }

  /** No replica may be left holding operations it could not apply. */
  assertNothingPending(): void {
    for (let i = 0; i < this.replicas.length; i++) {
      const log = this.replicas[i].log;
      assert.equal(
        log.pendingCount,
        0,
        `replica ${i} still buffering ${log.pendingCount}, waiting for ${log.missingDependencies().join(", ")}`,
      );
    }
  }

  totalBytes(): number {
    return this.transfers.reduce((n, t) => n + t.bytes, 0);
  }
}

function sortKeys(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Deterministic PRNG, so a failing fuzz seed can be replayed exactly. */
export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
