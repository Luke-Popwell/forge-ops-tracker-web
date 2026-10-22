/**
 * Strict privacy (Configuration#strictPrivacy): for apps that can't let personal or health data
 * leave the browser. Only structured facts about an error are sent (its class, its stack frames,
 * release, environment, trace id), never free text that could carry a name, an email or a
 * diagnosis: no message, breadcrumbs, SQL statement, session replay, or user email/username, and
 * only the context/tag keys listed in Configuration#privacyAllowedFields. Ported from the server's
 * own app/services/strict_privacy.rb, which applies the same rules again on arrival;
 * sdks/strict_privacy_vectors.json pins the results both have to agree on.
 *
 * Errors still group without their message: message_fingerprint is a one-way hash of the message
 * with its numbers, ids, emails and quoted values taken out, computed here, in the page. Synchronously, so reporting an
 * error never waits on crypto.subtle's promise: the SHA-256 below is self-contained for that
 * reason, rather than a dependency.
 */

export const FINGERPRINT_LENGTH = 32;

// No lookbehind (older Safari can't even parse a regex that has one): a match's neighbours are
// checked by hand instead, against ASCII word characters only, the same in every SDK and on the
// server. Rejecting a match and moving past it gives the same result as a lookbehind would here,
// since no valid match can start inside a rejected one. Single quotes are the exception (a rejected
// 'a ' can hide a valid 'b' that starts at its closing quote), so they're scanned one opener at a time.
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// A quoted value (KeyError: 'Jane Doe') is data, not the shape of the error. Single quotes only open
// and close at a word boundary, so a contraction (Couldn't) or the `email' style never starts one.
const DOUBLE_QUOTED = /"[^"\r\n]*"/g;
const SINGLE_QUOTED = /'[^'\r\n]*'/g;
const HEX_OBJECT_ID = /0x[0-9a-fA-F]{4,}/g;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const NUMBER = /[0-9]+/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

// Span data that's structure, not content: the masked statement and which database it ran on.
const SPAN_DATA_KEYS = ["db.statement", "db.system"];
const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
// A route parameter segment: ":id", "{id}", "<int:id>", "[slug]" or "*path" ([^\n] rather than "."
// so the match is the server's exactly).
const ROUTE_PARAMETER = /^(?::[^\n]+|\{[^\n]+\}|<[^\n]+>|\[[^\n]+\]|\*[^\n]*)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PORT = /:[0-9]+$/;

export type AllowedValue = string | number | boolean;

function replaceStandalone(text: string, pattern: RegExp, replacement: string): string {
  return text.replace(pattern, (match: string, offset: number) => {
    const before = text.charAt(offset - 1);
    const after = text.charAt(offset + match.length);
    return (before !== "" && WORD_CHAR.test(before)) || (after !== "" && WORD_CHAR.test(after)) ? match : replacement;
  });
}

// Every standalone single-quoted run: a rejected candidate moves the search on by one character, not
// past the candidate, which is exactly what a lookbehind and lookahead would do.
function replaceSingleQuoted(text: string): string {
  const pattern = new RegExp(SINGLE_QUOTED.source, "g");
  let result = "";
  let copied = 0;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(text)) !== null) {
    const start = found.index;
    const end = start + found[0].length;
    const before = text.charAt(start - 1);
    const after = text.charAt(end);
    if ((before !== "" && WORD_CHAR.test(before)) || (after !== "" && WORD_CHAR.test(after))) {
      pattern.lastIndex = start + 1;
      continue;
    }
    result += text.slice(copied, start) + "<str>";
    copied = end;
  }
  return result + text.slice(copied);
}

/**
 * The message with emails, quoted values, hex object ids, UUIDs and standalone numbers replaced, in
 * that order.
 */
export function normalizeMessage(message: unknown): string {
  const quoted = String(message ?? "").replace(EMAIL, "<email>").replace(DOUBLE_QUOTED, "<str>");
  const withoutHex = replaceSingleQuoted(quoted).replace(HEX_OBJECT_ID, "0x");
  return replaceStandalone(replaceStandalone(withoutHex, UUID, "<uuid>"), NUMBER, "<n>");
}

/** First 32 hex characters of the SHA-256 of the normalized message's UTF-8 bytes. */
export function messageFingerprint(message: unknown): string {
  return sha256Hex(utf8Bytes(normalizeMessage(message))).slice(0, FINGERPRINT_LENGTH);
}

/**
 * "GET https://api.example.com/patients/42?x=1" or "GET api.example.com/patients/42" becomes
 * "GET api.example.com"; a method and a path ("GET /patients/42/notes") or a bare path
 * ("/patients/jane-doe") goes through strictPath: "GET /patients/:path", "/patients/:path", while a
 * route template ("GET /patients/:id") is kept. A name that isn't a call or a path
 * ("OrdersController#create", "patients#show") is kept. Also how a transaction name is reduced.
 */
