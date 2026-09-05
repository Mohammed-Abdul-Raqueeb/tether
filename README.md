# Tether

Offline-first notes and tasks with real multi-device sync. Every edit is local and immediate; devices reconcile when they can reach each other, and concurrent edits merge instead of overwriting.

There is no CRDT library here. The register, the sequence CRDT, the operation log, the version vectors and the sync protocol are all in `src/core` and `src/sync`, about 1,600 lines of TypeScript, against 1,000 lines of tests.

```
npm install
npm test          # 30 tests, including 530 randomised merge schedules
npm run demo      # narrated two-device merge, printed to the terminal
npm run app       # browser build: open ?device=a and ?device=b in two tabs
```

---

## What "no last-write-wins data loss" actually means

The phrase is used loosely, so here is the precise claim, split into the three cases that behave differently.

**Different fields of the same object, edited concurrently.** Rename a task on your laptop while ticking it done on your phone. Whole-record last-write-wins destroys one of those edits even though nothing was in conflict. Tether keeps both, because every field is its own register.

**The same field, edited concurrently.** Something has to be displayed, so a winner is chosen by Lamport timestamp with the replica id breaking ties — deterministic, computed offline, identical on every device. The losing value is *kept and surfaced* rather than discarded, so the interface can offer a choice. Picking one is an ordinary edit that observes both values and therefore supersedes both, which collapses the conflict everywhere with no special API and no server involvement.

**A note's body.** No amount of field granularity helps here, because the body is one field. Text uses a sequence CRDT (RGA) that merges per character, so two people editing different paragraphs offline both keep their work.

That third case is the one worth demonstrating:

```
laptop, offline:  "PLAN: fly out monday"
phone,  offline:  "fly out monday, back friday"
after sync, both: "PLAN: fly out monday, back friday"
```

Convergence alone is a low bar — a rule that deletes everything on conflict converges perfectly. The tests assert what the converged state *contains*, not just that the two agree.

## Two clocks, doing different jobs

Conflating these is the usual way to get a CRDT subtly wrong, so they are separate types.

| | Lamport clock | Version vector |
|---|---|---|
| shape | one integer per replica | one counter per replica |
| answers | "which of these came first?" | "which operations do I already have?" |
| used for | tie-breaks, register winners, RGA ordering | sync, deduplication, causal readiness |

A version vector cannot break ties, because concurrent operations are by definition unordered by it. A Lamport clock cannot tell you what you are missing, because a scalar cannot distinguish forty operations from twenty-and-twenty. Hence both.

