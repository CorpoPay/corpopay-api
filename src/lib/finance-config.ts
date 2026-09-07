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

export type FinanceConfigValidationCode =
  | "UNKNOWN_CAPABILITY"
  | "DUPLICATE_CAPABILITY"
  | "REQUIRES_CAPTURE_FUNDING";

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
