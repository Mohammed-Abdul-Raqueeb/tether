/**
 * The operation vocabulary.
 *
 * This is an *operation-based* CRDT. Replicas exchange the operations
 * themselves rather than merged state, which is what lets a sync transfer be
 * proportional to what changed rather than to the size of the database.
 *
 * Op-based CRDTs come with an obligation in exchange: each operation must be
 * applied **exactly once** and **after its causal dependencies**. Neither is
 * free, so both are made explicit here — `dependencies()` below states what
 * each operation needs, and the log enforces at-most-once delivery through the
 * version vector. Getting either wrong produces bugs that only appear under
 * unlucky network ordering, which is why `tests/oplog.test.ts` delivers every
 * operation reversed, shuffled and duplicated.
 */

import { formatId, OpId } from "./clock.js";

export type FieldValue = string | number | boolean | null;

/**
 * `prev` is the set of value-ids this write observed for the field it targets.
 *
 * This is the mechanism that distinguishes "overwrite" from "conflict" without
 * a central clock. If a write observed the value it is replacing, it causally
 * follows it and simply wins. If it did not, the two writes were made
 * concurrently, and the register keeps both. See `register.ts`.
 */
export type Op =
  | { kind: "task.create"; id: OpId; task: string }
  /** Observed-remove: carries the add-tags it saw, and removes only those. */
  | { kind: "task.remove"; id: OpId; task: string; observed: string[] }
  | { kind: "task.set"; id: OpId; task: string; field: string; value: FieldValue; prev: string[] }
  | { kind: "note.create"; id: OpId; note: string }
  | { kind: "note.remove"; id: OpId; note: string; observed: string[] }
  | { kind: "note.set"; id: OpId; note: string; field: string; value: FieldValue; prev: string[] }
  /** RGA insert: `after` is the element this character was typed to the right of. */
  | { kind: "text.insert"; id: OpId; note: string; after: string | null; ch: string }
  | { kind: "text.delete"; id: OpId; note: string; target: string };

export type OpKind = Op["kind"];

/**
 * Operation ids that must already be applied before this one can be.
 *
 * Returning an accurate list matters more than it looks. An RGA insert whose
 * `after` element is missing has nowhere to go; a `set` whose `prev` values are
 * missing would resurrect a value that was already superseded, turning a
 * resolved field back into a conflict. Both are silent corruptions rather than
 * crashes, so the log buffers instead of guessing.
 */
export function dependencies(op: Op): string[] {
  switch (op.kind) {
    case "task.create":
    case "note.create":
      return [];
    case "task.remove":
    case "note.remove":
      return op.observed;
    case "task.set":
    case "note.set":
      return op.prev;
    case "text.insert":
      return op.after === null ? [] : [op.after];
    case "text.delete":
      return [op.target];
  }
}

/** The entity an operation touches, used for indexing and for the UI. */
export function subject(op: Op): string {
  switch (op.kind) {
    case "task.create":
    case "task.remove":
    case "task.set":
      return op.task;
    default:
      return op.note;
  }
}

export function opKey(op: Op): string {
  return formatId(op.id);
}

/**
 * Approximate wire size of an operation, used by the sync tests to assert that
 * an incremental sync stays incremental.
 */
export function wireSize(op: Op): number {
  return JSON.stringify(op).length;
}
