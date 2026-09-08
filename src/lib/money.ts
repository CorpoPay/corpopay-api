import type { Prisma } from "@/generated/prisma/client";

/**
 * Money units and conversions.
 *
 * CorpoPay deals in two money representations that must never be confused:
 *
 *   - **Minor units** (integer) — the smallest currency unit (centimes for MAD,
 *     cents for USD/EUR/GBP/CAD). Used at the API boundary (request bodies), in
 *     provider adapters, and in `metadata.amount`.
 *   - **Major units** — the currency's `Decimal(12,2)` (or plain number) as
 *     stored in the database (`PaymentLink.amount`, `Subscription.amount`, …).
 *
 * The historical bug class here is **double multiplication** — treating an
 * already-minor value as major and multiplying by 100 again. Branding the two
 * units as distinct TypeScript types makes that a compile error at the
 * conversion boundary, and routing every conversion through the helpers below
 * keeps the "×10^exp / ÷10^exp" logic in exactly one auditable place.
 *
 * Multi-currency (ADR 0006): the helpers are currency-aware. MAD remains the
 * historical default; `madToCentimes` / `centimesToMad` / `centimesToMadString`
 * are thin aliases of the generic helpers for `"MAD"` so existing callers are
 * unchanged while new callers pass an explicit currency.
 */

/** ISO 4217 currencies supported in v1 (all two-decimal minor units). */
export const SUPPORTED_CURRENCIES = ["MAD", "USD", "EUR", "GBP", "CAD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor-unit exponent per currency: `10^exponent` minor units = 1 major unit. */
export const MINOR_UNIT_EXPONENTS: Record<Currency, number> = {
  MAD: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
};

export type Centimes = number & { readonly __brand: "centimes" };
export type MAD = number & { readonly __brand: "mad" };

/** Brand a raw integer as minor units (centimes for MAD). */
export function centimes(n: number): Centimes {
  return Math.round(n) as Centimes;
}

/** Brand a raw number as MAD. */
export function mad(n: number): MAD {
  return n as MAD;
}

/** The minor-unit exponent for a currency (how many minor units per major unit). */
export function minorUnitExponent(currency: Currency): number {
  return MINOR_UNIT_EXPONENTS[currency];
}

/** Major → minor units. Accepts a Prisma `Decimal`, a number, or a string. */
export function toMinor(
  amount: Prisma.Decimal | number | string,
  currency: Currency = "MAD",
): Centimes {
  return centimes(Math.round(Number(amount) * 10 ** minorUnitExponent(currency)));
}

/** Minor → major units as a plain number (for a Prisma `Decimal(12,2)` column). */
export function fromMinor(minor: Centimes, currency: Currency = "MAD"): number {
  return Number(minor) / 10 ** minorUnitExponent(currency);
}

/** Minor → major units as a fixed-decimal string (for provider payloads). */
export function toMinorString(minor: Centimes, currency: Currency = "MAD"): string {
  return fromMinor(minor, currency).toFixed(minorUnitExponent(currency));
}

/** MAD → centimes (alias of `toMinor(…, "MAD")`). */
export function madToCentimes(madAmount: Prisma.Decimal | number | string): Centimes {
  return toMinor(madAmount, "MAD");
}

/** Centimes → MAD as a plain number (alias of `fromMinor(…, "MAD")`). */
export function centimesToMad(centimesAmount: Centimes): number {
  return fromMinor(centimesAmount, "MAD");
}

/** Centimes → MAD as a two-decimal string (alias of `toMinorString(…, "MAD")`). */
export function centimesToMadString(centimesAmount: Centimes): string {
  return toMinorString(centimesAmount, "MAD");
}
