/**
 * Redacts likely-sensitive content out of a payload before it ever leaves the browser: the same
 * patterns ForgeOps itself applies again on arrival (defense in depth: this layer keeps the data
 * off the wire and out of any request logging in between; the server-side layer is what actually
 * protects the database). Ported from app/services/pii_scrubber.rb: same key list, same 8
 * patterns, same "[LABEL FILTERED]" replacement format, same REDACTED constant. Deliberately does
 * NOT support Project#additional_sensitive_keys: confirmed server-side only, see that file's own
 * header comment for why (ReDoS risk in extending the pattern list to arbitrary customer regexes).
 *
 * Can be turned off via Configuration#scrubPii = false. Off by default is not an option: the safe
 * default has to be "on."
 */

export const REDACTED = "[FILTERED]";

const SENSITIVE_KEYS = new Set([
  "password", "passwd", "pwd",
  "secret", "apisecret", "clientsecret", "secretkey",
  "token", "accesstoken", "refreshtoken", "apikey", "apitoken", "authorization", "authtoken", "bearer",
  "sessiontoken", "csrftoken",
  "creditcard", "cardnumber", "cardnum", "cvv", "cvv2", "cvc",
  "ssn", "socialsecuritynumber", "socialsecurity",
  "privatekey",
]);

const PATTERNS: Array<[string, RegExp]> = [
  ["EMAIL", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
  ["SSN", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["CREDIT CARD", /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g],
  ["BEARER TOKEN", /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi],
  ["JWT", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["AWS KEY", /\bAKIA[0-9A-Z]{16}\b/g],
  ["STRIPE KEY", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g],
  ["GITHUB TOKEN", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
];

export type Scrubbable = string | number | boolean | null | undefined | Scrubbable[] | { [key: string]: Scrubbable };

export function scrub(value: Scrubbable, key: string | null = null): Scrubbable {
  if (isSensitiveKey(key) && value !== null && value !== undefined) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, key));
  }

  if (value !== null && typeof value === "object") {
    const scrubbed: { [key: string]: Scrubbable } = {};
    for (const [k, v] of Object.entries(value)) {
      scrubbed[k] = scrub(v, k);
    }
    return scrubbed;
  }

  if (typeof value === "string") {
    return scrubString(value);
  }

  return value;
}

export function scrubString(text: string): string {
  let result = text;
  for (const [label, pattern] of PATTERNS) {
    result = result.replace(pattern, `[${label} FILTERED]`);
  }
  return result;
}

function isSensitiveKey(key: string | null): boolean {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalized.includes(sensitive)) {
      return true;
    }
  }
  return false;
}
