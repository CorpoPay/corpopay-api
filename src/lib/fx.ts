/**
 * FX (foreign-exchange) reference rates + locked quotes (ADR 0006, phase 4).
 *
 * CorpoPay is currency-aware at the ledger level: money is stored per ISO 4217
 * currency and never mixes currencies in one balance. When a tenant settles in a
 * currency different from the one their customer paid in, that balance must be
 * converted. The rate used is a **locked quote** — CorpoPay quotes a rate before
 * the tenant acts, the tenant confirms, and that rate is fixed onto the intent /
 * payout. Any later market movement is the tenant's exposure, never CorpoPay's
 * spot risk.
 *
 * Rate sources:
 *   - `sandbox` (default) — a deterministic, network-free table so tests, demos
 *     and local development are reproducible (no `Math.random()` / `Date.now()`).
 *   - `ecb` — the ECB daily reference rates (free, EUR-anchored). MAD is not
 *     published by the ECB, so a fixed MAD anchor is used for MAD cross-rates.
 *     The exact provider is a config value (`FX_RATE_PROVIDER`), not a
 *     code-level commitment.
 *
 * Everything here is a plain number-to-number transform; the quote carries an
 * expiry so a stale rate is never silently reused.
 */
import { type Centimes, type Currency, centimes, SUPPORTED_CURRENCIES } from "./money";

/** How long a quoted rate stays valid (24h). */
export const FX_QUOTE_TTL_MS = 24 * 60 * 60 * 1000;

/** How many decimal places a quoted rate is rounded to (enough for 2-dp minor units). */
const FX_RATE_PRECISION = 8;

/**
 * Deterministic anchor rates: `1 unit of each currency` expressed in MAD.
 * Used by the sandbox provider and as the MAD anchor for the ECB provider
 * (the ECB does not publish MAD).
 */
export const FX_BASE_RATES: Record<Currency, number> = {
  MAD: 1,
  USD: 10.05,
  EUR: 11.02,
  GBP: 12.88,
  CAD: 7.41,
};

export interface FxRateProvider {
  readonly name: string;
  /** 1 `from` = returned rate `to`. */
  getRate(from: Currency, to: Currency): Promise<number>;
}

/** A locked FX quote: the rate, its source, and when it expires. */
export interface FxQuote {
  from: Currency;
  to: Currency;
  /** `1 from = rate to`, as a fixed-decimal string (avoid float drift). */
  rate: string;
  source: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** Round a numeric rate to `FX_RATE_PRECISION` decimal places. */
export function roundRate(rate: number): number {
  const factor = 10 ** FX_RATE_PRECISION;
  return Math.round(rate * factor) / factor;
}

/** Format a rate as a fixed-decimal string (never scientific notation). */
export function formatRate(rate: number): string {
  return roundRate(rate).toFixed(FX_RATE_PRECISION);
}

/** Cross-rate between two currencies via their MAD-anchor values. */
export function crossRate(from: Currency, to: Currency, base: Record<Currency, number>): number {
  if (from === to) return 1;
  return base[from] / base[to];
}

/** The deterministic sandbox provider (default). */
export const sandboxFxProvider: FxRateProvider = {
  name: "sandbox",
  async getRate(from, to) {
    return crossRate(from, to, FX_BASE_RATES);
  },
};

/**
 * Parse the ECB daily reference XML (`eurofxref-daily.xml`) into an
 * EUR-anchored table: `1 EUR = returned value currency`.
 *
 * Pure and side-effect-free so it is unit-testable without a network call.
 */
export function parseEcbRates(xml: string): Record<string, number> {
  const rates: Record<string, number> = {};
  const cube = /<Cube currency=['"]([A-Z]{3})['"] rate=['"]([0-9.]+)['"]\/>/g;
  for (const match of xml.matchAll(cube)) {
    const currency = match[1];
    const rate = Number(match[2]);
    if (Number.isFinite(rate)) rates[currency] = rate;
  }
  return rates;
}

/**
 * The ECB provider — fetches the ECB daily reference rates and resolves any
 * cross-rate through the EUR anchor. MAD (not published by the ECB) uses the
 * deterministic `FX_BASE_RATES[EUR]` anchor, so MAD pairs stay reproducible.
 */
function createEcbFxProvider(fetchImpl: typeof fetch = fetch): FxRateProvider {
  return {
    name: "ecb",
    async getRate(from, to) {
      const eurAnchored: Record<string, number> = {};
      try {
        const res = await fetchImpl(
          "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        );
        if (res.ok) {
          Object.assign(eurAnchored, parseEcbRates(await res.text()));
        }
      } catch {
        // Network failure → fall through to the deterministic base rates below.
      }
      eurAnchored.EUR = 1;
      // ECB has no MAD; anchor it to the deterministic base rate.
      eurAnchored.MAD = FX_BASE_RATES.EUR;

      // `eurAnchored[c]` = "1 EUR = c". So 1 `from` = eurAnchored[to]/eurAnchored[from] `to`.
      if (from === to) return 1;
      const fromEur = eurAnchored[from];
      const toEur = eurAnchored[to];
      if (fromEur == null || toEur == null) {
        // Fall back to the deterministic sandbox cross-rate for any missing pair.
        return crossRate(from, to, FX_BASE_RATES);
      }
      return toEur / fromEur;
    },
  };
}

/** Select the active FX provider from `FX_RATE_PROVIDER` (defaults to sandbox). */
function getFxProvider(): FxRateProvider {
  const name = process.env.FX_RATE_PROVIDER ?? "sandbox";
  return name === "ecb" ? createEcbFxProvider() : sandboxFxProvider;
}

/** Quote a locked rate for a currency pair. Deterministic given `now` + provider. */
export async function quoteFx(
  from: Currency,
  to: Currency,
  now: Date = new Date(),
): Promise<FxQuote> {
  const provider = getFxProvider();
  const rate = await provider.getRate(from, to);
  return {
    from,
    to,
    rate: formatRate(rate),
    source: provider.name,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + FX_QUOTE_TTL_MS),
  };
}

/** Convert a minor-unit amount across a currency pair using a rate string. */
export function convertMinor(amountMinor: Centimes, rate: string | number): Centimes {
  return centimes(Math.round(Number(amountMinor) * Number(rate)));
}

/** The `"FROM/TO"` pair key stored on intents/payouts (e.g. `"EUR/MAD"`). */
export function currencyPairKey(from: Currency, to: Currency): string {
  return `${from}/${to}`;
}

/** Parse a `"FROM/TO"` pair key back into its two currencies. */
export function parseCurrencyPair(pair: string): { from: Currency; to: Currency } | null {
  const [from, to] = pair.split("/");
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) return null;
  return { from, to };
}

/** Type guard for a supported ISO 4217 currency. */
export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
