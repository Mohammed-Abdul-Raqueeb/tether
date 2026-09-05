/**
 * Delivery guarantees, transfer size and durability.
 *
 * The convergence tests assume the log delivers operations exactly once and in
 * causal order. This file attacks that assumption directly: operations
 * reversed, shuffled, duplicated, truncated and split across a restart.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Replica } from "../src/core/replica.js";
import { vvDominates, vvConcurrent } from "../src/core/clock.js";
import { MemoryStorage, SqliteStorage } from "../src/storage/storage.js";
import { DirectTransport, RelayStore, sync, OfflineTransport, AutoSync } from "../src/sync/protocol.js";
import { Cluster, newReplica, Random } from "./harness.js";

describe("operation log delivery", () => {
  it("applies operations delivered in reverse order", async () => {
    // Reverse order maximally violates causality: every operation arrives
    // before the thing it depends on. The buffer has to hold all of them and
    // unwind once the first one lands.
    const source = newReplica();
    const task = source.createTask("ordered");
    source.setTask(task, "title", "renamed");
    source.setTask(task, "done", true);
    const note = source.createNote("n", "hello world");
    source.deleteText(note, 0, 5);

    const ops = source.since({});
    const target = newReplica();
    target.receive([...ops].reverse());

    assert.equal(target.log.pendingCount, 0, `stuck on ${target.log.missingDependencies()}`);
    assert.deepEqual(target.snapshot(), source.snapshot());
  });

  it("applies operations delivered in many random orders", async () => {
    const source = newReplica();
    const task = source.createTask("shuffled");
    source.setTask(task, "priority", "high");
    const note = source.createNote("n", "abcdefgh");
    source.insertText(note, 4, "XYZ");
    source.deleteText(note, 0, 2);
    const ops = source.since({});

    for (let seed = 1; seed <= 100; seed++) {
      const rng = new Random(seed);
      const shuffled = [...ops];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const target = newReplica();
      target.receive(shuffled);
      assert.equal(target.log.pendingCount, 0, `seed ${seed} stuck`);
      assert.deepEqual(target.snapshot(), source.snapshot(), `seed ${seed} diverged`);
    }
  });

  it("ignores duplicates however many times they arrive", async () => {
    // Redelivery is not hypothetical — a retry after a timeout that actually
    // succeeded produces exactly this. For a multi-value register a second
    // application would resurrect a superseded value, so it must be blocked
    // rather than merely tolerated.
    const source = newReplica();
    const task = source.createTask("dupes");
    source.setTask(task, "title", "first");
    source.setTask(task, "title", "second");
    const ops = source.since({});

    const target = newReplica();
    const first = target.receive(ops);
    const second = target.receive(ops);
    const third = target.receive([...ops, ...ops]);

    assert.equal(first.applied, ops.length);
    assert.equal(second.applied, 0);
    assert.equal(second.duplicate, ops.length);
    assert.equal(third.applied, 0);
    assert.deepEqual(target.snapshot(), source.snapshot());
    assert.equal(target.snapshot().tasks[0].conflicts.length, 0, "a duplicate revived a dead value");
  });

  it("holds operations whose dependencies never arrive, without corrupting state", async () => {
    const source = newReplica();
    const note = source.createNote("partial", "hello");
    source.insertText(note, 5, " world");
    const ops = source.since({});

    // Deliver only the tail: the insertions have origins that will never come.
    const target = newReplica();
    target.receive(ops.slice(-3));
    assert.ok(target.log.pendingCount > 0, "should be waiting on the missing prefix");
    assert.deepEqual(target.snapshot(), { tasks: [], notes: [] }, "nothing half-applied");

    // The rest turns up later and everything unwinds.
    target.receive(ops);
    assert.equal(target.log.pendingCount, 0);
    assert.deepEqual(target.snapshot(), source.snapshot());
  });

  it("does not advance the version vector across a gap", async () => {
    // vv[replica] = n is a promise that 1..n are all held. Advancing it over a
    // hole would make this replica stop asking for operations it never got.
    const source = newReplica();
    source.createTask("a");
    source.createTask("b");
    const ops = source.since({});

    const target = newReplica();
    target.receive([ops[0], ops[ops.length - 1]]); // skip the middle
    assert.equal(target.version[ops[0].id.replica], 1, "vector jumped over a missing operation");
  });
});

describe("version vectors", () => {
  it("detects divergence and dominance", async () => {
    const c = new Cluster(2);
    c.at(0).createTask("shared");
    await c.settle();
    assert.ok(vvDominates(c.at(0).version, c.at(1).version));

    c.at(0).createTask("only on 0");
    c.at(1).createTask("only on 1");
    assert.ok(
      vvConcurrent(c.at(0).version, c.at(1).version),
      "two offline devices with unshared edits are concurrent, not ordered",
    );

    await c.settle();
    assert.ok(vvDominates(c.at(0).version, c.at(1).version));
    assert.ok(vvDominates(c.at(1).version, c.at(0).version));
  });
});

describe("sync transfers only what is missing", () => {
  it("sends one operation for a one-character edit on a large log", async () => {
    const c = new Cluster(2);
    for (let i = 0; i < 300; i++) c.at(0).createTask(`bulk ${i}`);
    const note = c.at(0).createNote("big", "x".repeat(500));
    await c.settle();

    const logSize = c.at(0).log.size;
    assert.ok(logSize > 1000, `expected a large log, got ${logSize}`);

    // One keystroke.
    c.at(0).insertText(note, 0, "!");
    const start = c.transfers.length;
    await c.settle();

    const moved = c.transfers.slice(start).reduce((n, t) => n + t.sent + t.received, 0);
    assert.equal(moved, 2, `one keystroke moved ${moved} operations on a ${logSize}-operation log`);
  });

  it("costs nothing when there is nothing to say", async () => {
    const c = new Cluster(3);
    c.at(0).createTask("quiet");
    await c.settle();
    const start = c.transfers.length;
    await c.settle();
    for (const t of c.transfers.slice(start)) {
      assert.equal(t.bytes, 0);
    }
  });

  it("recovers when the cached peer version is wrong", async () => {
    // A stale cache should cost bandwidth, never correctness — that is what
    // makes the optimistic single round trip safe.
    const relay = new RelayStore();
    const transport = new DirectTransport(relay);
    const a = newReplica();
    const b = newReplica();
    a.createTask("one");
    await sync(a, transport);

    a.rememberPeerVersion("relay", {}); // pretend we know nothing
    const stats = await sync(a, transport);
    assert.ok(stats.sent > 0, "should have re-uploaded");

    await sync(b, transport);
    assert.deepEqual(b.snapshot(), a.snapshot());
  });

  it("keeps working while the relay is unreachable", async () => {
    const replica = newReplica();
    const offline = new OfflineTransport();
    await assert.rejects(() => sync(replica, offline));

    // Offline is the normal case, not a degraded one: edits still apply.
    const task = replica.createTask("written on a plane");
    replica.setTask(task, "done", true);
    assert.equal(replica.snapshot().tasks[0].done, true);

    // And nothing was marked as delivered, so it all goes out later.
    const relay = new RelayStore();
    await sync(replica, new DirectTransport(relay));
    assert.equal(relay.size, replica.log.size);
  });

  it("backs off and recovers with AutoSync", async () => {
    const replica = newReplica();
    replica.createTask("eventually");
    let failures = 0;
    const relay = new RelayStore();
    const flaky = {
      calls: 0,
      async exchange(request: Parameters<DirectTransport["exchange"]>[0]) {
        this.calls++;
        if (this.calls < 3) throw new Error("network");
        return new DirectTransport(relay).exchange(request);
      },
    };
    const auto = new AutoSync(replica, flaky, { interval: 1, maxInterval: 5, onError: () => failures++ });
    auto.start();
    await new Promise((r) => setTimeout(r, 120));
    auto.stop();

    assert.ok(failures >= 2, "should have reported the failures");
    assert.equal(relay.size, replica.log.size, "should have caught up once the network returned");
  });
});

describe("durability", () => {
  it("restores identical state from SQLite after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-"));
    const path = join(dir, "device.db");
    try {
      const first = Replica.open(new SqliteStorage(path));
      const replicaId = first.id;
      const task = first.createTask("survives a restart");
      first.setTask(task, "priority", "high");
      const note = first.createNote("journal", "line one");
      first.insertText(note, 8, "\nline two");
      const before = first.snapshot();
      first.close();

      const second = Replica.open(new SqliteStorage(path));
      assert.equal(second.id, replicaId, "replica identity must be stable across restarts");
      assert.deepEqual(second.snapshot(), before);

      // And it must keep minting non-colliding sequence numbers afterwards.
      second.createTask("added after the restart");
      assert.equal(second.snapshot().tasks.length, 2);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a restart mid-conflict without resolving it by accident", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-"));
    const path = join(dir, "device.db");
    try {
      const relay = new RelayStore();
      const transport = new DirectTransport(relay);
      const a = Replica.open(new SqliteStorage(path));
      const b = newReplica();
      const task = a.createTask("contested");
      await sync(a, transport);
      await sync(b, transport);

      a.setTask(task, "title", "version A");
      b.setTask(task, "title", "version B");
      await sync(b, transport);
      await sync(a, transport);
      const conflicted = a.snapshot();
      assert.equal(conflicted.tasks[0].conflicts.length, 1);
      a.close();

      const reopened = Replica.open(new SqliteStorage(path));
      assert.deepEqual(reopened.snapshot(), conflicted, "the conflict must survive a restart intact");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a log stored in a scrambled order", async () => {
    // Nothing guarantees rows come back in causal order after a crash, an
    // index change, or a manual repair. Replay has to be order-independent.
    const source = newReplica();
    const note = source.createNote("scrambled", "abcdef");
    source.insertText(note, 3, "!!");

    const storage = new MemoryStorage();
    const ops = source.since({});
    storage.appendOps([...ops].reverse());
    storage.writeReplicaId(source.id);

    const restored = Replica.open(storage);
    assert.equal(restored.log.pendingCount, 0);
    assert.deepEqual(restored.snapshot(), source.snapshot());
  });
});
