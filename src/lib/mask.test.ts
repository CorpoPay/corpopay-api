import { describe, expect, it } from "vitest";
import { maskObject } from "./mask";

const MASK = "***MASKED***";

describe("maskObject", () => {
  it("masks common sensitive keys", () => {
    const input = {
      secretKey: "sk",
      apiKey: "ak",
      api_key: "ak2",
      password: "pw",
      token: "tok",
      authorization: "bearer x",
      credential: "cred",
      cvv: "123",
      cardNumber: "4111111111111111",
      callerPassword: "cp",
      webhookSecret: "whsec",
      private: "priv",
    };
    const out = maskObject(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key]).toBe(MASK);
    }
  });

  it("recurses into nested objects", () => {
    const out = maskObject({ outer: { inner: { secret: "x" } } }) as {
      outer: { inner: { secret: string } };
    };
    expect(out.outer.inner.secret).toBe(MASK);
  });

  it("masks inside arrays", () => {
    const out = maskObject({ list: [{ token: "t1" }, { token: "t2" }] }) as {
      list: { token: string }[];
    };
    expect(out.list[0].token).toBe(MASK);
    expect(out.list[1].token).toBe(MASK);
  });

  it("leaves non-sensitive values untouched", () => {
    const input = { amount: 100, currency: "MAD", status: "SUCCEEDED" };
    expect(maskObject(input)).toEqual(input);
  });

  it("does not mutate the original object", () => {
    const input = { secret: "s", nested: { key: "k" } };
    maskObject(input);
    expect(input.secret).toBe("s");
    expect((input.nested as { key: string }).key).toBe("k");
  });

  it("passes through primitives and null", () => {
    expect(maskObject("string")).toBe("string");
    expect(maskObject(42)).toBe(42);
    expect(maskObject(null)).toBe(null);
    expect(maskObject(undefined)).toBe(undefined);
  });

  it("guards against deep recursion", () => {
    // A 20-level nesting should not throw despite the depth guard at 10.
    let obj: unknown = { secret: "x" };
    for (let i = 0; i < 20; i++) obj = { next: obj };
    expect(() => maskObject(obj)).not.toThrow();
  });
});
