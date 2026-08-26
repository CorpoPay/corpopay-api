/**
 * Industry / MCC settlement presets (PayFac flexibility layer).
 *
 * A tenant's settlement behaviour is parameterized by six dimensions (see the
 * PayFac design doc §6) plus a fee model. Rather than encode each vertical as a
 * code path, a vertical is a **preset**: a named, complete set of defaults for
 * those dimensions. Onboarding a new industry is therefore adding a row here —
 * not writing control flow.
 *
 * These are pure data (no DB, no side effects). The DB stores per-tenant,
 * versioned `SettlementPolicy` + `FeeSchedule` rows that *override* these
 * defaults; a policy without an explicit value falls back to its preset.
 */
import type {
  AvailabilityMode,
  FeeType,
  PayoutSchedule,
  ReserveType,
  ReversalFundingPolicy,
} from "@/generated/prisma/client";

import type { FeeScheduleSpec } from "./fees";

export interface IndustryPreset {
  industry: string;
  mcc: string | null;
  fee: FeeScheduleSpec;
  availabilityMode: AvailabilityMode;
  availabilityDelayDays: number | null;
  reserveType: ReserveType;
  reservePercentageBps: number | null;
  reserveHoldDays: number | null;
  reserveFixedCents: number | null;
  payoutSchedule: PayoutSchedule;
  payoutMinCents: number | null;
  reversalFunding: ReversalFundingPolicy;
  allowNegative: boolean;
  splittingEnabled: boolean;
}

/** General-purpose PayFac default (the design doc §6 table). */
export const DEFAULT_PRESET: IndustryPreset = {
  industry: "default",
  mcc: null,
  fee: {
    feeType: "PERCENTAGE" as FeeType,
    flatCents: null,
    percentageBps: 290, // 2.9%
    perMethodCents: null,
    tiersCents: null,
  },
  availabilityMode: "IMMEDIATE",
  availabilityDelayDays: null,
  reserveType: "ROLLING",
  reservePercentageBps: 500, // 5%
  reserveHoldDays: 30,
  reserveFixedCents: null,
  payoutSchedule: "AUTO_DAILY",
  payoutMinCents: null,
  reversalFunding: "NET_FROM_AVAILABLE",
  allowNegative: false,
  splittingEnabled: false,
};

export const INDUSTRY_PRESETS: Record<string, IndustryPreset> = {
  saas: {
    industry: "saas",
    mcc: "5734", // computer software
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 290,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "IMMEDIATE",
    availabilityDelayDays: null,
    reserveType: "NONE",
    reservePercentageBps: null,
    reserveHoldDays: null,
    reserveFixedCents: null,
    payoutSchedule: "AUTO_DAILY",
    payoutMinCents: null,
    reversalFunding: "NET_FROM_AVAILABLE",
    allowNegative: false,
    splittingEnabled: false,
  },
  marketplace: {
    industry: "marketplace",
    mcc: "5262", // marketplaces
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 350,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "ON_FULFILLMENT",
    availabilityDelayDays: null,
    reserveType: "ROLLING",
    reservePercentageBps: 1000, // 10%
    reserveHoldDays: 30,
    reserveFixedCents: null,
    payoutSchedule: "THRESHOLD",
    payoutMinCents: 100000, // 1000.00 MAD
    reversalFunding: "DEBIT_RESERVE",
    allowNegative: false,
    splittingEnabled: true,
  },
  retail: {
    industry: "retail",
    mcc: "5999", // miscellaneous retail
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 250,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "IMMEDIATE",
    availabilityDelayDays: null,
    reserveType: "ROLLING",
    reservePercentageBps: 300, // 3%
    reserveHoldDays: 14,
    reserveFixedCents: null,
    payoutSchedule: "AUTO_DAILY",
    payoutMinCents: null,
    reversalFunding: "NET_FROM_AVAILABLE",
    allowNegative: false,
    splittingEnabled: false,
  },
  travel: {
    industry: "travel",
    mcc: "4722", // travel agencies
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 320,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "DELAY",
    availabilityDelayDays: 7,
    reserveType: "ROLLING",
    reservePercentageBps: 1000, // 10%
    reserveHoldDays: 60,
    reserveFixedCents: null,
    payoutSchedule: "AUTO_WEEKLY",
    payoutMinCents: null,
    reversalFunding: "DEBIT_RESERVE",
    allowNegative: false,
    splittingEnabled: false,
  },
  escrow: {
    industry: "escrow",
    mcc: "7399", // business services (escrow)
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 150,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "ON_FULFILLMENT",
    availabilityDelayDays: null,
    reserveType: "NONE",
    reservePercentageBps: null,
    reserveHoldDays: null,
    reserveFixedCents: null,
    payoutSchedule: "MANUAL",
    payoutMinCents: null,
    reversalFunding: "INVOICE_TENANT",
    allowNegative: false,
    splittingEnabled: false,
  },
  lending: {
    industry: "lending",
    mcc: "6012", // financial institutions — merchandise/services
    fee: {
      feeType: "FLAT",
      flatCents: 500,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "IMMEDIATE",
    availabilityDelayDays: null,
    reserveType: "NONE",
    reservePercentageBps: null,
    reserveHoldDays: null,
    reserveFixedCents: null,
    payoutSchedule: "MANUAL", // disbursement-first; CorpoPay pays out then collects
    payoutMinCents: null,
    reversalFunding: "ALLOW_NEGATIVE",
    allowNegative: true,
    splittingEnabled: false,
  },
  on_demand: {
    industry: "on_demand",
    mcc: "4121", // taxi/limousine
    fee: {
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 400,
      perMethodCents: null,
      tiersCents: null,
    },
    availabilityMode: "IMMEDIATE",
    availabilityDelayDays: null,
    reserveType: "NONE",
    reservePercentageBps: null,
    reserveHoldDays: null,
    reserveFixedCents: null,
    payoutSchedule: "INSTANT",
    payoutMinCents: null,
    reversalFunding: "NET_FROM_AVAILABLE",
    allowNegative: false,
    splittingEnabled: false,
  },
};

/** Resolve an industry to its preset, falling back to the general default. */
export function presetForIndustry(industry?: string | null): IndustryPreset {
  if (industry && INDUSTRY_PRESETS[industry]) return INDUSTRY_PRESETS[industry];
  return DEFAULT_PRESET;
}

/** Every industry key with a preset (for API surfaces / docs). */
export const INDUSTRY_KEYS = Object.keys(INDUSTRY_PRESETS);
