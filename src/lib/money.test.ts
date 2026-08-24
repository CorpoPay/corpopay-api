import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";

import { centimes, centimesToMad, centimesToMadString, mad, madToCentimes } from "./money";

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
