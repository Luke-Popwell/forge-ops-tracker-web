/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { REDACTED, scrub, scrubString } from "../src/piiScrubber.js";
// A byte-identical copy of sdks/pii_scrubbing_vectors.json, generated from the server's own
// app/services/pii_scrubber.rb: card numbers, IBANs and bank-detail keys, as sdks/PII_SCRUBBING.md
// describes them.
import vectorsJson from "./fixtures/pii_scrubbing_vectors.json?raw";

interface Vectors {
  strings: { input: string; scrubbed: string }[];
  keys: { key: string; redacted: boolean }[];
}

const vectors = JSON.parse(vectorsJson) as Vectors;

describe("piiScrubber vectors", () => {
  it.each(vectors.strings)("scrubs $input exactly as the server does", ({ input, scrubbed }) => {
    expect(scrub(input)).toBe(scrubbed);
  });

  it.each(vectors.keys)("redacts a value under $key exactly when the server does", ({ key, redacted }) => {
    const scrubbed = scrub({ [key]: "x" }) as { [key: string]: unknown };
    expect(scrubbed[key] === REDACTED).toBe(redacted);
  });
});

describe("piiScrubber", () => {
  it("redacts an email address embedded in free text", () => {
    expect(scrubString("undefined method 'name' for user@example.com")).toBe(
      "undefined method 'name' for [EMAIL FILTERED]",
    );
  });

  it("redacts a formatted credit card number but leaves an ordinary long numeric id alone", () => {
    expect(scrubString("card 4111-1111-1111-1111 declined")).toBe("card [CREDIT CARD FILTERED] declined");
    expect(scrubString("Couldn't find Invoice with id=8821445199")).toBe(
      "Couldn't find Invoice with id=8821445199",
    );
  });

  it("redacts a formatted SSN", () => {
    expect(scrubString("ssn on file: 123-45-6789")).toBe("ssn on file: [SSN FILTERED]");
  });

  it("redacts known API key and token formats", () => {
    expect(scrubString("using sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc")).toBe("using [STRIPE KEY FILTERED]");
    expect(scrubString("Authorization: Bearer abc123.def456")).toBe("Authorization: [BEARER TOKEN FILTERED]");
    expect(scrubString("key AKIAIOSFODNN7EXAMPLE in use")).toBe("key [AWS KEY FILTERED] in use");
    expect(scrubString("token ghp_1234567890abcdefghijklmnopqrstuv")).toBe("token [GITHUB TOKEN FILTERED]");
    expect(
      scrubString(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abcdefghijklmnop",
      ),
    ).toBe("jwt [JWT FILTERED]");
  });

  it("redacts the whole value under a sensitive-looking key regardless of type or casing", () => {
    const scrubbed = scrub({ password: "hunter2", "API-Key": "sk_live_abc", count: 3 });

    expect(scrubbed).toEqual({ password: "[FILTERED]", "API-Key": "[FILTERED]", count: 3 });
  });

  it("recurses into nested objects and arrays", () => {
    const scrubbed = scrub({ user: { email: "ada@example.com" }, notes: ["no PII here"] });

    expect(scrubbed).toEqual({ user: { email: "[EMAIL FILTERED]" }, notes: ["no PII here"] });
  });

  it("does not redact a key-based match for an unrelated short substring like 'pin'", () => {
    // SENSITIVE_KEYS deliberately excludes bare "pin": would otherwise false-positive on
    // "opinion" or "pinned_at". Confirms that exclusion actually holds in this port.
    const scrubbed = scrub({ opinion: "strong", pinned_at: "2026-01-01" });

    expect(scrubbed).toEqual({ opinion: "strong", pinned_at: "2026-01-01" });
  });
});
