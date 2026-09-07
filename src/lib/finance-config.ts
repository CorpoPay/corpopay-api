/**
 * Finance capability layer (PayFac money models).
 *
 * Every money-flow feature is an independent, tenant-toggleable capability so
 * CorpoPay can sell each feature individually and a tenant's whole money model
 * is just the set of enabled capabilities. Presets are named shortcuts that seed
 * the set; the validator below is the "smartness" that rejects combinations that
 * cannot work.
 *
 * Pure and money-agnostic: this module never touches MAD decimals or centimes
 * (see `money.ts`). It only decides whether a capability set is valid.
 */

export const FINANCE_CAPABILITIES = [
  "INSTANT_CAPTURE",
  "PREAUTH_CAPTURE",
  "WALLET",
  "SUBSCRIPTIONS",
  "INSTALLMENTS",
  "MARKETPLACE_SPLITS",
] as const;

export type FinanceCapability = (typeof FINANCE_CAPABILITIES)[number];

/** Features that cannot run without at least one card-capture funding method. */
const CAPTURE_DEPENDENT: readonly FinanceCapability[] = [
  "SUBSCRIPTIONS",
  "INSTALLMENTS",
  "MARKETPLACE_SPLITS",
];

/**
 * When CorpoPay takes its wallet commission. `usage` (default) charges on each
 * draw-down (the OtoParking pay-as-you-go model); `load` charges once, on top-up.
 * A no-op unless the `WALLET` capability is enabled.
 */
export const WALLET_COMMISSION_BASIS = ["usage", "load"] as const;

export type WalletCommissionBasis = (typeof WALLET_COMMISSION_BASIS)[number];

export const DEFAULT_WALLET_COMMISSION_BASIS: WalletCommissionBasis = "usage";

export type FinanceConfigValidationCode =
  | "UNKNOWN_CAPABILITY"
  | "DUPLICATE_CAPABILITY"
  | "REQUIRES_CAPTURE_FUNDING"
  | "INVALID_WALLET_COMMISSION_BASIS";

export interface FinanceConfigViolation {
  code: FinanceConfigValidationCode;
  message: string;
  capability?: FinanceCapability;
}

export const FINANCE_PRESETS = {
  standard: ["INSTANT_CAPTURE", "PREAUTH_CAPTURE", "SUBSCRIPTIONS", "INSTALLMENTS"],
  wallet: ["WALLET", "INSTANT_CAPTURE"],
  marketplace: ["INSTANT_CAPTURE", "PREAUTH_CAPTURE", "MARKETPLACE_SPLITS"],
  full: [
    "INSTANT_CAPTURE",
    "PREAUTH_CAPTURE",
    "WALLET",
    "SUBSCRIPTIONS",
    "INSTALLMENTS",
    "MARKETPLACE_SPLITS",
  ],
} as const satisfies Record<string, readonly FinanceCapability[]>;

export type FinancePreset = keyof typeof FINANCE_PRESETS;

export function presetCapabilities(preset: FinancePreset): FinanceCapability[] {
  return [...FINANCE_PRESETS[preset]];
}

export function validateFinanceCapabilities(
  capabilities: readonly string[],
): FinanceConfigViolation[] {
  const violations: FinanceConfigViolation[] = [];
  const enabled = new Set<FinanceCapability>();
  const known: readonly string[] = FINANCE_CAPABILITIES;

  for (const raw of capabilities) {
    if (!known.includes(raw)) {
      violations.push({
        code: "UNKNOWN_CAPABILITY",
        message: `Unknown finance capability: ${raw}`,
      });
      continue;
    }
    const cap = raw as FinanceCapability;
    if (enabled.has(cap)) {
      violations.push({
        code: "DUPLICATE_CAPABILITY",
        message: `Duplicate finance capability: ${cap}`,
        capability: cap,
      });
      continue;
    }
    enabled.add(cap);
  }

  const hasCapture = enabled.has("INSTANT_CAPTURE") || enabled.has("PREAUTH_CAPTURE");

  for (const cap of CAPTURE_DEPENDENT) {
    if (enabled.has(cap) && !hasCapture) {
      violations.push({
        code: "REQUIRES_CAPTURE_FUNDING",
        message: `${cap} requires INSTANT_CAPTURE or PREAUTH_CAPTURE to be enabled`,
        capability: cap,
      });
    }
  }

  return violations;
}

/** Validate the optional wallet commission basis (defaults to `usage`). */
export function validateWalletCommissionBasis(value: unknown): FinanceConfigViolation[] {
  if (value == null) return [];
  if (!WALLET_COMMISSION_BASIS.includes(value as WalletCommissionBasis)) {
    return [
      {
        code: "INVALID_WALLET_COMMISSION_BASIS",
        message: `Invalid wallet commission basis "${String(value)}"; expected ${WALLET_COMMISSION_BASIS.join(" or ")}`,
      },
    ];
  }
  return [];
}

/** A whole finance-config payload (capabilities + per-capability settings). */
export interface FinanceConfigInput {
  capabilities: readonly string[];
  walletCommissionBasis?: unknown;
}

/** Validate capabilities and settings together (the full config boundary). */
export function validateFinanceConfig(input: FinanceConfigInput): FinanceConfigViolation[] {
  return [
    ...validateFinanceCapabilities(input.capabilities),
    ...validateWalletCommissionBasis(input.walletCommissionBasis),
  ];
}
