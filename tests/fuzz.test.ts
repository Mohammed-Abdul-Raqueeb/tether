/**
 * Randomised convergence.
 *
 * The hand-written tests check the scenarios I thought of. This one checks the
 * ones I did not: random replicas, random edits, random partitions, random
 * sync order, thousands of times. That distinction matters for a CRDT more
 * than for most code, because the failure mode is not a crash — it is two
 * devices quietly showing different text after an unusual interleaving, which
 * no amount of manual testing reliably reproduces.
 *
 * Every run is seeded, so a failure prints a seed that replays the exact
 * schedule that broke it.
 *
 * What is asserted after each scenario:
 *
 *   * every replica's snapshot is byte-identical
 *   * every replica's version vector is identical
 *   * nothing is left buffered waiting for a dependency that never arrives
 *   * the merged text is a supersequence of what survived on each side, so
 *     "converged" cannot be satisfied by throwing edits away
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cluster, Random } from "./harness.js";

interface Scenario {
  seed: number;
  replicas: number;
  steps: number;
  /**
   * Whether replicas may delete text.
   *
   * This flag exists because the two properties worth asserting need
   * different conditions. Convergence holds always. "No insertion was lost"
   * only holds when nobody deletes — otherwise a character legitimately
   * vanishes because another replica removed it, and an assertion that treats
   * that as data loss is simply wrong. Conflating the two produced a failing
   * test that was the test's fault, not the CRDT's.
   */
  deletes: boolean;
}

async function runScenario({ seed, replicas, steps, deletes }: Scenario): Promise<void> {
  const rng = new Random(seed);
  const c = new Cluster(replicas);

  // A shared starting point, so replicas have something to conflict over
  // rather than only creating disjoint objects.
  const seedTasks: string[] = [];
  for (let i = 0; i < 3; i++) seedTasks.push(c.at(0).createTask(`task ${i}`));
  const seedNote = c.at(0).createNote("shared", "abcdef");
  await c.settle();

  for (let step = 0; step < steps; step++) {
    const i = rng.int(replicas);
    const replica = c.at(i);
    const snapshot = replica.snapshot();

    switch (rng.int(8)) {
      case 0:
        replica.createTask(`t${seed}-${step}`);
        break;
      case 1: {
        if (!snapshot.tasks.length) break;
        const task = rng.pick(snapshot.tasks);
        replica.setTask(task.id, rng.pick(["title", "priority", "note"]), `v${step}`);
        break;
      }
      case 2: {
        if (!snapshot.tasks.length) break;
        replica.toggleTask(rng.pick(snapshot.tasks).id);
        break;
      }
      case 3: {
        if (!snapshot.tasks.length) break;
        replica.removeTask(rng.pick(snapshot.tasks).id);
        break;
      }
      case 4: {
        // Restore something that may or may not currently exist, which is how
        // a delete and an undo end up concurrent.
        replica.restoreTask(rng.pick(seedTasks));
        break;
      }
      case 5: {
        if (!snapshot.notes.length) break;
        const note = rng.pick(snapshot.notes);
        const at = rng.int(note.body.length + 1);
        replica.insertText(note.id, at, String.fromCharCode(97 + rng.int(26)).repeat(1 + rng.int(3)));
        break;
      }
      case 6: {
        if (!deletes || !snapshot.notes.length) break;
        const note = rng.pick(snapshot.notes);
        if (!note.body.length) break;
        const start = rng.int(note.body.length);
        replica.deleteText(note.id, start, start + 1 + rng.int(3));
        break;
      }
      case 7: {
        // A partial sync: only some replicas reach the relay right now. This
        // is what produces the states a two-device test never reaches.
        const group = c.replicas
          .map((_, index) => index)
          .filter(() => rng.chance(0.5));
        if (group.length) {
          for (const index of group) await c.syncOne(index);
        }
        break;
      }
    }
  }

  // Text present on each replica before the final merge; the merge must not
  // lose characters that were never deleted.
  const before = c.snapshots().map((s) => s.notes.find((n) => n.id === seedNote)?.body ?? "");

  await c.settle();

  c.assertConverged();
  c.assertSameVersion();
  c.assertNothingPending();

  if (!deletes) {
    const merged = c.at(0).snapshot().notes.find((n) => n.id === seedNote)?.body ?? "";
    for (let i = 0; i < before.length; i++) {
      assert.ok(
        isSubsequence(before[i], merged),
        `replica ${i} lost text in the merge (seed ${seed})\n  had:    ${JSON.stringify(before[i])}\n  merged: ${JSON.stringify(merged)}`,
      );
    }
  }
}

/**
 * Every character one replica could see must still appear, in the same
 * relative order, after merging.
 *
 * Subsequence rather than equality because other replicas legitimately insert
 * new characters in between. Applied only to delete-free schedules, where any
 * missing character is unambiguously a merge bug rather than someone else's
 * deletion arriving.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (i < needle.length && needle[i] === ch) i++;
  }
  return i === needle.length;
}

describe("randomised convergence", () => {
  it("converges for 200 random two-replica schedules", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      await runScenario({ seed, replicas: 2, steps: 40, deletes: true });
    }
  });

  it("converges for 120 random three-replica schedules", async () => {
    for (let seed = 1000; seed < 1120; seed++) {
      await runScenario({ seed, replicas: 3, steps: 60, deletes: true });
    }
  });

  it("converges for 40 random five-replica schedules", async () => {
    for (let seed = 5000; seed < 5040; seed++) {
      await runScenario({ seed, replicas: 5, steps: 100, deletes: true });
    }
  });

  it("loses no insertion across 150 delete-free schedules", async () => {
    // The strongest statement available: with nothing being deleted, every
    // character every replica saw must survive the merge in the same relative
    // order. Convergence alone would permit a merge that discards text.
    for (let seed = 20000; seed < 20150; seed++) {
      await runScenario({ seed, replicas: 3, steps: 50, deletes: false });
    }
  });

  it("converges under heavy contention on one note", async () => {
    // Every replica edits the same short string constantly, which maximises
    // the number of concurrent insertions competing for the same position —
    // the case the RGA ordering rule exists for.
    for (let seed = 9000; seed < 9020; seed++) {
      const rng = new Random(seed);
      const c = new Cluster(4);
      const note = c.at(0).createNote("hot", "0123456789");
      await c.settle();

      for (let step = 0; step < 120; step++) {
        const i = rng.int(4);
        const body = c.at(i).snapshot().notes[0].body;
        if (rng.chance(0.7) || body.length < 3) {
          c.at(i).insertText(note, rng.int(body.length + 1), String(rng.int(10)));
        } else {
          const start = rng.int(body.length - 1);
          c.at(i).deleteText(note, start, start + 1);
        }
        if (rng.chance(0.25)) await c.syncOne(rng.int(4));
      }

      await c.settle();
      c.assertConverged();
      c.assertNothingPending();
    }
  });
});
