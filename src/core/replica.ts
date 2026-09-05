/**
 * A replica — one device's copy of the workspace.
 *
 * Every mutation is local and synchronous. Nothing in this file knows whether
 * a network exists, which is the actual meaning of "offline-first": the online
 * path is the offline path plus a background exchange of operations, not a
 * separate mode with separate code.
 *
 * Each command mints operations, appends them to the log, and persists them.
 * The state update happens through the same `apply` path a remote operation
 * takes, so there is no local-only shortcut that could behave differently from
 * the merged result.
 */

import { Lamport, OpId, ReplicaId, VersionVector, formatId, newReplicaId } from "./clock.js";
import { OpLog, ReceiveReport } from "./oplog.js";
import { FieldValue, Op } from "./ops.js";
import { Snapshot, Workspace } from "./workspace.js";

/** Persistence contract. Implemented over SQLite and over memory. */
export interface Storage {
  readReplicaId(): ReplicaId | null;
  writeReplicaId(id: ReplicaId): void;
  readOps(): Op[];
  appendOps(ops: Op[]): void;
  /** Last known version of the relay, so a sync sends only what it lacks. */
  readPeerVersion(peer: string): VersionVector;
  writePeerVersion(peer: string, vv: VersionVector): void;
  close(): void;
}

export class Replica {
  readonly id: ReplicaId;
  readonly workspace = new Workspace();
  readonly log: OpLog;
  private readonly lamport = new Lamport();

  private constructor(private readonly storage: Storage, id: ReplicaId) {
    this.id = id;
    this.log = new OpLog(this.lamport, (op) => this.workspace.apply(op));
  }

  /**
   * Open a replica, replaying its stored log.
   *
   * Replay goes through `receive` rather than a trusted fast path so that a
   * log persisted in an odd order — or one containing operations that were
   * still buffered when the process died — heals on startup instead of
   * throwing.
   */
  static open(storage: Storage): Replica {
    let id = storage.readReplicaId();
    if (!id) {
      id = newReplicaId();
      storage.writeReplicaId(id);
    }
    const replica = new Replica(storage, id);
    const stored = storage.readOps();
    if (stored.length) replica.log.receive(stored);
    return replica;
  }

  get version(): VersionVector {
    return this.log.version;
  }

  snapshot(): Snapshot {
    return this.workspace.snapshot();
  }

  // -- operation emission --------------------------------------------------

  /**
   * Mint an id, build the operation, and apply it — in that order, one
   * operation at a time.
   *
   * The order is not incidental. Sequence numbers come from the log's version
   * vector, so an operation only reserves its number by being appended. An
   * earlier version of this file minted every id for a batch up front and then
   * appended them together; every operation in the batch received sequence 1
   * and silently overwrote its siblings in storage. The first convergence test
   * caught it, which is the argument for writing that test before the app.
   */
  private issue(make: (id: OpId) => Op): Op {
    const op = make(this.log.mint(this.id));
    this.log.append(op);
    if (this.batchBuffer) this.batchBuffer.push(op);
    else this.storage.appendOps([op]);
    return op;
  }

  private batchBuffer: Op[] | null = null;

  /**
   * Group the operations of one user action into a single storage write.
   *
   * Typing a word is one action and should be one transaction, not one per
   * character. The log is updated per operation regardless — only the disk
   * write is batched — so an interrupted batch loses the tail of a keystroke
   * run and nothing else.
   */
  private batch<T>(fn: () => T): T {
    if (this.batchBuffer) return fn();
    this.batchBuffer = [];
    try {
      const result = fn();
      this.storage.appendOps(this.batchBuffer);
      return result;
    } finally {
      this.batchBuffer = null;
    }
  }

  // -- tasks ---------------------------------------------------------------

  createTask(title: string, fields: Record<string, FieldValue> = {}): string {
    const task = crypto.randomUUID();
    this.batch(() => {
      this.issue((id) => ({ kind: "task.create", id, task }));
      this.issue((id) => ({ kind: "task.set", id, task, field: "title", value: title, prev: [] }));
      for (const [field, value] of Object.entries(fields)) {
        this.issue((id) => ({ kind: "task.set", id, task, field, value, prev: [] }));
      }
    });
    return task;
  }

