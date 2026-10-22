import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";
import { Trace, TracePayload } from "../src/tracing.js";

const originalFetch = globalThis.fetch;

interface Delivered {
  url: string;
  body: TracePayload;
}

// Records every delivery to a ForgeOps endpoint; any other request (the "application's own" fetches
// below) just answers with the status the URL asks for via a /status/NNN suffix.
function stubFetch(): Delivered[] {
  const calls: Delivered[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://tracker.example.com/")) {
      calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: Number(/status\/(\d+)/.exec(String(url))?.[1] ?? 200) });
  });
  return calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configure(overrides: Record<string, unknown> = {}): void {
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    environment: "production",
    release: "a1b2c3d",
    enabledEnvironments: new Set(["production"]),
    installGlobalHandlers: false,
    breadcrumbs: false,
    webVitals: false,
    trackPerformance: false,
    traceCaptureThresholdMs: 10,
    ...overrides,
  });
}

function span(payload: TracePayload, name: string) {
  return payload.spans.find((s) => s.name === name)!;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  forgeOpsTracker._resetForTesting();
  globalThis.fetch = originalFetch;
});

describe("distributed tracing", () => {
  it("delivers a slow trace to /spans with nested spans and the wire shape", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("checkout", async (t) => {
      await t.span(
        "fetch feed",
        async (scope) => {
          scope.recordSpan("SELECT feed", { kind: "database", startedAt: 1_700_000_000_123, durationMs: 3 });
          await sleep(30);
        },
        { kind: "http", data: { status: 200 } },
      );
      t.recordSpan("sibling", { startedAt: new Date(), durationMs: 1 });
    });
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://tracker.example.com/api/v1/spans");
    const payload = calls[0]!.body;
    expect(payload.trace_id).toMatch(/^[0-9a-f]{32}$/);
    const root = span(payload, "checkout");
    const fetchSpan = span(payload, "fetch feed");
    expect(root.parent_span_id).toBeNull();
    expect(root.kind).toBe("controller");
    expect(root.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(fetchSpan.parent_span_id).toBe(root.span_id);
    expect(span(payload, "SELECT feed").parent_span_id).toBe(fetchSpan.span_id);
    expect(span(payload, "sibling").parent_span_id).toBe(root.span_id);
    expect(span(payload, "SELECT feed").started_at).toBe("2023-11-14T22:13:20.123Z");
    expect(fetchSpan.environment).toBe("production");
    expect(fetchSpan.release).toBe("a1b2c3d");
    expect(fetchSpan.data).toEqual({ status: 200 });
  });

  it("nests correctly across awaits and for children started in parallel", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("outer", async (outer) => {
        await Promise.all([outer.span("a", () => sleep(20)), outer.span("b", () => sleep(5))]);
      });
      await t.span("after", () => sleep(5));
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "a").parent_span_id).toBe(span(payload, "outer").span_id);
    expect(span(payload, "b").parent_span_id).toBe(span(payload, "outer").span_id);
    expect(span(payload, "after").parent_span_id).toBe(span(payload, "t").span_id);
  });

  it("sends an unknown kind as other, since the server would reject the whole trace", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("q", { kind: "db", startedAt: Date.now(), durationMs: 1 });
      t.recordSpan("r", { kind: "database", startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    expect(span(calls[0]!.body, "q").kind).toBe("other");
    expect(span(calls[0]!.body, "r").kind).toBe("database");
  });

  it("sends a database span's statement masked as db.statement, with db.system", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("Load orders", async () => sleep(30), {
        kind: "database",
        statement: "SELECT * FROM orders WHERE email = 'a@b.co' AND total > 4200",
        dbSystem: "SQLite",
        data: { rows: 3 },
      });
      t.recordSpan("Count", {
        kind: "database",
        startedAt: Date.now(),
        durationMs: 1,
        data: { "db.statement": "SELECT count(*) FROM carts WHERE token = 'secret-token'" },
      });
      t.recordSpan("Not db", { kind: "service", statement: "SELECT 'x'", startedAt: Date.now(), durationMs: 1 });
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "Load orders").data).toEqual({
      rows: 3,
      "db.statement": "SELECT * FROM orders WHERE email = ? AND total > ?",
      "db.system": "sqlite",
    });
    expect(span(payload, "Count").data).toEqual({ "db.statement": "SELECT count(*) FROM carts WHERE token = ?" });
    expect(span(payload, "Not db").data).toEqual({});
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("a@b.co");
    expect(wire).not.toContain("secret-token");
  });

  it("masks \"double quoted\" values on a MySQL or MariaDB database span only", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("MySQL", { kind: "database", statement: 'SELECT id FROM t WHERE token = "abc123secret"', dbSystem: "MySQL", startedAt: Date.now(), durationMs: 1 });
      t.recordSpan("MariaDB", {
        kind: "database",
        data: { "db.system": "mariadb", "db.statement": 'SELECT id FROM t WHERE name = "jane"' },
        startedAt: Date.now(),
        durationMs: 1,
      });
      t.recordSpan("Postgres", { kind: "database", statement: 'SELECT "user id" FROM t', dbSystem: "postgresql", startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "MySQL").data).toEqual({ "db.statement": "SELECT id FROM t WHERE token = ?", "db.system": "mysql" });
    expect(span(payload, "MariaDB").data).toEqual({ "db.statement": "SELECT id FROM t WHERE name = ?", "db.system": "mariadb" });
    expect(span(payload, "Postgres").data).toEqual({ "db.statement": 'SELECT "user id" FROM t', "db.system": "postgresql" });
  });

  it("truncates a long database statement to 4000 characters", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("big", { kind: "database", statement: `SELECT ${"a, ".repeat(3000)}b FROM t`, startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const statement = span(calls[0]!.body, "big").data["db.statement"] as string;
    expect(statement.length).toBe(4003);
    expect(statement.endsWith("...")).toBe(true);
  });

  it("records a span and sends the trace even when the callback throws or rejects, rethrowing unchanged", async () => {
    const calls = stubFetch();
    configure();

    const failure = new Error("boom");
    await expect(
      forgeOpsTracker.trace("t", (t) =>
        t.span("bad", async () => {
          await sleep(30);
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    await forgeOpsTracker.flushSpans();
    expect(span(calls[0]!.body, "bad")).toBeDefined();

    expect(() =>
      forgeOpsTracker.trace("sync", (t) => {
        t.span("bad sync", () => {
          throw failure;
        });
      }),
    ).toThrow(failure);
  });

  it("returns the callback's value, synchronous or not", async () => {
    stubFetch();
    configure();
    expect(forgeOpsTracker.trace("t", (t) => t.span("s", () => 7))).toBe(7);
    expect(await forgeOpsTracker.trace("t", async (t) => t.span("s", async () => 8))).toBe(8);
  });

  it("sends nothing for a fast trace", async () => {
    const calls = stubFetch();
    configure({ traceCaptureThresholdMs: 60_000 });

    forgeOpsTracker.trace("fast", (t) => t.recordSpan("q", { kind: "database", startedAt: Date.now(), durationMs: 1 }));
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(0);
  });

  it("returns a disabled trace when tracing is off or reporting is not enabled, and still runs the callback", async () => {
    const calls = stubFetch();
    configure({ trackTracing: false });
    let ran = false;
    await forgeOpsTracker.trace("x", async (t) => {
      expect(t.enabled).toBe(false);
      ran = await t.span("y", async () => {
        await sleep(30);
        return true;
      });
      t.recordSpan("z", { startedAt: Date.now(), durationMs: 1 });
    });
    expect(ran).toBe(true);

    forgeOpsTracker._resetForTesting();
    configure({ environment: "development" });
    expect(forgeOpsTracker.startTrace("x").enabled).toBe(false);
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(0);
  });

  it("finish is idempotent and spans after it are dropped", async () => {
    const calls = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    await sleep(30);
    t.finish();
    t.finish();
    t.recordSpan("late", { startedAt: Date.now(), durationMs: 1 });
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.spans.map((s) => s.name)).toEqual(["t"]);
  });

  it("records a network request made while exactly one trace is open as an http span named METHOD host, never the path or query", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async () => {
      await fetch("https://api.example.com/users/42/status/404?token=secret");
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const http = calls[0]!.body.spans.find((s) => s.kind === "http")!;
    expect(http.name).toBe("GET api.example.com");
    expect(http.data).toEqual({ status: 404 });
    expect(http.parent_span_id).toBe(span(calls[0]!.body, "t").span_id);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("secret");
  });

  it("leaves a network request out when two traces are open, and never records this client's own requests", async () => {
    const calls = stubFetch();
    configure();

    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    await fetch("https://api.example.com/ambiguous");
    b.finish();
    await fetch("https://tracker.example.com/api/v1/spans", { method: "POST", body: "{}" });
    await fetch("https://api.example.com/only-a");
    await sleep(30);
    a.finish();
    await forgeOpsTracker.flushSpans();

    // The hand-made POST above is not a trace delivery (no spans): only real trace payloads count.
    const spans = calls.filter((c) => c.body.spans).flatMap((c) => c.body.spans);
    const names = spans.map((s) => s.name);
    expect(names).toContain("GET api.example.com");
    expect(spans.filter((s) => s.kind === "http")).toHaveLength(1);
    expect(names).not.toContain("POST tracker.example.com");
  });

  it("holds at most 500 spans including the root", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    config.traceCaptureThresholdMs = 0;
    let delivered: TracePayload | undefined;
    const t = new Trace("root", config, (payload) => {
      delivered = payload;
    });
    for (let i = 0; i < 700; i++) {
      t.recordSpan("q", { kind: "database", startedAt: Date.now(), durationMs: 1 });
    }
    t.finish();

    expect(delivered!.spans).toHaveLength(500);
  });

  it("spansUri swaps the trailing events segment", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    expect(config.spansUri()).toBe("https://tracker.example.com/api/v1/spans");
  });
});
