/**
 * RGA — Replicated Growable Array. The sequence CRDT behind note bodies.
 *
 * # The problem it solves
 *
 * Text cannot use a register. If two people edit different paragraphs of the
 * same note offline, a register keeps one paragraph and destroys the other,
 * and no amount of per-field granularity helps because the whole body is one
 * field. A sequence CRDT merges at the character level, so both edits survive
 * and land in the right places.
 *
 * # The model
 *
 * Every character is an immutable element with a unique id, inserted *to the
 * right of* an existing element (its origin). Deletion is a tombstone, never a
 * splice — an element must stay addressable because a concurrent insert may
 * name it as an origin. That is the cost of the design: memory grows with
 * total characters ever typed, not current length, and compaction needs
 * causal stability (see README).
 *
 * # The ordering rule
 *
 * Insert after the origin, then skip right over every element whose id is
 * greater than the new one:
 *
 * ```
 *   i = index(origin) + 1
 *   while (i < len && compareIds(elements[i].id, newId) > 0) i++
 * ```
 *
 * This is the whole algorithm, and it is correct only because element ids are
 * **Lamport** timestamps rather than bare per-replica counters. A character
 * typed after seeing another always carries a strictly greater Lamport value,
 * so a subtree of later insertions is contiguous and entirely greater than its
 * origin. Skipping while greater therefore steps over whole subtrees of
 * concurrent insertions rather than landing in the middle of one. Swap Lamport
 * for a raw counter and this breaks under exactly the conditions that are
 * hardest to reproduce by hand — which is what the fuzz test is for.
 *
 * Concurrent insertions at the same position end up ordered by descending id.
 * Both survive; neither interleaves into the other; every replica computes the
 * same arrangement without communicating.
 */

import { compareIds, formatId, OpId } from "./clock.js";

interface Element {
  id: OpId;
  key: string;
  ch: string;
  deleted: boolean;
}

export class Rga {
  /** Document order, tombstones included. */
  private elements: Element[] = [];
  private byKey = new Map<string, Element>();

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Insert `ch` immediately right of element `after` (null = document start). */
  insert(id: OpId, after: string | null, ch: string): void {
    const key = formatId(id);
    if (this.byKey.has(key)) return; // idempotent

    let i = 0;
    if (after !== null) {
      const originIndex = this.indexOfKey(after);
      if (originIndex < 0) {
        throw new Error(`RGA insert names a missing origin ${after}; the log should have buffered this`);
      }
      i = originIndex + 1;
    }

    while (i < this.elements.length && compareIds(this.elements[i].id, id) > 0) i++;

    const element: Element = { id, key, ch, deleted: false };
    this.elements.splice(i, 0, element);
    this.byKey.set(key, element);
  }

  /** Tombstone an element. Applying twice is a no-op, which keeps it idempotent. */
  delete(target: string): void {
    const element = this.byKey.get(target);
    if (element) element.deleted = true;
  }

  private indexOfKey(key: string): number {
    // Linear scan. A production implementation keeps a balanced index here;
    // see the complexity note in the README before pasting a novel into it.
    for (let i = 0; i < this.elements.length; i++) {
      if (this.elements[i].key === key) return i;
    }
    return -1;
  }

  /** The visible text. */
  toString(): string {
    let out = "";
    for (const e of this.elements) if (!e.deleted) out += e.ch;
    return out;
  }

  get length(): number {
    let n = 0;
    for (const e of this.elements) if (!e.deleted) n++;
    return n;
  }

  /**
   * Element id at visible offset `index`, or null for offset 0.
   *
   * Editors speak in offsets and RGA speaks in identities; this is the
   * translation, and it is where an off-by-one becomes a character inserted
   * into the wrong word on someone else's device.
   */
  keyAtVisibleIndex(index: number): string | null {
    if (index <= 0) return null;
    let seen = 0;
    for (const e of this.elements) {
      if (e.deleted) continue;
      seen++;
      if (seen === index) return e.key;
    }
    return this.elements.length ? this.elements[this.elements.length - 1].key : null;
  }

  /** Keys of the visible characters in `[start, end)`, for deletion. */
  keysInVisibleRange(start: number, end: number): string[] {
    const keys: string[] = [];
    let seen = 0;
    for (const e of this.elements) {
      if (e.deleted) continue;
      if (seen >= start && seen < end) keys.push(e.key);
      seen++;
      if (seen >= end) break;
    }
    return keys;
  }

  /** Total elements including tombstones — the memory the design costs. */
  get physicalLength(): number {
    return this.elements.length;
  }
}
