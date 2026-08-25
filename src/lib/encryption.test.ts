import CryptoJS from "crypto-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, decryptCredentials, encrypt, encryptCredentials } from "./encryption";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.ENCRYPTION_KEY_V1;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  delete process.env.ENCRYPTION_KEY_V1;
});

describe("encrypt / decrypt (AES-256-GCM)", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "storedPaymentProfileId-abc123";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips a JSON string", () => {
    const json = JSON.stringify({ notificationKey: "k", callerPassword: "p" });
    expect(decrypt(encrypt(json))).toBe(json);
  });

  it("prefixes ciphertext with 'v2:'", () => {
    expect(encrypt("hello").startsWith("v2:")).toBe(true);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("throws on tampered ciphertext (auth tag mismatch)", () => {
    const ciphertext = encrypt("sensitive");
    const tampered = ciphertext.slice(0, -4) + "XXXX";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY environment variable is not set");
  });

  it("throws when ENCRYPTION_KEY is not 64 hex chars", () => {
    process.env.ENCRYPTION_KEY = "too-short";
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY must be exactly 64 hex characters");
  });
});

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips an object", () => {
    const creds = { merchantAccount: "Int_demo_Test", callerPassword: "secret" };
    expect(decryptCredentials(encryptCredentials(creds))).toEqual(creds);
  });

  it("returns a typed object", () => {
    const creds = encryptCredentials({ notificationKey: "k" });
    const out = decryptCredentials<{ notificationKey: string }>(creds);
    expect(out.notificationKey).toBe("k");
  });
});

describe("decrypt — legacy crypto-js CBC fallback", () => {
  it("decrypts a legacy CBC row when ENCRYPTION_KEY_V1 is set", () => {
    const legacyKey = "legacy-key-0123456789abcdefghijkl"; // 32 chars
    process.env.ENCRYPTION_KEY_V1 = legacyKey;

    // Recreate the exact legacy wire format: base64( iv(16) || ciphertext )
    const key = CryptoJS.enc.Utf8.parse(legacyKey.slice(0, 32));
    const iv = CryptoJS.enc.Hex.parse("000102030405060708090a0b0c0d0e0f");
    const encrypted = CryptoJS.AES.encrypt("legacy-plaintext", key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const combined = CryptoJS.enc.Base64.stringify(iv.concat(encrypted.ciphertext));

    expect(decrypt(combined)).toBe("legacy-plaintext");
  });

  it("throws when a legacy row is present but no legacy key is configured", () => {
    delete process.env.ENCRYPTION_KEY_V1;
    delete process.env.ENCRYPTION_KEY;
    // Any non-v2: ciphertext routes to the legacy path, which needs a key.
    expect(() => decrypt("bm90LXYyLWNpcGhlcnRleHQ=")).toThrow("ENCRYPTION_KEY_V1");
  });
});
