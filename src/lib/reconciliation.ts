/**
 * Reconciliation engine (PayFac settlement) — pure, centime-exact matching.
 *
 * Reconciliation is the three-way match that makes the settlement ledger safe to
 * close: a provider **report** (the external statement of what actually moved at
 * the PSP) is compared against the tenant's internal **ledger** (the double-entry
 * record of what we believe moved) and, transitively, the **payouts** those
 * ledger entries settled.
 *
 * The pure core is `reconcile(external, internal)`: it matches the two lists by a
 * shared `reference`, classifies each matched reference as `EXACT` or
 * `AMOUNT_DIFF` (centime-exact), and surfaces the two kinds of break —
 * `missingInternal` (the provider reported a movement we never recorded) and
 * `missingExternal` (we recorded a movement the provider never reported).
 *
 * Everything here is pure and side-effect-free — that is what makes it
 * property-testable. Persistence lives in `reconciliation-db.ts` and wraps these
 * helpers. Amounts cross the boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { ReconciliationStatus } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export const RECONCILIATION_STATUSES = ["PENDING", "MATCHED", "UNMATCHED", "RESOLVED"] as const;

export const RECONCILIATION_MATCH_STATUSES = ["UNMATCHED", "EXACT", "AMOUNT_DIFF"] as const;

/** A line on the external (provider) side of the match. */
export interface ExternalLine {
  reference: string;
  amountCents: Centimes;
}

/** A line on the internal (ledger) side of the match. */
export interface InternalLine {
  reference: string;
  amountCents: Centimes;
}

/** A reference present on both sides, with its centime-exact comparison. */
interface LineMatch {
  reference: string;
  status: "EXACT" | "AMOUNT_DIFF";
  externalCents: Centimes;
  internalCents: Centimes;
  /** external − internal (signed). */
  differenceCents: Centimes;
}

/** The full outcome of a reconciliation. */
export interface ReconcileResult {
  matches: LineMatch[];
  /** External-only references (the provider reported a movement we never recorded). */
  missingInternal: ExternalLine[];
  /** Internal-only references (we recorded a movement the provider never reported). */
  missingExternal: InternalLine[];
  externalTotalCents: Centimes;
  internalTotalCents: Centimes;
  /** externalTotal − internalTotal (the net break, signed). */
  netDifferenceCents: Centimes;
}

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

/** Allowed outgoing transitions per report status (terminal states have none). */
const TRANSITIONS: Record<ReconciliationStatus, readonly ReconciliationStatus[]> = {
  PENDING: ["MATCHED", "UNMATCHED", "RESOLVED"],
  // Re-running is allowed between MATCHED ⇄ UNMATCHED: an operator fixes a break
  // and re-runs (UNMATCHED → MATCHED), or new data surfaces a break (MATCHED →
  // UNMATCHED). RESOLVED is the only terminal state.
  MATCHED: ["UNMATCHED", "RESOLVED"],
  UNMATCHED: ["MATCHED", "RESOLVED"],
  RESOLVED: [],
};

export function canTransition(from: ReconciliationStatus, to: ReconciliationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReconciliationStatus, to: ReconciliationStatus): void {
  if (!canTransition(from, to)) {
    throw new ReconciliationError(`illegal reconciliation transition ${from} -> ${to}`);
  }
}

/** Classify a reference present on both sides: exact, or a centime difference. */
export function classifyMatch(
  externalCents: Centimes,
  internalCents: Centimes,
): "EXACT" | "AMOUNT_DIFF" {
  return externalCents === internalCents ? "EXACT" : "AMOUNT_DIFF";
}

/** Signed difference (external − internal). */
export function differenceCents(externalCents: Centimes, internalCents: Centimes): Centimes {
  return centimes(externalCents - internalCents);
}

/** A report is "clean" only when there are no breaks at all. */
export function isClean(result: ReconcileResult): boolean {
  return (
    result.missingInternal.length === 0 &&
    result.missingExternal.length === 0 &&
    result.matches.every((match) => match.status === "EXACT")
  );
}

/**
 * Match two money lists by reference and classify every line.
 *
 * Both sides are aggregated by `reference` (duplicate references sum) so a report
 * and a ledger are compared as totals per reference — the same semantics as
 * reconciling a bank statement. Output order is deterministic (sorted by
 * reference). The net difference always equals `externalTotal − internalTotal`.
 */
export function reconcile(
  external: readonly ExternalLine[],
  internal: readonly InternalLine[],
): ReconcileResult {
  const externalByRef = new Map<string, Centimes>();
  for (const line of external) {
    externalByRef.set(
      line.reference,
      centimes((externalByRef.get(line.reference) ?? 0) + line.amountCents),
    );
  }

  const internalByRef = new Map<string, Centimes>();
  for (const line of internal) {
    internalByRef.set(
      line.reference,
      centimes((internalByRef.get(line.reference) ?? 0) + line.amountCents),
    );
  }

  const refs = new Set([...externalByRef.keys(), ...internalByRef.keys()]);
  const sortedRefs = [...refs].sort();

  const matches: LineMatch[] = [];
  const missingInternal: ExternalLine[] = [];
  const missingExternal: InternalLine[] = [];

  let externalTotal = 0;
  let internalTotal = 0;

  for (const reference of sortedRefs) {
    const externalCents = externalByRef.get(reference);
    const internalCents = internalByRef.get(reference);

    if (externalCents !== undefined && internalCents !== undefined) {
      matches.push({
        reference,
        status: classifyMatch(externalCents, internalCents),
        externalCents,
        internalCents,
        differenceCents: differenceCents(externalCents, internalCents),
      });
      externalTotal += externalCents;
      internalTotal += internalCents;
    } else if (externalCents !== undefined) {
      missingInternal.push({ reference, amountCents: externalCents });
      externalTotal += externalCents;
    } else if (internalCents !== undefined) {
      missingExternal.push({ reference, amountCents: internalCents });
      internalTotal += internalCents;
    }
  }

  return {
    matches,
    missingInternal,
    missingExternal,
    externalTotalCents: centimes(externalTotal),
    internalTotalCents: centimes(internalTotal),
    netDifferenceCents: centimes(externalTotal - internalTotal),
  };
}
