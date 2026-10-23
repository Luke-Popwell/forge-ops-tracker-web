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
  "iban", "accountnumber", "routingnumber", "bankaccount",
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

// Card numbers in any other shape, and IBANs: see sdks/PII_SCRUBBING.md, which every SDK follows,
// and sdks/pii_scrubbing_vectors.json (a copy is in test/fixtures), which pins the results. No
// lookbehind (older Safari can't even parse a regex that has one): the digit runs card numbers are
// looked for in are scanned by hand instead, against ASCII word characters only.
const CARD_PREFIXES = /^(?:4|5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)|3[47]|6011|64[4-9]|65|35(?:2[89]|[3-8]\d)|36|30[0-5]|62)/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/g;
const WORD_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

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
  // IBANs first: a spaced IBAN's middle groups look like a formatted card number.
  let result = text.replace(IBAN, (candidate: string) => (isIban(candidate) ? "[IBAN FILTERED]" : candidate));
  for (const [label, pattern] of PATTERNS) {
    result = result.replace(pattern, `[${label} FILTERED]`);
  }
  return scrubDigitRuns(result);
}

// Finds digit runs the way a backtracking engine finds
// /(?<![A-Za-z0-9_])\d(?:[ -]?\d)*(?![A-Za-z0-9_])/g: a run starts only at a digit not preceded by
// a word character, extends as far as it can, then gives up whole trailing groups while the
// character after it is a word character. With no group left there's no run at this start, and the
// scan moves on one character.
function scrubDigitRuns(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const end = DIGIT.test(text.charAt(i)) && !isWordChar(text.charAt(i - 1)) ? digitRunEnd(text, i) : -1;
    if (end === -1) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    out += scrubCardNumbersIn(text.slice(i, end));
    i = end;
  }
  return out;
}

// Where the run starting at the digit at `start` ends, or -1 when no run starts there.
function digitRunEnd(text: string, start: number): number {
  let end = start + 1;
  for (;;) {
    if (DIGIT.test(text.charAt(end))) {
      end += 1;
    } else if ((text.charAt(end) === " " || text.charAt(end) === "-") && DIGIT.test(text.charAt(end + 1))) {
      end += 2;
    } else {
      break;
    }
  }
  while (isWordChar(text.charAt(end))) {
    const run = text.slice(start, end);
    const lastSeparator = Math.max(run.lastIndexOf(" "), run.lastIndexOf("-"));
    if (lastSeparator === -1) {
      return -1;
    }
    end = start + lastSeparator;
  }
  return end;
}

function isWordChar(char: string): boolean {
  return char !== "" && WORD_CHAR.test(char);
}

// From each group of the run on, the longest stretch of whole groups that is a card number is
// replaced, so a card followed by its CVV, two cards in a row, and Amex's 4-6-5 are all found.
function scrubCardNumbersIn(run: string): string {
  const parts = run.split(/([ -])/);
  const digits = parts.filter((_, index) => index % 2 === 0);
  const separators = parts.filter((_, index) => index % 2 === 1);
  let out = "";
  let i = 0;
  while (i < digits.length) {
    let j = digits.length - 1;
    while (j >= i && !isCardNumber(digits.slice(i, j + 1).join(""))) {
      j -= 1;
    }
    if (j >= i) {
      out += "[CREDIT CARD FILTERED]" + (separators[j] ?? "");
      i = j + 1;
    } else {
      out += (digits[i] ?? "") + (separators[i] ?? "");
      i += 1;
    }
  }
  return out;
}

function isCardNumber(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && CARD_PREFIXES.test(digits) && luhn(digits);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let value = Number(digits.charAt(digits.length - 1 - index));
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
  }
  return sum % 10 === 0;
}

// The IBAN check, a digit at a time: the first four characters moved to the end, letters as two
// digits (A is 10), and the remainder by 97 is 1.
function isIban(candidate: string): boolean {
  const compact = candidate.split(" ").join("");
  if (compact.length < 15 || compact.length > 34) {
    return false;
  }
  let remainder = 0;
  for (const char of compact.slice(4) + compact.slice(0, 4)) {
    const asDigits = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of asDigits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
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
