/**
 * Identity, causality and ordering primitives.
 *
 * Two different clocks live here and they do different jobs. Conflating them
 * is the most common way to get a CRDT subtly wrong, so they are separate
 * types on purpose.
 *
 *   Lamport clock  — a single scalar per replica, advanced past every
 *                    timestamp it observes. Gives a *total* order over all
 *                    operations that is consistent with causality: if A
 *                    happened-before B then lamport(A) < lamport(B). Used for
 *                    tie-breaking, for LWW registers, and for RGA ordering.
 *
 *   Version vector — one counter per replica. Answers "which operations do I
 *                    already have?", which is what the sync protocol needs and
 *                    what a Lamport clock cannot tell you: a scalar cannot
 *                    distinguish "I have 40 ops" from "I have ops 1-20 from A
 *                    and 1-20 from B".
 *
 * The converse also matters: a version vector cannot break ties, because two
 * concurrent operations are by definition unordered by it. Hence both.
 */

/** Stable per-device identifier. Generated once and persisted. */
export type ReplicaId = string;

/**
 * Globally unique operation identifier.
 *
 * `seq` is a per-replica counter with no gaps, which is what makes version
 * vectors work — "I have seq 7 from replica A" implies I have 1 through 7.
 * `lamport` is the causal clock used for ordering.
 */
export interface OpId {
  replica: ReplicaId;
  seq: number;
  lamport: number;
}

export function formatId(id: OpId): string {
  return `${id.replica}:${id.seq}`;
}

export function parseId(s: string): { replica: ReplicaId; seq: number } {
  const at = s.lastIndexOf(":");
  return { replica: s.slice(0, at), seq: Number(s.slice(at + 1)) };
}

/**
 * Total order over operation ids: Lamport first, replica id as the tiebreak.
 *
 * The replica-id tiebreak is what makes the order *deterministic across
 * devices* when two operations are concurrent. Every replica computes the same
 * answer without talking to anyone, which is the whole trick behind
 * convergence. Any consistent rule works; the only requirement is that it is
 * antisymmetric and identical everywhere.
 */
export function compareIds(a: OpId, b: OpId): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.seq - b.seq;
}

export function idsEqual(a: OpId, b: OpId): boolean {
  return a.replica === b.replica && a.seq === b.seq;
}

/** A Lamport clock. */
export class Lamport {
  constructor(private value = 0) {}

  /** Advance for a locally generated event. */
  tick(): number {
    return ++this.value;
  }

  /** Absorb an observed timestamp, preserving the happened-before property. */
  observe(seen: number): void {
    if (seen > this.value) this.value = seen;
  }

  get current(): number {
    return this.value;
  }
}

/**
 * A version vector: replica -> highest sequence number held.
 *
 * Because `seq` has no gaps this is a complete description of a replica's
 * knowledge in O(replicas) space rather than O(operations). That is the
 * property the sync protocol is built on.
 */
export type VersionVector = Record<ReplicaId, number>;

export function vvGet(vv: VersionVector, replica: ReplicaId): number {
  return vv[replica] ?? 0;
}

/** Record that `seq` from `replica` is held. */
export function vvSet(vv: VersionVector, replica: ReplicaId, seq: number): void {
  if (seq > vvGet(vv, replica)) vv[replica] = seq;
}

export function vvClone(vv: VersionVector): VersionVector {
  return { ...vv };
}

/** Does `vv` already contain this operation? */
export function vvHas(vv: VersionVector, id: OpId): boolean {
  return vvGet(vv, id.replica) >= id.seq;
}

/** Pointwise maximum — the knowledge of a replica that has seen both. */
export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out = vvClone(a);
  for (const replica of Object.keys(b)) vvSet(out, replica, b[replica]);
  return out;
}

/** True when `a` holds everything `b` holds. */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  for (const replica of Object.keys(b)) {
    if (vvGet(a, replica) < b[replica]) return false;
  }
  return true;
}

export function vvEqual(a: VersionVector, b: VersionVector): boolean {
  return vvDominates(a, b) && vvDominates(b, a);
}

/**
 * Neither dominates the other: the two replicas have diverged and each holds
 * operations the other has not seen. Not an error — this is the normal state
 * of an offline-first system, and the thing the merge has to handle.
 */
export function vvConcurrent(a: VersionVector, b: VersionVector): boolean {
  return !vvDominates(a, b) && !vvDominates(b, a);
}

/** Total operation count described by a vector, for diagnostics. */
export function vvSize(vv: VersionVector): number {
  return Object.values(vv).reduce((n, x) => n + x, 0);
}

/** Random replica id. Collision risk is negligible and it needs no registry. */
export function newReplicaId(): ReplicaId {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
