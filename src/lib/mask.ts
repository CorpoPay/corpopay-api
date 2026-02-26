/**
 * Keys whose values should be masked in logs and stored payloads.
 * Case-insensitive matching.
 */
const SENSITIVE_PATTERNS = [
  /secret/i,
  /password/i,
  /passwd/i,
  /\bkey\b/i,
  /apikey/i,
  /api_key/i,
  /token/i,
  /authorization/i,
  /credential/i,
  /cvv/i,
  /pan\b/i,
  /cardnumber/i,
  /card_number/i,
  /pin\b/i,
  /private/i,
];

const MASK_VALUE = '***MASKED***';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively mask sensitive values in an object.
 * Returns a new object — the original is not mutated.
 */
export function maskObject(input: unknown, depth = 0): unknown {
  if (depth > 10) return input; // guard against circular structures
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => maskObject(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = MASK_VALUE;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = maskObject(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Mask a JSON string — parses, masks, re-serializes.
 */
export function maskJsonString(json: string): string {
  try {
    return JSON.stringify(maskObject(JSON.parse(json)));
  } catch {
    return json;
  }
}