export function spanName(name: string): string {
  if (name.startsWith("/")) {
    return strictPath(name);
  }
  const match = HTTP_METHOD.exec(name);
  if (!match) {
    return name;
  }
  const method = (match[1] ?? "").toUpperCase();
  const target = match[2] ?? "";
  if (target.startsWith("/")) {
    return `${method} ${strictPath(target)}`;
  }
  return `${method} ${hostOf(target) ?? strictPath(target)}`;
}

/**
 * A request or page path under strict privacy, with no query or fragment. A route template
 * ("/patients/:id/notes", "/patients/{id}", "users/<int:id>/", "/files/*path", "/posts/[slug]") is
 * kept as it is: its words are a developer's, and its parameters are already placeholders. A raw
 * path keeps only its first segment, and the rest becomes ":path": "/patients/jane-doe/12" is
 * "/patients/:path", since anything after the first segment could name a person and no rule can
 * tell a name from a word. A first segment that holds a digit or is over 40 characters is ":id".
 */
export function strictPath(path: string): string {
  const text = path.split(/[?#]/)[0] ?? "";
  if (text.split("/").some((segment) => ROUTE_PARAMETER.test(segment))) {
    return text;
  }
  const leading = text.startsWith("/") ? "/" : "";
  const segments = text.split("/").filter((segment) => segment !== "");
  const head = segments[0];
  if (head === undefined) {
    return "/";
  }
  const first = /[0-9]/.test(head) || Array.from(head).length > 40 ? ":id" : head;
  return `${leading}${first}${segments.length > 1 ? "/:path" : ""}`;
}

/**
 * A page's address for a web vitals measurement, read by hand: the scheme in lower case, the host
 * without credentials (up to the last "@") or port, then the path by strictPath's rule; without a
 * scheme, strictPath alone. "https://clinic.example.com/patients/jane-doe/chart?tab=2" is
 * "https://clinic.example.com/patients/:path".
 */
export function pageUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i.exec(url);
  if (!match) {
    return strictPath(url);
  }
  const host = (match[2] ?? "").replace(/^[^\n]*@/, "").replace(/:[0-9]+$/, "");
  return `${(match[1] ?? "").toLowerCase()}://${host}${strictPath(match[3] ?? "")}`;
}

// The host of an outbound call's address, read by hand rather than with a URL parser (one that
// rejects an odd address must never lead to the whole address being sent): whatever comes before
// the first "/", "?" or "#", without a scheme, port, or credentials (up to the last "@": a password
// can hold one, a host never does). It's a host when the address had a scheme or a port, or the
// name has a dot or is "localhost"; otherwise (a relative path) null.
function hostOf(target: string): string | null {
  const hadScheme = SCHEME.test(target);
  const authority = (target.replace(SCHEME, "").split(/[/?#]/)[0] ?? "").replace(/^.*@/, "");
  const hadPort = PORT.test(authority);
  const host = authority.replace(PORT, "");
  if (host === "") {
    return null;
  }
  return hadScheme || hadPort || host.includes(".") || host.toLowerCase() === "localhost" ? host : null;
}

/**
 * Only the `allowed` top-level keys of `fields`, and only plain string, number or boolean values;
 * undefined when nothing is left.
 */
export function allowedFields(fields: Record<string, unknown> | undefined, allowed: readonly string[]): Record<string, AllowedValue> | undefined {
  if (!fields || allowed.length === 0) {
    return undefined;
  }
  const kept: Record<string, AllowedValue> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      continue;
    }
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      kept[key] = value;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** The user as its id only (a string), never email or username; undefined when there's no id. */
export function userId(user: Record<string, unknown> | null | undefined): { id: string } | undefined {
  const id = user?.id;
  if (id === undefined || id === null || id === false || String(id).trim() === "") {
    return undefined;
  }
  return { id: String(id) };
}

/** A span's data reduced to the masked statement and the database system. */
export function spanData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of SPAN_DATA_KEYS) {
    if (data && data[key] !== undefined && data[key] !== null) {
      kept[key] = data[key];
    }
  }
  return kept;
}

// UTF-8, by hand rather than TextEncoder so it works the same everywhere this bundle runs; a lone
// surrogate becomes U+FFFD, as TextEncoder would.
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 (FIPS 180-4) of `bytes`, as 64 lowercase hex characters. */
export function sha256Hex(bytes: readonly number[]): string {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  // Padding: a 1 bit, zeros up to 56 bytes mod 64, then the message length in bits, big endian.
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) {
    padded.push(0);
  }
  const bitLength = bytes.length * 8;
  const high = Math.floor(bitLength / 0x100000000);
  padded.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  padded.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  const w = new Array<number>(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const at = chunk + i * 4;
      w[i] = (((padded[at] ?? 0) << 24) | ((padded[at + 1] ?? 0) << 16) | ((padded[at + 2] ?? 0) << 8) | (padded[at + 3] ?? 0)) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) {
      h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
    }
  }
  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
