import type { Prisma } from "@/generated/prisma/client";

/**
 * Money units and conversions.
 *
 * CorpoPay deals in two money representations that must never be confused:
 *
 *   - **Centimes** — the smallest currency unit (integer). Used at the API
 *     boundary (request bodies), in provider adapters, and in `metadata.amount`.
 *   - **MAD** — Moroccan dirham as a `Decimal(12,2)` (or plain number) in the
 *     database (`PaymentLink.amount`, `Subscription.amount`, `Refund.amount`, …).
 *
 * The historical bug class here is **double multiplication** — treating an
 * already-centime value as MAD and multiplying by 100 again. Branding the two
 * units as distinct TypeScript types makes that a compile error at the
 * conversion boundary, and routing every conversion through the helpers below
 * keeps the "×100 / ÷100" logic in exactly one auditable place.
 */

export type Centimes = number & { readonly __brand: "centimes" };
export type MAD = number & { readonly __brand: "mad" };

/** Brand a raw integer as centimes. */
export function centimes(n: number): Centimes {
  return Math.round(n) as Centimes;
}

/** Brand a raw number as MAD. */
export function mad(n: number): MAD {
  return n as MAD;
}

/** MAD → centimes. Accepts a Prisma `Decimal` (what the DB returns), a number, or a string. */
export function madToCentimes(madAmount: Prisma.Decimal | number | string): Centimes {
  return centimes(Math.round(Number(madAmount) * 100));
}

/** Centimes → MAD as a plain number (suitable for a Prisma `Decimal(12,2)` column). */
export function centimesToMad(centimesAmount: Centimes): number {
  return Number(centimesAmount) / 100;
}

/** Centimes → MAD as a two-decimal string (for provider payloads that want a string). */
export function centimesToMadString(centimesAmount: Centimes): string {
  return centimesToMad(centimesAmount).toFixed(2);
}
