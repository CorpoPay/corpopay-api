import CryptoJS from 'crypto-js';

function getKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY environment variable is not set');
  if (key.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  return key;
}

/**
 * Encrypt a plain-text string using AES-256-CBC.
 * Returns a base64-encoded ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = CryptoJS.enc.Utf8.parse(getKey().slice(0, 32));
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  // Prepend IV so we can decrypt later
  const combined = iv.concat(encrypted.ciphertext);
  return CryptoJS.enc.Base64.stringify(combined);
}

/**
 * Decrypt a base64-encoded ciphertext produced by `encrypt()`.
 */
export function decrypt(ciphertext: string): string {
  const key = CryptoJS.enc.Utf8.parse(getKey().slice(0, 32));
  const combined = CryptoJS.enc.Base64.parse(ciphertext);

  // First 16 bytes are the IV
  const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
  const encryptedWords = CryptoJS.lib.WordArray.create(
    combined.words.slice(4),
    combined.sigBytes - 16,
  );

  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: encryptedWords,
  });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  return decrypted.toString(CryptoJS.enc.Utf8);
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
