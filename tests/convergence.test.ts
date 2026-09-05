/**
 * Convergence.
 *
 * The shape of every test here is the same, and it is the shape the whole
 * project exists to satisfy:
 *
 *   1. bring replicas to a shared starting state
 *   2. cut the network
 *   3. make conflicting edits on each side
 *   4. reconnect
 *   5. assert every replica holds byte-identical state — and that nothing a
 *      person typed was thrown away
 *
 * Step 5 is two assertions, not one, and the second is the interesting one.
 * Convergence alone is easy: a rule that deletes everything on conflict
 * converges perfectly. These tests pin down *what* the converged state
 * contains, which is where the design decisions actually live.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cluster } from "./harness.js";

describe("convergence", () => {
  it("merges concurrent edits to different fields of the same task", async () => {
    // This is the case whole-record last-write-wins gets wrong. Two devices
    // touch one task; neither edit conflicts with the other in any meaningful
    // sense; a row-level overwrite still destroys one of them.
    const c = new Cluster(2);
    const task = c.at(0).createTask("Buy milk");
    await c.settle();

    // --- offline ---
    c.at(0).setTask(task, "title", "Buy oat milk");
    c.at(1).setTask(task, "done", true);
    c.at(1).setTask(task, "priority", "high");

    // Before syncing, each device sees only its own change.
    assert.equal(c.at(0).snapshot().tasks[0].title, "Buy oat milk");
    assert.equal(c.at(0).snapshot().tasks[0].done, false);

    // --- reconnect ---
    await c.settle();
    const state = c.assertConverged();
    c.assertSameVersion();
    c.assertNothingPending();

    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, "Buy oat milk", "the title edit survived");
    assert.equal(state.tasks[0].done, true, "the completion survived");
    assert.equal(state.tasks[0].priority, "high", "the priority survived");
    assert.deepEqual(state.tasks[0].conflicts, [], "different fields are not a conflict");
  });

  it("keeps both values when the same field is edited concurrently", async () => {
    // The genuinely conflicting case. A winner has to be chosen, but the
    // loser is kept and surfaced rather than silently discarded.
    const c = new Cluster(2);
    const task = c.at(0).createTask("Call the dentist");
    await c.settle();

    c.at(0).setTask(task, "title", "Call the dentist on Monday");
    c.at(1).setTask(task, "title", "Call the dentist about the filling");

    await c.settle();
    const state = c.assertConverged();

    const conflict = state.tasks[0].conflicts.find((x) => x.field === "title")!;
    assert.ok(conflict, "the conflict is reported to the interface");
    assert.equal(conflict.alternatives.length, 1);

    const kept = [conflict.chosen, ...conflict.alternatives].sort();
    assert.deepEqual(
      kept,
      ["Call the dentist about the filling", "Call the dentist on Monday"].sort(),
      "neither version was thrown away",
    );
    // Both devices display the same one without having consulted each other.
    assert.equal(c.at(0).snapshot().tasks[0].title, c.at(1).snapshot().tasks[0].title);
  });

  it("collapses a conflict when someone resolves it", async () => {
    const c = new Cluster(2);
    const task = c.at(0).createTask("Draft the proposal");
    await c.settle();

    c.at(0).setTask(task, "title", "Draft the proposal by Friday");
    c.at(1).setTask(task, "title", "Draft the proposal for Priya");
    await c.settle();
    assert.equal(c.at(0).snapshot().tasks[0].conflicts.length, 1);

    // Resolving is an ordinary edit. Because it observed both competing
    // values it supersedes both, with no special API and no server involved.
    c.at(1).setTask(task, "title", "Draft the proposal for Priya by Friday");
    await c.settle();

    const state = c.assertConverged();
    assert.equal(state.tasks[0].title, "Draft the proposal for Priya by Friday");
    assert.deepEqual(state.tasks[0].conflicts, []);
  });

  it("merges concurrent edits to different parts of one note", async () => {
    // A register cannot do this at all: the body is one field, so one of the
    // two paragraphs would be destroyed. The sequence CRDT merges per
    // character and both edits land where they were typed.
    const c = new Cluster(2);
    const note = c.at(0).createNote("Meeting", "agenda: budget");
    await c.settle();

    c.at(0).insertText(note, 0, "TODO ");                       // at the start
    c.at(1).insertText(note, "agenda: budget".length, ", staffing"); // at the end

    await c.settle();
    const state = c.assertConverged();
    assert.equal(state.notes[0].body, "TODO agenda: budget, staffing");
  });

  it("orders concurrent insertions at the same position identically everywhere", async () => {
    // Two people typing at the same spot must not interleave into each other,
    // and every replica must choose the same arrangement.
    const c = new Cluster(3);
    const note = c.at(0).createNote("Race", "AB");
    await c.settle();

    c.at(0).insertText(note, 1, "111");
    c.at(1).insertText(note, 1, "222");
    c.at(2).insertText(note, 1, "333");

    await c.settle();
    const state = c.assertConverged();

    const body = state.notes[0].body;
    assert.equal(body.length, "AB".length + 9);
    assert.ok(body.startsWith("A") && body.endsWith("B"));
    // Each run stays contiguous — no "132132132".
    for (const run of ["111", "222", "333"]) {
      assert.ok(body.includes(run), `run ${run} was split apart: ${body}`);
    }
  });

  it("survives concurrent deletion and insertion in the same region", async () => {
    const c = new Cluster(2);
    const note = c.at(0).createNote("Overlap", "hello world");
    await c.settle();

    c.at(0).deleteText(note, 0, 6);          // remove "hello "
    c.at(1).insertText(note, 5, " there");   // "hello there world"

    await c.settle();
    const state = c.assertConverged();
    // The deletion removed exactly the characters it named; the insertion is
    // anchored to a character that still exists as a tombstone, so it keeps
    // its position instead of being orphaned.
    assert.equal(state.notes[0].body, " thereworld");
  });

  it("resolves concurrent delete and edit as a delete, without losing the edit", async () => {
    const c = new Cluster(2);
    const task = c.at(0).createTask("Cancel the subscription");
    await c.settle();

    c.at(0).removeTask(task);
    c.at(1).setTask(task, "title", "Cancel the subscription before the 30th");

    await c.settle();
    c.assertConverged();
    assert.equal(c.at(0).snapshot().tasks.length, 0, "the deletion holds");

    // The edit was not destroyed — it was in a register the whole time, and
    // restoring the task brings it back on every device.
    c.at(1).restoreTask(task);
    await c.settle();
    const state = c.assertConverged();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, "Cancel the subscription before the 30th");
  });

  it("lets a restore win over the deletes it has seen", async () => {
    // Both devices delete; one then changes its mind. The restore is a new
    // add-tag no existing delete observed, so it survives the merge.
    const c = new Cluster(2);
    const task = c.at(0).createTask("Renew passport");
    await c.settle();

    c.at(0).removeTask(task);
    c.at(1).removeTask(task);
    await c.settle();
    assert.equal(c.assertConverged().tasks.length, 0);

    c.at(0).restoreTask(task);
    await c.settle();
    const state = c.assertConverged();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, "Renew passport");
  });

  it("converges across a three-way partition", async () => {
    const c = new Cluster(3);
    const shared = c.at(0).createTask("Shared");
    c.at(0).createNote("Log", "start");
    await c.settle();

    // Each device works alone, with no contact for a while.
    c.at(0).setTask(shared, "priority", "high");
    c.at(0).createTask("Only on device 0");

    c.at(1).toggleTask(shared);
    const noteId = c.at(1).snapshot().notes[0].id;
    c.at(1).insertText(noteId, 5, " middle");

    c.at(2).setTask(shared, "title", "Shared, renamed");
    c.at(2).createNote("Device 2 note", "hello");

    // Two of them meet first, which is the ordering a star relay actually
    // produces and a two-replica test never exercises.
    await c.settle([0, 1]);
    await c.settle();

    const state = c.assertConverged();
    c.assertSameVersion();
    c.assertNothingPending();

    assert.equal(state.tasks.length, 2);
    assert.equal(state.notes.length, 2);
    const merged = state.tasks.find((t) => t.id === shared)!;
    assert.equal(merged.title, "Shared, renamed");
    assert.equal(merged.done, true);
    assert.equal(merged.priority, "high");
    assert.equal(state.notes.find((n) => n.id === noteId)!.body, "start middle");
  });

  it("is unchanged by syncing again", async () => {
    // Idempotence at the protocol level: a converged cluster that keeps
    // talking must not drift, and must stop transferring anything.
    const c = new Cluster(3);
    const t = c.at(0).createTask("Stable");
    c.at(1).createNote("Also stable", "text");
    await c.settle();
    c.at(2).setTask(t, "done", true);
    await c.settle();

    const before = JSON.stringify(c.assertConverged());
    const transfersBefore = c.transfers.length;
    await c.settle();
    const after = JSON.stringify(c.assertConverged());

    assert.equal(after, before, "state changed with no edits in between");
    for (const t of c.transfers.slice(transfersBefore)) {
      assert.equal(t.sent + t.received, 0, "a settled cluster kept transferring data");
    }
  });

  it("converges when a replica has been offline for a long time", async () => {
    const c = new Cluster(3);
    c.at(0).createTask("Before the trip");
    await c.settle();

    // Replica 2 goes away. The others keep working for a long while.
    for (let i = 0; i < 200; i++) {
      c.at(i % 2).createTask(`Task ${i}`);
      await c.settle([0, 1]);
    }
    // Meanwhile replica 2 was not idle either.
    for (let i = 0; i < 50; i++) c.at(2).createTask(`Offline task ${i}`);

    await c.settle();
    const state = c.assertConverged();
    assert.equal(state.tasks.length, 1 + 200 + 50);
    c.assertNothingPending();
  });
});