  /**
   * Write a field.
   *
   * `prev` is filled from what this replica can currently see. That is the
   * entire conflict-detection mechanism: a device that could see the value it
   * is replacing supersedes it, and a device that could not is concurrent with
   * it. No timestamps are consulted and no clocks need to agree.
   */
  setTask(task: string, field: string, value: FieldValue): void {
    const prev = this.workspace.observedFor(task, field, "task");
    this.issue((id) => ({ kind: "task.set", id, task, field, value, prev }));
  }

  toggleTask(task: string): void {
    const current = this.snapshot().tasks.find((t) => t.id === task);
    this.setTask(task, "done", !(current?.done ?? false));
  }

  /** Observed-remove: names the add-tags this device can see, and no others. */
  removeTask(task: string): void {
    const observed = this.workspace.taskTags(task);
    if (!observed.length) return;
    this.issue((id) => ({ kind: "task.remove", id, task, observed }));
  }

  /** Re-add with a fresh tag. Field values were never deleted, so they return. */
  restoreTask(task: string): void {
    this.issue((id) => ({ kind: "task.create", id, task }));
  }

  // -- notes ---------------------------------------------------------------

  createNote(title: string, body = ""): string {
    const note = crypto.randomUUID();
    this.batch(() => {
      this.issue((id) => ({ kind: "note.create", id, note }));
      this.issue((id) => ({ kind: "note.set", id, note, field: "title", value: title, prev: [] }));
      if (body) this.insertText(note, 0, body);
    });
    return note;
  }

  setNote(note: string, field: string, value: FieldValue): void {
    const prev = this.workspace.observedFor(note, field, "note");
    this.issue((id) => ({ kind: "note.set", id, note, field, value, prev }));
  }

  removeNote(note: string): void {
    const observed = this.workspace.noteTags(note);
    if (!observed.length) return;
    this.issue((id) => ({ kind: "note.remove", id, note, observed }));
  }

  /**
   * Insert text at a visible offset.
   *
   * One operation per character, each anchored to the character before it.
   * Anchoring to identities rather than offsets is the point: a concurrent
   * edit earlier in the note shifts every offset but changes no identity, so
   * this text still lands exactly where it was typed.
   */
  insertText(note: string, index: number, text: string): void {
    if (!text) return;
    const body = this.workspace.noteBody(note);
    let after = body ? body.keyAtVisibleIndex(index) : null;
    this.batch(() => {
      for (const ch of text) {
        const op = this.issue((id) => ({ kind: "text.insert", id, note, after, ch }));
        after = formatId(op.id);
      }
    });
  }

  /** Delete the visible range `[start, end)`. */
  deleteText(note: string, start: number, end: number): void {
    const body = this.workspace.noteBody(note);
    if (!body) return;
    const targets = body.keysInVisibleRange(start, end);
    if (!targets.length) return;
    this.batch(() => {
      for (const target of targets) {
        this.issue((id) => ({ kind: "text.delete", id, note, target }));
      }
    });
  }

  /** Replace the whole body, expressed as a delete plus an insert. */
  replaceText(note: string, text: string): void {
    const body = this.workspace.noteBody(note);
    if (body && body.length) this.deleteText(note, 0, body.length);
    this.insertText(note, 0, text);
  }

  // -- sync surface --------------------------------------------------------

  since(theirs: VersionVector): Op[] {
    return this.log.since(theirs);
  }

  receive(ops: Op[]): ReceiveReport {
    const report = this.log.receive(ops);
    if (report.applied > 0 || report.pending > 0) {
      this.storage.appendOps(ops);
    }
    return report;
  }

  peerVersion(peer: string): VersionVector {
    return this.storage.readPeerVersion(peer);
  }

  rememberPeerVersion(peer: string, vv: VersionVector): void {
    this.storage.writePeerVersion(peer, vv);
  }

  close(): void {
    this.storage.close();
  }
}
