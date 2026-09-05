/**
 * A per-field multi-value register.
 *
 * This is the answer to "no last-write-wins data loss", and it is worth being
 * precise about what that phrase can and cannot mean.
 *
 * Three different things get called LWW, and they lose different amounts:
 *
 *   1. **Whole-record LWW.** The whole task row is replaced by whichever write
 *      has the later timestamp. Editing the title on a laptop while ticking
 *      the checkbox on a phone loses one of them entirely. This is the common
 *      case and it is pure data loss — nothing was in conflict.
 *
 *   2. **Per-field LWW.** Each field resolves independently, so the example
 *      above keeps both. Only genuinely concurrent writes *to the same field*
 *      can lose, which is far rarer.
 *
 *   3. **Multi-value register**, which is this. Same-field concurrent writes
 *      are kept as a set. A deterministic winner is chosen for display so
 *      every replica shows the same thing without coordinating, and the losing
 *      values remain queryable so the interface can offer a choice instead of
 *      silently discarding a person's typing.
 *
 * The third is what makes the claim honest. Convergence never actually
 * requires keeping the losers — picking a deterministic winner converges fine.
 * Keeping them is a product decision about not throwing away work, and it
 * costs one array per contested field until someone resolves it.
 *
 * Collapse is automatic: any write that observed the conflicting values
 * supersedes all of them, so resolving is an ordinary edit, not a special API.
 */

import { compareIds, formatId, OpId } from "./clock.js";
import { FieldValue } from "./ops.js";

export interface RegisterEntry {
  id: OpId;
  value: FieldValue;
}

export class MvRegister {
  /** Live values, keyed by the id of the write that produced them. */
  private entries = new Map<string, RegisterEntry>();

  /**
   * Apply a write that observed the values in `prev`.
   *
   * Removing `prev` first is what collapses a resolved conflict: a write made
   * while looking at two competing values names both, so both disappear and
   * only the new value remains.
   */
  write(id: OpId, value: FieldValue, prev: string[]): void {
    for (const key of prev) this.entries.delete(key);
    this.entries.set(formatId(id), { id, value });
  }

  /** True once any write has landed. */
  get exists(): boolean {
    return this.entries.size > 0;
  }

  /**
   * The value every replica agrees to display.
   *
   * Highest Lamport timestamp, replica id breaking ties. Deterministic and
   * computable offline, which is the only thing convergence requires of it.
   */
  get value(): FieldValue {
    let best: RegisterEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!best || compareIds(entry.id, best.id) > 0) best = entry;
    }
    return best ? best.value : null;
  }

  get winner(): RegisterEntry | undefined {
    let best: RegisterEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!best || compareIds(entry.id, best.id) > 0) best = entry;
    }
    return best;
  }

  /** True when concurrent writes to this field are still unresolved. */
  get contested(): boolean {
    return this.entries.size > 1;
  }

  /** Every live value, newest first. Length > 1 means an unresolved conflict. */
  all(): RegisterEntry[] {
    return [...this.entries.values()].sort((a, b) => compareIds(b.id, a.id));
  }

  /** Values that lost to the winner but were not overwritten by it. */
  shadowed(): RegisterEntry[] {
    return this.all().slice(1);
  }

  /**
   * Ids a resolving write must name in order to collapse the conflict.
   *
   * Sorted, because this set is exposed in the snapshot and two replicas that
   * learned the same values in different orders must still serialise
   * identically. A set that compares unequal only because of insertion order
   * is a false divergence, and worse, it hides real ones in the diff.
   */
  observedIds(): string[] {
    return [...this.entries.keys()].sort();
  }
}
