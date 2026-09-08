import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";

import {
  centimes,
  centimesToMad,
  centimesToMadString,
  fromMinor,
  MINOR_UNIT_EXPONENTS,
  mad,
  madToCentimes,
  minorUnitExponent,
  SUPPORTED_CURRENCIES,
  toMinor,
  toMinorString,
} from "./money";

describe("centimes", () => {
  it("brands and rounds to a whole integer", () => {
    expect(centimes(1000)).toBe(1000);
    expect(centimes(1000.4)).toBe(1000);
    expect(centimes(999.6)).toBe(1000);
  });
});

describe("madToCentimes", () => {
  it("converts a MAD number to centimes", () => {
    expect(madToCentimes(10.5)).toBe(1050);
    expect(madToCentimes(0)).toBe(0);
  });

  it("converts a Prisma Decimal to centimes", () => {
    expect(madToCentimes(new Prisma.Decimal("10.50"))).toBe(1050);
    expect(madToCentimes(new Prisma.Decimal("1234.56"))).toBe(123456);
  });

  it("rounds to the nearest centime", () => {
    expect(madToCentimes(10.505)).toBe(1051);
    expect(madToCentimes(10.504)).toBe(1050);
  });
});

describe("centimesToMad", () => {
  it("converts centimes to a MAD number", () => {
    expect(centimesToMad(centimes(1050))).toBe(10.5);
    expect(centimesToMad(centimes(0))).toBe(0);
  });
});

describe("centimesToMadString", () => {
  it("formats centimes as a two-decimal MAD string", () => {
    expect(centimesToMadString(centimes(1050))).toBe("10.50");
    expect(centimesToMadString(centimes(100))).toBe("1.00");
  });
});

describe("mad", () => {
  it("brands a raw number as MAD", () => {
    expect(mad(10.5)).toBe(10.5);
  });
});

describe("currency surface", () => {
  it("lists the v1 currencies, all two-decimal minor units", () => {
    expect(SUPPORTED_CURRENCIES).toEqual(["MAD", "USD", "EUR", "GBP", "CAD"]);
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(MINOR_UNIT_EXPONENTS[currency]).toBe(2);
      expect(minorUnitExponent(currency)).toBe(2);
    }
  });

  it("toMinor converts major → minor for any supported currency", () => {
    expect(toMinor(10.5, "MAD")).toBe(1050);
    expect(toMinor(10.5, "USD")).toBe(1050);
    expect(toMinor(new Prisma.Decimal("1234.56"), "EUR")).toBe(123456);
    expect(toMinor("7.89", "GBP")).toBe(789);
  });

  it("fromMinor converts minor → major for any supported currency", () => {
    expect(fromMinor(centimes(1050), "MAD")).toBe(10.5);
    expect(fromMinor(centimes(1050), "USD")).toBe(10.5);
    expect(fromMinor(centimes(123456), "CAD")).toBe(1234.56);
  });

  it("toMinorString formats to the currency's minor-unit precision", () => {
    expect(toMinorString(centimes(1050), "MAD")).toBe("10.50");
    expect(toMinorString(centimes(100), "USD")).toBe("1.00");
    expect(toMinorString(centimes(123456), "EUR")).toBe("1234.56");
  });

  it("MAD aliases delegate to the generic helpers", () => {
    expect(madToCentimes(10.5)).toBe(toMinor(10.5, "MAD"));
    expect(centimesToMad(centimes(1050))).toBe(fromMinor(centimes(1050), "MAD"));
    expect(centimesToMadString(centimes(1050))).toBe(toMinorString(centimes(1050), "MAD"));
  });
});