The RGA in particular depends on element ids being *Lamport* timestamps rather than bare per-replica counters — the ordering rule (skip right while the neighbour's id is greater) is only correct because a character typed after seeing another always carries a strictly greater Lamport value, which makes subtrees of later insertions contiguous and entirely greater than their origin.

## The operation log

Operations carry `{ replica, seq, lamport }`. `seq` has no gaps, which is what makes a version vector a complete description of a replica's knowledge in O(replicas) space instead of O(operations).

Op-based CRDTs demand exactly-once, causally-ordered delivery. Both are enforced rather than assumed:

- **Exactly once** — the version vector plus an applied set. Redelivery is free. It has to be: applying a register write twice would resurrect a value a later write had already superseded.
- **After dependencies** — each operation declares what it needs (`dependencies()` in `src/core/ops.ts`). Anything early is parked in a pending buffer and retried when something else lands, so delivery order stops being a correctness concern.
- **No gaps in the vector** — `vv[replica] = 7` promises operations 1 through 7 are all held, so a sequence number is only recorded once its predecessor applies. Advancing over a hole would make a device quietly stop asking for what it never received.

`tests/protocol.test.ts` delivers operations reversed, shuffled a hundred ways, duplicated, and truncated mid-stream.

## Conflict detection without clock agreement

Every field write carries `prev`: the ids of the values it observed.

```ts
{ kind: "task.set", task, field: "title", value: "Buy oat milk", prev: ["a1b2:7"] }
```

If a write observed the value it replaces, it causally follows it and simply wins. If it did not, the two were concurrent and both are kept. No timestamps are consulted for this decision and no clocks need to agree — which matters, because device clocks do not agree.

## Deletion is an observed-remove, not a flag

A task exists if it holds at least one un-removed add-tag. Deleting removes only the tags the deleting device could see.

A boolean `deleted` register fails in exactly the case offline sync makes common: two devices delete while partitioned, one then restores, and the outcome depends on timestamps nobody controls. With observed-remove, a restore issues a new tag that no existing delete has observed, so it reliably beats deletes that happened before it and never beats deletes that happened after.

Concurrent delete-and-edit resolves as delete — an edit is not an add, so it does not resurrect. The edit is not destroyed, though: it lives in its register, and restoring the task brings it back. That is asserted, not claimed.

## The relay knows nothing

```
client → { have: clientVV, ops: [what the relay is thought to lack] }
client ← { have: relayVV,  ops: [what the client lacks] }
```

The relay stores operations keyed by `(replica, seq)` and lists back the ones a caller lacks. It never inspects an operation, never merges, never resolves a conflict, and has no idea what a task is. Two consequences:

- **It cannot corrupt the data.** All resolution happens on devices, from the same operations, by the same rules. A buggy relay can lose, delay or duplicate; duplication and reordering are already handled, and loss is repaired by the next sync.
- **It is replaceable.** Anything that stores and lists opaque blobs can carry this protocol — S3, a shared folder, a USB stick.

One round trip. The client remembers the relay's version from last time so it can decide what to upload without asking. A stale cache costs bandwidth and nothing else, because operations are idempotent.

## Measured

Node 22, single core.

| | |
|---|---|
| Operations per user action | 2 to create a task, 1 per typed character |
| Wire size | 157 bytes per operation |
| **One keystroke on a 3,002-operation log** | **uploads 1 operation, 152 bytes** |
| A settled cluster syncing again | 0 operations, 0 bytes |
| Replay 3,003 operations from storage | 60 ms |
| On disk (SQLite, with indexes) | 394 bytes per operation |

Typing cost as a note grows, which is where the RGA's linear scan shows up:

| note length | cost per typed character |
|---|---|
| 1,000 chars | 0.037 ms |
| 5,000 chars | 0.084 ms |
| 20,000 chars | 0.184 ms |

Linear, as the implementation implies, and imperceptible at the sizes a notes app sees. It would not survive a novel; see the limitations.

## Tests

30 tests. The important ones are not the unit tests.

**The proof** (`tests/convergence.test.ts`) — fork state across devices, cut the network, make conflicting edits on each side, reconnect, assert byte-identical state *and* assert what survived:

- concurrent edits to different fields of one task — all survive
- concurrent edits to the same field — both kept, same winner shown everywhere
- resolving a conflict collapses it on every device
- concurrent edits to different parts of one note — both land where they were typed
- three replicas typing at the same position — no interleaving, identical order everywhere
- concurrent delete and insert in the same region
- concurrent delete and edit — deletes, without destroying the edit
- restore beats the deletes it has observed
- three-way partition where two devices meet first
- syncing again changes nothing and transfers nothing
- a device offline across 200 remote edits and 50 local ones

**The randomised proof** (`tests/fuzz.test.ts`) — 530 seeded schedules across 2, 3 and 5 replicas, with random edits, random partitions and random sync order. Every run asserts identical snapshots, identical version vectors, and nothing left buffered. A separate 150 delete-free schedules assert the stronger property: every character every replica saw survives the merge in the same relative order, so "converged" cannot be satisfied by throwing edits away.

Each run is seeded, so a failure prints a seed that replays the exact schedule.

**Delivery and durability** (`tests/protocol.test.ts`) — reverse and shuffled delivery, triple duplication, truncated streams, version vectors refusing to advance over a gap, incremental transfer size, offline behaviour, backoff, SQLite restart mid-conflict, and replay from a scrambled log.

### Three bugs these tests caught

Worth naming, because the point of the exercise is understanding rather than a green checkmark.

1. **Every operation in a batch got sequence number 1.** `createTask` minted all its ids before appending any, and sequence numbers come from the log's version vector, which only advances on append. The operations silently overwrote each other in storage. The very first convergence test caught it — which is the argument for writing that test before the app.
2. **Conflict sets serialised in arrival order.** Two devices that learned the same competing values in different orders produced different JSON for the same state. Not a real divergence, but it fails a byte-identical comparison, and worse, a false divergence hides real ones in the diff. Fixed by sorting the set.
3. **A fuzz assertion that was wrong, not the code.** The property "every character a replica saw survives the merge" is false when another replica deletes concurrently — the character is *supposed* to vanish. The fix was to split the claim: convergence always, no-lost-insertions only for delete-free schedules. Weakening an assertion to make it pass is usually a smell; here the original was simply not a true statement about the system.

## Running it

```
npm install
npm test                 # everything
npm run demo             # printed walkthrough of an offline merge
npm run relay            # standalone relay on :8787, SQLite-backed with --db
npm run app              # UI + relay on :5173
```

Then open `http://127.0.0.1:5173/?device=a` and `?device=b` in two tabs. They are independent replicas with separate logs and can only learn about each other through the relay. Toggle one to **Offline**, edit the same task and the same note in both, then reconnect and watch them merge.

The right-hand column is the point of the interface: version vector, operations held, operations waiting on causality, operations not yet uploaded. In most apps that would be debug output; here it is the product, because the only way to believe a sync story is to watch the state that drives it.

## Layout

```
src/core/
  clock.ts       Lamport clocks, version vectors, the total order
  ops.ts         operation vocabulary and causal dependencies
  register.ts    multi-value register — the "no LWW loss" claim
  rga.ts         sequence CRDT for note text
  workspace.ts   materialised state: add-wins sets over registers and text
  oplog.ts       version vector, causal buffering, deduplication
  replica.ts     one device: local commands that emit operations
src/sync/
  protocol.ts    relay store, transports, one-round-trip sync, backoff
  server.ts      HTTP relay, SQLite-backed
src/storage/     SQLite and in-memory backends
ui/              browser app; storage.ts also holds the Tauri adapter
src-tauri/       desktop shell: SQLite commands over Tauri's invoke
tests/           convergence, fuzz, protocol, and the demo
```

## Limitations

Stated rather than hidden.

- **The Tauri shell is not compiled in this repository's CI.** The Rust source and configuration are complete and the shell is thin — four commands that store and return opaque JSON — but Tauri 1.6's dependency tree now requires Rust 1.85+, and the toolchain available here is 1.75. On a current toolchain, `cargo tauri dev` is the entry point. The browser build is fully runnable and exercises identical CRDT code; only the storage adapter differs.
- **Tombstones are never collected.** A deleted character stays addressable forever, because a concurrent insert may still name it as an origin. Memory grows with total characters ever typed. Safe compaction needs causal stability — proof that every replica has seen the deletion — which needs either a coordinator or a bounded set of known devices. Neither is in scope here, and pretending otherwise would be the dishonest version of this bullet.
- **RGA insertion is a linear scan.** Fine to 20,000 characters (0.18 ms per keystroke), wrong for a novel. The fix is a balanced index over the element list, which changes no semantics.
- **One operation per character.** Runs of consecutive characters could be encoded as a single operation and split only when something is inserted into the middle, which is what mature implementations do. It would cut the log size of typed prose by roughly an order of magnitude.
- **No encryption.** The relay sees plaintext operations. Since it never needs to understand them, encrypting payloads with a key the relay does not hold is a natural fit and is the first thing I would add for real use.
- **No authentication or multi-user access control.** One workspace, shared by whoever can reach the relay.
- **The whole log is loaded at startup.** Replay is 60 ms for 3,000 operations and linear from there. A periodic state snapshot plus the operations after it is the standard remedy.
- **No undo.** The log makes it straightforwardly possible — an undo is an inverse operation, not a rewind — but it is not implemented.

## What I would build next, in order

1. **Run-length text operations.** The largest single win, and it changes no semantics.
2. **Snapshots**, so startup does not scale with history.
3. **End-to-end encryption**, which the relay's ignorance already makes easy.
4. **Peer-to-peer sync over the same protocol.** Nothing in it assumes a star topology; the relay is just a peer that never generates operations.
