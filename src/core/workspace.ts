/**
 * The materialised state — what the interface reads.
 *
 * Nothing here decides anything. Every conflict is settled by the CRDT types
 * in `register.ts` and `rga.ts`; this file only routes operations to them and
 * shapes the result for display. Keeping resolution out of the view layer is
 * what makes the convergence tests meaningful: they compare `snapshot()`
 * across replicas, and there is nowhere else for a divergent decision to hide.
 *
 * # Presence, and why deletion is an observed-remove
 *
 * A task exists if it holds at least one un-removed *add tag*. Creating adds a
 * tag; deleting removes only the tags the deleting device could see.
 *
 * The alternative — a boolean `deleted` register — behaves badly in exactly
 * the case offline sync makes common. Two devices delete the same task while
 * partitioned, then one restores it; with a boolean the restore races the
 * second delete and the outcome depends on timestamps nobody controls. With
 * observed-remove, a restore issues a *new* tag that no existing delete has
 * observed, so restoring always wins over deletes that happened before it, and
 * never over deletes that happened after.
 *
 * Concurrent delete-and-edit resolves as delete: an edit is not an add, so it
 * does not resurrect. The edit is not destroyed though — it lives in the
 * register, so restoring the task brings it back. That behaviour is asserted
 * in `tests/convergence.test.ts` rather than left as a claim.
 */

import { Op } from "./ops.js";
import { MvRegister, RegisterEntry } from "./register.js";
import { Rga } from "./rga.js";

class Entity {
  /** Add-tags: op ids of the creations that have not been observed-removed. */
  tags = new Set<string>();
  fields = new Map<string, MvRegister>();

  get exists(): boolean {
    return this.tags.size > 0;
  }

  register(field: string): MvRegister {
    let reg = this.fields.get(field);
    if (!reg) {
      reg = new MvRegister();
      this.fields.set(field, reg);
    }
    return reg;
  }
}

class NoteEntity extends Entity {
  body = new Rga();
}

export interface Conflict {
  field: string;
  chosen: unknown;
  alternatives: unknown[];
  /** Ids a resolving write must observe to collapse this. */
  observed: string[];
}

export interface TaskView {
  id: string;
  title: string;
  done: boolean;
  priority: string;
  conflicts: Conflict[];
}

export interface NoteView {
  id: string;
  title: string;
  body: string;
  conflicts: Conflict[];
}

export interface Snapshot {
  tasks: TaskView[];
  notes: NoteView[];
}

export class Workspace {
  private tasks = new Map<string, Entity>();
  private notes = new Map<string, NoteEntity>();

  /**
   * Route one operation into the right CRDT.
   *
   * Entities are created on demand rather than requiring their `create` to
   * arrive first. A field write that overtakes its creation leaves a task with
   * values and no presence — invisible, but not lost, and it appears intact
   * the moment the creation lands. Demanding strict ordering here would mean
   * more buffering for no gain in correctness.
   */
  apply(op: Op): void {
    switch (op.kind) {
      case "task.create":
        this.task(op.task).tags.add(keyOf(op));
        break;
      case "task.remove":
        for (const tag of op.observed) this.task(op.task).tags.delete(tag);
        break;
      case "task.set":
        this.task(op.task).register(op.field).write(op.id, op.value, op.prev);
        break;
      case "note.create":
        this.note(op.note).tags.add(keyOf(op));
        break;
      case "note.remove":
        for (const tag of op.observed) this.note(op.note).tags.delete(tag);
        break;
      case "note.set":
        this.note(op.note).register(op.field).write(op.id, op.value, op.prev);
        break;
      case "text.insert":
        this.note(op.note).body.insert(op.id, op.after, op.ch);
        break;
      case "text.delete":
        this.note(op.note).body.delete(op.target);
        break;
    }
  }

  private task(id: string): Entity {
    let entity = this.tasks.get(id);
    if (!entity) {
      entity = new Entity();
      this.tasks.set(id, entity);
    }
    return entity;
  }

  private note(id: string): NoteEntity {
    let entity = this.notes.get(id);
    if (!entity) {
      entity = new NoteEntity();
      this.notes.set(id, entity);
    }
    return entity;
  }

  // -- reads ---------------------------------------------------------------

  taskExists(id: string): boolean {
    return this.tasks.get(id)?.exists ?? false;
  }

  noteExists(id: string): boolean {
    return this.notes.get(id)?.exists ?? false;
  }

  /** Add-tags currently held, which an observed-remove must name. */
  taskTags(id: string): string[] {
    return [...(this.tasks.get(id)?.tags ?? [])];
  }

  noteTags(id: string): string[] {
    return [...(this.notes.get(id)?.tags ?? [])];
  }

  /** Value ids a write to this field must supersede. */
  observedFor(entityId: string, field: string, kind: "task" | "note"): string[] {
    const entity = kind === "task" ? this.tasks.get(entityId) : this.notes.get(entityId);
    return entity?.fields.get(field)?.observedIds() ?? [];
  }

  noteBody(id: string): Rga | undefined {
    return this.notes.get(id)?.body;
  }

  /**
   * Deterministic snapshot of everything visible.
   *
   * Sorted by id so two replicas that agree produce byte-identical JSON. The
   * convergence tests compare exactly this, which means any divergence
   * anywhere — ordering, conflict sets, tombstones — fails them.
   */
  snapshot(): Snapshot {
    const tasks: TaskView[] = [];
    for (const [id, entity] of [...this.tasks].sort(byKey)) {
      if (!entity.exists) continue;
      tasks.push({
        id,
        title: String(entity.register("title").value ?? ""),
        done: Boolean(entity.register("done").value ?? false),
        priority: String(entity.register("priority").value ?? "normal"),
        conflicts: conflictsOf(entity),
      });
    }

    const notes: NoteView[] = [];
    for (const [id, entity] of [...this.notes].sort(byKey)) {
      if (!entity.exists) continue;
      notes.push({
        id,
        title: String(entity.register("title").value ?? ""),
        body: entity.body.toString(),
        conflicts: conflictsOf(entity),
      });
    }
    return { tasks, notes };
  }

  /** Field values that exist but belong to a deleted entity, for restore. */
  shadowOfDeleted(id: string, kind: "task" | "note"): Record<string, unknown> {
    const entity = kind === "task" ? this.tasks.get(id) : this.notes.get(id);
    if (!entity) return {};
    const out: Record<string, unknown> = {};
    for (const [field, reg] of entity.fields) out[field] = reg.value;
    return out;
  }

  get taskCount(): number {
    return [...this.tasks.values()].filter((t) => t.exists).length;
  }

  get noteCount(): number {
    return [...this.notes.values()].filter((n) => n.exists).length;
  }

  /** Tombstoned elements across all notes — the cost of the sequence CRDT. */
  get tombstoneCount(): number {
    let n = 0;
    for (const note of this.notes.values()) n += note.body.physicalLength - note.body.length;
    return n;
  }
}

function conflictsOf(entity: Entity): Conflict[] {
  const out: Conflict[] = [];
  for (const [field, reg] of [...entity.fields].sort(byKey)) {
    if (!reg.contested) continue;
    out.push({
      field,
      chosen: reg.value,
      alternatives: reg.shadowed().map((e: RegisterEntry) => e.value),
      observed: reg.observedIds(),
    });
  }
  return out;
}

function byKey(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function keyOf(op: Op): string {
  return `${op.id.replica}:${op.id.seq}`;
}
