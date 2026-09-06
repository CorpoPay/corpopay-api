import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./prisma", () => ({
  prisma: {
    merchantOnboarding: { findUnique: vi.fn() },
    paymentIntent: { count: vi.fn() },
  },
}));

import { centimes } from "./money";
import { prisma } from "./prisma";
import {
  RISK_TIER_THRESHOLDS,
  resetRiskScorer,
  scoreRisk,
  setRiskScorer,
  thresholdsForTier,
} from "./risk-scorer";

const mockFindOnboarding = prisma.merchantOnboarding.findUnique as ReturnType<typeof vi.fn>;
const mockCountIntents = prisma.paymentIntent.count as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetRiskScorer();
});

describe("RISK_TIER_THRESHOLDS", () => {
  it("LOW is most permissive and HIGH strictest", () => {
    expect(RISK_TIER_THRESHOLDS.LOW).toEqual({
      maxAmountCents: centimes(10_000_000),
      maxPerWindow: 200,
    });
    expect(RISK_TIER_THRESHOLDS.HIGH).toEqual({
      maxAmountCents: centimes(100_000),
      maxPerWindow: 5,
    });
  });
});

describe("thresholdsForTier", () => {
  it("maps each tier to its own thresholds", () => {
    expect(thresholdsForTier("LOW")).toBe(RISK_TIER_THRESHOLDS.LOW);
    expect(thresholdsForTier("MEDIUM")).toBe(RISK_TIER_THRESHOLDS.MEDIUM);
    expect(thresholdsForTier("HIGH")).toBe(RISK_TIER_THRESHOLDS.HIGH);
  });

  it("falls back to MEDIUM for null/undefined", () => {
    expect(thresholdsForTier(null)).toBe(RISK_TIER_THRESHOLDS.MEDIUM);
    expect(thresholdsForTier(undefined)).toBe(RISK_TIER_THRESHOLDS.MEDIUM);
  });
});

describe("scoreRisk (default DB-backed scorer)", () => {
  it("allows a normal amount with no prior velocity", async () => {
    mockFindOnboarding.mockResolvedValue({ riskTier: "MEDIUM" });
    mockCountIntents.mockResolvedValue(0);
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(100) });
    expect(r).toEqual({ verdict: "ALLOW", score: 0, reasons: [] });
  });

  it("blocks an amount above the tier threshold", async () => {
    mockFindOnboarding.mockResolvedValue({ riskTier: "HIGH" });
    mockCountIntents.mockResolvedValue(0);
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(200_000) });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reasons).toEqual(["amount_exceeds_threshold"]);
  });

  it("reviews when velocity reaches the window threshold", async () => {
    mockFindOnboarding.mockResolvedValue({ riskTier: "MEDIUM" });
    mockCountIntents.mockResolvedValue(10);
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(100) });
    expect(r.verdict).toBe("REVIEW");
    expect(r.reasons).toEqual(["velocity_exceeds_threshold"]);
  });

  it("treats a missing onboarding record as MEDIUM", async () => {
    mockFindOnboarding.mockResolvedValue(null);
    mockCountIntents.mockResolvedValue(0);
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(100) });
    expect(r.verdict).toBe("ALLOW");
  });
});

describe("setRiskScorer seam", () => {
  it("uses the injected scorer instead of the DB-backed default", async () => {
    setRiskScorer(async () => ({
      verdict: "BLOCK",
      score: 0,
      reasons: ["amount_exceeds_threshold"],
    }));
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(100) });
    expect(r.verdict).toBe("BLOCK");
    expect(mockFindOnboarding).not.toHaveBeenCalled();
    expect(mockCountIntents).not.toHaveBeenCalled();
  });

  it("resetRiskScorer restores the DB-backed default", async () => {
    setRiskScorer(async () => ({
      verdict: "BLOCK",
      score: 0,
      reasons: ["amount_exceeds_threshold"],
    }));
    resetRiskScorer();
    mockFindOnboarding.mockResolvedValue({ riskTier: "MEDIUM" });
    mockCountIntents.mockResolvedValue(0);
    const r = await scoreRisk({ tenantId: "t", amountCents: centimes(100) });
    expect(r.verdict).toBe("ALLOW");
  });
});
