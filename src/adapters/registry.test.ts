import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/encryption", () => ({
  decryptCredentials: vi.fn(() => ({})),
}));

import { Provider } from "@/generated/prisma/client";
import { FakeAdapter } from "./fake.adapter";
import { NapsAdapter } from "./naps.adapter";
import { getAdapter } from "./registry";
import { StripeAdapter } from "./stripe.adapter";
import { VpsAdapter } from "./vps.adapter";

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

beforeEach(() => {
  delete process.env.DEMO_MODE;
});

describe("getAdapter", () => {
  it("returns the deterministic FakeAdapter for ANY provider in DEMO_MODE", () => {
    process.env.DEMO_MODE = "true";
    expect(getAdapter(Provider.VPS, "anything")).toBeInstanceOf(FakeAdapter);
    expect(getAdapter(Provider.STRIPE, "anything")).toBeInstanceOf(FakeAdapter);
  });

  it("returns a NapsAdapter for NAPS", () => {
    expect(getAdapter(Provider.NAPS, "v2:{}")).toBeInstanceOf(NapsAdapter);
  });

  it("returns a VpsAdapter for VPS", () => {
    expect(getAdapter(Provider.VPS, "v2:{}")).toBeInstanceOf(VpsAdapter);
  });

  it("returns a StripeAdapter for STRIPE", () => {
    expect(getAdapter(Provider.STRIPE, "v2:{}")).toBeInstanceOf(StripeAdapter);
  });

  it.each([Provider.PAYPAL, Provider.ADYEN])("throws for unimplemented provider %s", (provider) => {
    expect(() => getAdapter(provider, "v2:{}")).toThrow("not yet implemented");
  });

  it("throws for an unknown provider", () => {
    expect(() => getAdapter("NOT_A_PROVIDER" as Provider, "v2:{}")).toThrow("Unsupported provider");
  });
});

afterAll(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});
