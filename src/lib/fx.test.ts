import { describe, expect, it } from "vitest";
import {
  convertMinor,
  crossRate,
  currencyPairKey,
  FX_BASE_RATES,
  FX_QUOTE_TTL_MS,
  formatRate,
  isSupportedCurrency,
  parseCurrencyPair,
  parseEcbRates,
  quoteFx,
  roundRate,
  sandboxFxProvider,
} from "./fx";
import { centimes, SUPPORTED_CURRENCIES } from "./money";

const NOW = new Date("2026-09-08T00:00:00.000Z");

describe("crossRate", () => {
  it("is the identity for a same-currency pair", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      expect(crossRate(c, c, FX_BASE_RATES)).toBe(1);
    }
  });

  it("computes MAD-anchored cross rates", () => {
    expect(crossRate("EUR", "MAD", FX_BASE_RATES)).toBe(FX_BASE_RATES.EUR);
    expect(crossRate("USD", "MAD", FX_BASE_RATES)).toBe(FX_BASE_RATES.USD);
    expect(crossRate("EUR", "USD", FX_BASE_RATES)).toBeCloseTo(
      FX_BASE_RATES.EUR / FX_BASE_RATES.USD,
      10,
    );
  });

  it("is antisymmetric: rate(a,b) * rate(b,a) = 1", () => {
    for (const a of SUPPORTED_CURRENCIES) {
      for (const b of SUPPORTED_CURRENCIES) {
        if (a === b) continue;
        expect(crossRate(a, b, FX_BASE_RATES) * crossRate(b, a, FX_BASE_RATES)).toBeCloseTo(1, 8);
      }
    }
  });
});

describe("roundRate / formatRate", () => {
  it("rounds to FX_RATE_PRECISION decimal places", () => {
    expect(roundRate(11.024444449)).toBe(11.02444445);
    expect(formatRate(11.02)).toBe("11.02000000");
    expect(formatRate(0.90909090909)).toBe("0.90909091");
  });
});

describe("parseEcbRates", () => {
  it("extracts EUR-anchored rates from the ECB daily XML", () => {
    const xml = `<Envelope><Cube><Cube time="2026-09-08">
      <Cube currency="USD" rate="1.0845"/>
      <Cube currency="GBP" rate="0.84210"/>
      <Cube currency="CAD" rate="1.5012"/>
    </Cube></Cube></Envelope>`;
    expect(parseEcbRates(xml)).toEqual({ USD: 1.0845, GBP: 0.8421, CAD: 1.5012 });
  });

  it("returns an empty table for malformed XML", () => {
    expect(parseEcbRates("<not-xml>")).toEqual({});
  });
});

describe("convertMinor", () => {
  it("converts minor units across a pair via a rate", () => {
    expect(convertMinor(centimes(1000), "11.02000000")).toBe(11020); // 10.00 EUR → 110.20 MAD
    expect(convertMinor(centimes(1050), "1")).toBe(1050);
  });

  it("rounds to the nearest minor unit", () => {
    expect(convertMinor(centimes(1001), "0.5")).toBe(501); // 1000.5 → 501
  });
});

describe("quoteFx", () => {
  it("quotes the sandbox rate with a fixed expiry", async () => {
    const quote = await quoteFx("EUR", "MAD", NOW);
    expect(quote.from).toBe("EUR");
    expect(quote.to).toBe("MAD");
    expect(quote.source).toBe("sandbox");
    expect(quote.rate).toBe(formatRate(FX_BASE_RATES.EUR));
    expect(quote.issuedAt).toEqual(NOW);
    expect(quote.expiresAt).toEqual(new Date(NOW.getTime() + FX_QUOTE_TTL_MS));
  });

  it("quotes the identity rate for a same-currency pair", async () => {
    const quote = await quoteFx("MAD", "MAD", NOW);
    expect(quote.rate).toBe("1.00000000");
  });
});

describe("sandboxFxProvider", () => {
  it("returns the deterministic base cross-rate", async () => {
    await expect(sandboxFxProvider.getRate("GBP", "CAD")).resolves.toBeCloseTo(
      FX_BASE_RATES.GBP / FX_BASE_RATES.CAD,
      10,
    );
  });
});

describe("currency pair helpers", () => {
  it("round-trips a pair key", () => {
    expect(currencyPairKey("EUR", "MAD")).toBe("EUR/MAD");
    expect(parseCurrencyPair("EUR/MAD")).toEqual({ from: "EUR", to: "MAD" });
  });

  it("rejects an unsupported pair", () => {
    expect(parseCurrencyPair("EUR/XXX")).toBeNull();
  });

  it("recognises supported currencies", () => {
    expect(isSupportedCurrency("MAD")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("XXX")).toBe(false);
  });
});
