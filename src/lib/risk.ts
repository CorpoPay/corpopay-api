import { type Centimes, centimes } from "./money";

/**
 * Risk engine (PayFac fraud/risk) — pure, centime-exact, side-effect-free.
 *
 * v1 rules are deliberately simple (amount + velocity), ported verbatim from the
 * deprecated Rails `corpopay-core` spike (`Risk::Evaluator` + `Risk::Velocity`):
 *
 *   - an amount above `maxAmountCents` -> BLOCK (`amount_exceeds_threshold`);
 *   - otherwise, a prior event count >= `maxPerWindow` -> REVIEW
 *     (`velocity_exceeds_threshold`);
 *   - otherwise -> ALLOW.
 *
 * `score` is always the prior in-window event count. Amounts cross the boundary
 * as integer centimes (see `money.ts`); the engine never touches MAD decimals.
 *
 * The default velocity store is in-memory (faithful to the spike, and what the
 * unit/property tests exercise). Production uses a DB-backed count in
 * `risk-db.ts` because a serverless process cannot rely on in-process memory.
 */

export const RISK_VERDICTS = ["ALLOW", "REVIEW", "BLOCK"] as const;
export type RiskVerdict = (typeof RISK_VERDICTS)[number];

export const RISK_REASONS = ["amount_exceeds_threshold", "velocity_exceeds_threshold"] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

export interface RiskThresholds {
  maxAmountCents: Centimes;
  maxPerWindow: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  maxAmountCents: centimes(1_000_000),
  maxPerWindow: 10,
};

export const DEFAULT_VELOCITY_WINDOW_SECONDS = 3600;

export interface RiskEvent {
  id: string;
  type: string;
  tenantId: string;
  amountCents: Centimes;
  occurredAt: Date;
}

export interface RiskDecision {
  eventId: string;
  tenantId: string;
  verdict: RiskVerdict;
  score: number;
  reasons: RiskReason[];
}

/**
 * The pure decision core: amount + prior velocity count -> verdict.
 *
 * Mirrors `Risk::Evaluator#evaluate` exactly, including the strict `>` on the
 * amount threshold, the `>=` on the velocity threshold, and `score = count`.
 */
export function evaluateRisk(
  amountCents: Centimes,
  velocityCount: number,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): Pick<RiskDecision, "verdict" | "score" | "reasons"> {
  if (amountCents > thresholds.maxAmountCents) {
    return { verdict: "BLOCK", score: velocityCount, reasons: ["amount_exceeds_threshold"] };
  }
  if (velocityCount >= thresholds.maxPerWindow) {
    return { verdict: "REVIEW", score: velocityCount, reasons: ["velocity_exceeds_threshold"] };
  }
  return { verdict: "ALLOW", score: velocityCount, reasons: [] };
}

/** A sliding-window velocity store. In-memory by default; inject a DB-backed one. */
export interface VelocityStore {
  add(key: string, at: Date, windowSeconds: number): void;
  count(key: string, at: Date, windowSeconds: number): number;
}

/**
 * In-memory store: one timestamp per event, pruned on read/write. Kept faithful
 * to the Rails `MemoryStore` (timestamps older than `at - window` are dropped; a
 * timestamp exactly at the cutoff is kept).
 */
export class MemoryVelocityStore implements VelocityStore {
  private readonly events = new Map<string, Date[]>();

  add(key: string, at: Date, windowSeconds: number): void {
    this.prune(key, at, windowSeconds);
    const list = this.events.get(key) ?? [];
    list.push(at);
    this.events.set(key, list);
  }

  count(key: string, at: Date, windowSeconds: number): number {
    this.prune(key, at, windowSeconds);
    return (this.events.get(key) ?? []).length;
  }

  private prune(key: string, at: Date, windowSeconds: number): void {
    const cutoffMs = at.getTime() - windowSeconds * 1000;
    const list = this.events.get(key);
    if (!list) return;
    this.events.set(
      key,
      list.filter((t) => t.getTime() >= cutoffMs),
    );
  }
}

/** Sliding-window velocity counter keyed by tenant (or any string). */
export class Velocity {
  constructor(
    private readonly store: VelocityStore = new MemoryVelocityStore(),
    private readonly windowSeconds: number = DEFAULT_VELOCITY_WINDOW_SECONDS,
  ) {}

  record(key: string, at: Date): void {
    this.store.add(key, at, this.windowSeconds);
  }

  count(key: string, at: Date): number {
    return this.store.count(key, at, this.windowSeconds);
  }
}

/**
 * Stateful evaluator (velocity + thresholds) — the direct TS port of
 * `Risk::Evaluator`. Counts *before* recording, so `score` is the prior count.
 */
export class Evaluator {
  constructor(
    private readonly velocity: Velocity = new Velocity(),
    private readonly thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
  ) {}

  evaluate(event: RiskEvent): RiskDecision {
    const count = this.velocity.count(event.tenantId, event.occurredAt);
    this.velocity.record(event.tenantId, event.occurredAt);
    const { verdict, score, reasons } = evaluateRisk(event.amountCents, count, this.thresholds);
    return { eventId: event.id, tenantId: event.tenantId, verdict, score, reasons };
  }
}
