/**
 * AES-256-GCM authenticated encryption using Node.js built-in `crypto`.
 *
 * Key requirements:
 *   ENCRYPTION_KEY   — 64-char hex string (32 bytes). Used by the current encrypt/decrypt.
 *   ENCRYPTION_KEY_V1 — optional. If set, decryptLegacy() will try the old crypto-js CBC
 *                       format so existing DB rows can be read until re-encrypted.
 *
 * Why GCM instead of the old CBC:
 *   - GCM provides an authentication tag: decryption throws loudly if the ciphertext
 *     was tampered with or the wrong key is used (no more silent empty-string returns).
 *   - Key is derived from hex, giving exactly 32 bytes regardless of input encoding.
 *   - Uses Node's audited, hardware-accelerated crypto instead of crypto-js.
 *
 * Wire format (base64 of): IV(12) || authTag(16) || ciphertext
 */
import crypto from "crypto";
import CryptoJS from "crypto-js"; // kept only for legacy decryption of existing DB rows

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const FORMAT_V2_PREFIX = "v2:";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY environment variable is not set");
  if (raw.length !== 64)
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  return Buffer.from(raw, "hex");
}

function getLegacyKey(): string | null {
  // V1 key may be a plain UTF-8 string (the old crypto-js format used .slice(0, 32) chars)
  return process.env.ENCRYPTION_KEY_V1 ?? process.env.ENCRYPTION_KEY ?? null;
}

/**
 * Encrypt a plain-text string using AES-256-GCM.
 * Returns a 'v2:'-prefixed base64 string so we can distinguish from old CBC ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Layout: IV(12) + authTag(16) + ciphertext
  const combined = Buffer.concat([iv, tag, encrypted]);
  return FORMAT_V2_PREFIX + combined.toString("base64");
}

/**
 * Decrypt a ciphertext produced by `encrypt()`.
 * Also transparently handles legacy crypto-js CBC rows (no 'v2:' prefix).
 * Throws if the GCM auth tag verification fails (tamper detection).
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(FORMAT_V2_PREFIX)) {
    // ── New AES-256-GCM path ──────────────────────────────────────────────────
    const key = getKey();
    const buf = Buffer.from(ciphertext.slice(FORMAT_V2_PREFIX.length), "base64");
    const iv = buf.subarray(0, GCM_IV_BYTES);
    const tag = buf.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
    const enc = buf.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    // If key or ciphertext was tampered, createDecipheriv.final() throws — intentional.
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }

  // ── Legacy AES-256-CBC path (crypto-js rows) — read-only ────────────────────
  const legacyRaw = getLegacyKey();
  if (!legacyRaw)
    throw new Error(
      "ENCRYPTION_KEY_V1 required to decrypt legacy credentials. Set it and re-run the migration.",
    );
  const key = CryptoJS.enc.Utf8.parse(legacyRaw.slice(0, 32));
  const combined = CryptoJS.enc.Base64.parse(ciphertext);
  const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
  const encWords = CryptoJS.lib.WordArray.create(combined.words.slice(4), combined.sigBytes - 16);
  const params = CryptoJS.lib.CipherParams.create({ ciphertext: encWords });
  const result = CryptoJS.AES.decrypt(params, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const plain = result.toString(CryptoJS.enc.Utf8);
  if (!plain) throw new Error("Legacy decryption failed: wrong key or corrupted ciphertext");
  return plain;
}

/**
 * Encrypt a credentials object (any JSON-serializable value).
 */
export function encryptCredentials(credentials: Record<string, unknown>): string {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypt credentials back to the original object.
 */
export function decryptCredentials<T = Record<string, unknown>>(encrypted: string): T {
  return JSON.parse(decrypt(encrypted)) as T;
}
