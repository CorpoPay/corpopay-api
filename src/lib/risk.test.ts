import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_VELOCITY_WINDOW_SECONDS,
  Evaluator,
  evaluateRisk,
  MemoryVelocityStore,
  RISK_REASONS,
  RISK_VERDICTS,
  type RiskEvent,
  type RiskThresholds,
  Velocity,
} from "./risk";

const T0 = new Date("2026-01-01T00:00:00Z");

function event(overrides: Partial<RiskEvent> = {}): RiskEvent {
  return {
    id: "e1",
    type: "payment.intent.succeeded",
    tenantId: "tenant-a",
    amountCents: centimes(100),
    occurredAt: T0,
    ...overrides,
  };
}

const thresholds: RiskThresholds = { maxAmountCents: centimes(1000), maxPerWindow: 3 };

const makeEvaluator = (overrides: Partial<RiskThresholds> = {}) =>
  new Evaluator(new Velocity(), { ...thresholds, ...overrides });

describe("risk constants", () => {
  it("exposes the three verdicts", () => {
    expect(RISK_VERDICTS).toEqual(["ALLOW", "REVIEW", "BLOCK"]);
  });

  it("exposes the two v1 reasons", () => {
    expect(RISK_REASONS).toEqual(["amount_exceeds_threshold", "velocity_exceeds_threshold"]);
  });

  it("defaults thresholds and window", () => {
    expect(DEFAULT_RISK_THRESHOLDS).toEqual({
      maxAmountCents: centimes(1_000_000),
      maxPerWindow: 10,
    });
    expect(DEFAULT_VELOCITY_WINDOW_SECONDS).toBe(3600);
  });
});

describe("evaluateRisk (pure decision core)", () => {
  it("allows a normal amount with low velocity", () => {
    expect(evaluateRisk(centimes(100), 0, thresholds)).toEqual({
      verdict: "ALLOW",
      score: 0,
      reasons: [],
    });
  });

  it("blocks an amount strictly above the threshold", () => {
    expect(evaluateRisk(centimes(1001), 0, thresholds)).toEqual({
      verdict: "BLOCK",
      score: 0,
      reasons: ["amount_exceeds_threshold"],
    });
  });

  it("does not block an amount exactly at the threshold", () => {
    expect(evaluateRisk(centimes(1000), 0, thresholds).verdict).toBe("ALLOW");
  });

  it("reviews when velocity reaches the threshold (inclusive)", () => {
    expect(evaluateRisk(centimes(100), 3, thresholds)).toEqual({
      verdict: "REVIEW",
      score: 3,
      reasons: ["velocity_exceeds_threshold"],
    });
  });

  it("allows when velocity is just below the threshold", () => {
    expect(evaluateRisk(centimes(100), 2, thresholds).verdict).toBe("ALLOW");
  });

  it("amount check dominates velocity: over-threshold always blocks", () => {
    expect(evaluateRisk(centimes(2000), 99, thresholds)).toEqual({
      verdict: "BLOCK",
      score: 99,
      reasons: ["amount_exceeds_threshold"],
    });
  });

  it("carries score = the prior count", () => {
    expect(evaluateRisk(centimes(100), 7, thresholds).score).toBe(7);
  });
});

describe("Velocity (sliding window)", () => {
  it("counts events within the window", () => {
    const v = new Velocity(new MemoryVelocityStore(), 60);
    v.record("t1", new Date(T0.getTime()));
    v.record("t1", new Date(T0.getTime() + 1000));
    expect(v.count("t1", new Date(T0.getTime() + 2000))).toBe(2);
  });

  it("prunes events outside the window", () => {
    const v = new Velocity(new MemoryVelocityStore(), 60);
    v.record("t1", T0);
    expect(v.count("t1", new Date(T0.getTime() + 61_000))).toBe(0);
  });

  it("keeps an event exactly at the cutoff", () => {
    const v = new Velocity(new MemoryVelocityStore(), 60);
    v.record("t1", T0);
    expect(v.count("t1", new Date(T0.getTime() + 60_000))).toBe(1);
  });

  it("counts per key independently", () => {
    const v = new Velocity(new MemoryVelocityStore(), 60);
    v.record("tenant-a", T0);
    v.record("tenant-b", T0);
    expect(v.count("tenant-a", new Date(T0.getTime() + 1000))).toBe(1);
    expect(v.count("tenant-b", new Date(T0.getTime() + 1000))).toBe(1);
  });
});

describe("Evaluator (stateful)", () => {
  it("allows normal transactions", () => {
    expect(makeEvaluator().evaluate(event({ amountCents: centimes(100) })).verdict).toBe("ALLOW");
  });

  it("blocks over-threshold amounts", () => {
    const decision = makeEvaluator().evaluate(event({ amountCents: centimes(2000) }));
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toContain("amount_exceeds_threshold");
  });

  it("reviews when velocity exceeds the threshold (count before record)", () => {
    const evaluator = makeEvaluator();
    for (let i = 0; i < 3; i++) {
      evaluator.evaluate(event({ id: `e${i}` }));
    }
    const decision = evaluator.evaluate(event({ id: "e4" }));
    expect(decision.verdict).toBe("REVIEW");
    expect(decision.reasons).toContain("velocity_exceeds_threshold");
    expect(decision.score).toBe(3);
  });
});
