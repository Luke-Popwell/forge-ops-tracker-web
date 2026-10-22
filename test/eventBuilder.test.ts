import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";

// Only cwd() is used, under Vitest's Node runtime: a one-line declaration instead of pulling in @types/node for a browser package.
declare const process: { cwd(): string };

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.environment = "production";
  config.release = "abc123";
  config.serverName = null;
  return config;
}

function raiseAndCapture(): Error {
  try {
    throw new TypeError("boom");
  } catch (e) {
    return e as Error;
  }
}

describe("EventBuilder", () => {
  it("builds a payload with the exception class, message, and configured metadata", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();

    const payload = builder.build(error, { url: "https://example.com" });

    expect(payload.exception_class).toBe("TypeError");
    expect(payload.message).toBe("boom");
    expect(payload.environment).toBe("production");
    expect(payload.release).toBe("abc123");
    expect(payload.context).toEqual({ url: "https://example.com" });
    expect(payload.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(payload.sdk_name).toBe("typescript");
  });

  it("parses real stack frames with file, line, and method", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();

    const frames = builder.build(error).backtrace;

    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]!.method).toBe("raiseAndCapture");
    expect(typeof frames[0]!.line).toBe("number");
  });

  it("marks a frame under appOrigin as in_app", () => {
    const config = newConfiguration();
    // Confirmed directly (by printing a real captured stack trace under this exact test runner,
    // not assumed): Vitest's own module transform loads a test file such that V8 reports its
    // frames as a bare absolute filesystem path with no scheme at all: neither file:// (what
    // plain Node ESM produces) nor the http://localhost:3000 origin jsdom otherwise reports for
    // import.meta.url here. That's purely a Vitest/vite-node loading quirk with no real-browser
    // equivalent (a real browser always reports https:// URLs matching window.location.origin,
    // which is exactly what isInApp() compares against in production); process.cwd() is the
    // reliable way to reconstruct that bare path in this specific test environment.
    config.appOrigin = `${process.cwd()}/test/`;
    const error = raiseAndCapture();

    const frames = new EventBuilder(config).build(error).backtrace;

    expect(frames.some((f) => f.in_app)).toBe(true);
  });

  it("marks every frame as not in_app when appOrigin does not match", () => {
    const config = newConfiguration();
    config.appOrigin = "/definitely/not/here";
    const error = raiseAndCapture();

    const frames = new EventBuilder(config).build(error).backtrace;

    expect(frames.every((f) => !f.in_app)).toBe(true);
  });

  it("marks every frame as not in_app when appOrigin is null", () => {
    const config = newConfiguration();
    config.appOrigin = null;
    const error = raiseAndCapture();

    const frames = new EventBuilder(config).build(error).backtrace;

    expect(frames.every((f) => !f.in_app)).toBe(true);
  });

  it("captures the backtrace at construction time, even before being thrown", () => {
    // Same as V8 in Node (see sdks/node/test/eventBuilder.test.js): the stack is captured at
    // `new Error(...)`, not at `throw`, so a constructed-but-never-thrown error still has frames.
    const builder = new EventBuilder(newConfiguration());
    const error = new TypeError("boom");

    const frames = builder.build(error).backtrace;

    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it("scrubs likely PII out of the message and context by default", () => {
    const builder = new EventBuilder(newConfiguration());
    let payload;
    try {
      throw new Error("failed for user@example.com");
    } catch (error) {
      payload = builder.build(error as Error, { user: { email: "ada@example.com", password: "hunter2" } });
    }

    expect(payload.message).toBe("failed for [EMAIL FILTERED]");
    expect(payload.context).toEqual({ user: { email: "[EMAIL FILTERED]", password: "[FILTERED]" } });
  });

  it("defaults to an empty breadcrumb list, and includes whatever's passed in", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();

    expect(builder.build(error).breadcrumbs).toEqual([]);

    const breadcrumbs = [{ category: "console", message: "starting up", level: "info" as const, timestamp: "2026-01-01T00:00:00Z" }];
    expect(builder.build(error, {}, breadcrumbs).breadcrumbs).toEqual(breadcrumbs);
  });

  it("scrubs likely PII out of a breadcrumb's message and data, leaving category/level/timestamp alone", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();
    const breadcrumbs = [
      {
        category: "fetch",
        message: "GET https://api.example.com/users?email=user@example.com",
        level: "info" as const,
        timestamp: "2026-01-01T00:00:00Z",
        data: { token: "sk_live_abcdefghijklmnop" },
      },
    ];

    const payload = builder.build(error, {}, breadcrumbs);

    expect(payload.breadcrumbs[0]!.message).toBe("GET https://api.example.com/users?email=[EMAIL FILTERED]");
    // "token" is itself a sensitive key name (see piiScrubber.ts's SENSITIVE_KEYS), so this is
    // redacted outright rather than pattern-matched against its actual value.
    expect(payload.breadcrumbs[0]!.data).toEqual({ token: "[FILTERED]" });
    expect(payload.breadcrumbs[0]!.category).toBe("fetch");
    expect(payload.breadcrumbs[0]!.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("leaves the payload untouched when scrubPii is disabled", () => {
    const config = newConfiguration();
    config.scrubPii = false;
    const builder = new EventBuilder(config);
    let payload;
    try {
      throw new Error("failed for user@example.com");
    } catch (error) {
      payload = builder.build(error as Error, { email: "ada@example.com" });
    }

    expect(payload.message).toBe("failed for user@example.com");
    expect(payload.context).toEqual({ email: "ada@example.com" });
  });

  it("includes the user when given one, never scrubbed even though it's an email", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();

    const payload = builder.build(error, {}, [], null, { id: 42, email: "ada@example.com" });

    expect(payload.user).toEqual({ id: 42, email: "ada@example.com" });
  });

  it("omits the user key entirely when none was given", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = raiseAndCapture();

    const payload = builder.build(error);

    expect(payload.user).toBeUndefined();
  });
});

describe("trace_id", () => {
  it("is included at the top level when given, never scrubbed, and omitted entirely otherwise", () => {
    const config = new Configuration();
    config.scrubPii = true;
    const builder = new EventBuilder(config);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    expect(builder.build(new Error("boom"), {}, [], null, null, traceId).trace_id).toBe(traceId);
    expect(builder.build(new Error("boom"))).not.toHaveProperty("trace_id");
  });
});
