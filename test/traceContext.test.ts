import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";
import { Trace, TracePayload } from "../src/tracing.js";

// W3C trace context from a browser trace to the backend it calls: the traceparent header on
// fetch/XMLHttpRequest requests made inside a trace, the explicit t.fetch()/t.httpSpan(), and
// trace_id on errors captured while a trace is open.

const originalFetch = globalThis.fetch;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

// Records every fetch, this client's own deliveries to ForgeOps included, with the headers it
// actually carried.
function stubFetch(status = 200): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ url: request ? request.url : String(input), headers, body });
    return new Response(null, { status: String(input).startsWith("https://tracker.example.com/") ? 202 : status });
  }) as typeof fetch;
  return sent;
}

// jsdom's XMLHttpRequest can't report back which headers were set, and its send() really tries to
// reach the host. Both are replaced before the SDK wraps them, so a request's headers are recorded
// here and "loadend" is dispatched by the test itself.
const xhrHeaders = new WeakMap<XMLHttpRequest, Record<string, string>>();
function stubXhr(): void {
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(function (this: XMLHttpRequest, name: string, value: string) {
    xhrHeaders.set(this, { ...(xhrHeaders.get(this) ?? {}), [name.toLowerCase()]: value });
  });
}

function xhr(method: string, url: string, headers: Record<string, string> = {}): { request: XMLHttpRequest; headers: Record<string, string> } {
  const request = new XMLHttpRequest();
  request.open(method, url);
  for (const [name, value] of Object.entries(headers)) {
    request.setRequestHeader(name, value);
  }
  request.send();
  return { request, headers: xhrHeaders.get(request) ?? {} };
}

function finishXhr(request: XMLHttpRequest, status: number): void {
  Object.defineProperty(request, "status", { value: status });
  request.dispatchEvent(new Event("loadend"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configure(overrides: Record<string, unknown> = {}): void {
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    environment: "production",
    enabledEnvironments: new Set(["production"]),
    installGlobalHandlers: false,
    breadcrumbs: false,
    webVitals: false,
    trackPerformance: false,
    traceCaptureThresholdMs: 0,
    // The API host these tests call is cross-origin to jsdom's page, so it has to be listed; the
    // same-origin-only default has its own tests below.
    tracePropagationTargets: ["api.example.com"],
    ...overrides,
  });
}

function traces(sent: SentRequest[]): TracePayload[] {
  return sent.filter((r) => r.url.endsWith("/spans")).map((r) => r.body as TracePayload);
}

function httpSpans(payload: TracePayload) {
  return payload.spans.filter((s) => s.kind === "http");
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
  stubXhr();
});

afterEach(() => {
  forgeOpsTracker._resetForTesting();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("trace propagation (W3C trace context)", () => {
  it("uses W3C ids: a 32 hex trace id and 16 hex span ids, never all zeros", () => {
    stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    expect(t.traceId).toMatch(/^(?!0+$)[0-9a-f]{32}$/);
    const [, , spanId] = TRACEPARENT.exec(t.httpSpan("GET", "https://api.example.com/").headers.traceparent!)!;
    expect(spanId).not.toMatch(/^0+$/);
    t.finish();
  });

  it("adds traceparent to a fetch made inside a trace, naming the recorded http span as its parent", async () => {
    const sent = stubFetch(201);
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    await fetch("https://api.example.com/orders?coupon=secret", { method: "POST", headers: { "Content-Type": "application/json" } });
    t.finish();
    await forgeOpsTracker.flushSpans();

    const call = sent.find((r) => r.url.startsWith("https://api.example.com/"))!;
    expect(call.headers["content-type"]).toBe("application/json");
    const [, traceId, parentId] = TRACEPARENT.exec(call.headers.traceparent!)!;
    const payload = traces(sent)[0]!;
    expect(traceId).toBe(t.traceId);
    expect(payload.trace_id).toBe(t.traceId);
    const [http] = httpSpans(payload);
    expect(http).toMatchObject({ span_id: parentId, name: "POST api.example.com", data: { status: 201 } });
    expect(http!.parent_span_id).toBe(payload.spans.find((s) => s.name === "Checkout")!.span_id);
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("carries a Request's own headers over when adding the header to it", async () => {
    const sent = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    await fetch(new Request("https://api.example.com/orders", { headers: { Authorization: "Bearer abc" } }));
    t.finish();

    const call = sent.find((r) => r.url.startsWith("https://api.example.com/"))!;
    expect(call.headers.authorization).toBe("Bearer abc");
    expect(call.headers.traceparent).toMatch(TRACEPARENT);
  });

  it("resolves a relative URL against the page, so same-origin calls get the header and a named span", async () => {
    const sent = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    await fetch("/api/orders");
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent.find((r) => r.url === "/api/orders")!.headers.traceparent).toMatch(TRACEPARENT);
    expect(httpSpans(traces(sent)[0]!)[0]!.name).toBe(`GET ${window.location.host}`);
  });

  it("adds traceparent to an XMLHttpRequest made inside a trace, and records it under that span id", async () => {
    const sent = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    const { request, headers } = xhr("GET", "https://api.example.com/x");
    finishXhr(request, 200);
    t.finish();
    await forgeOpsTracker.flushSpans();

    const [, traceId, parentId] = TRACEPARENT.exec(headers.traceparent!)!;
    expect(traceId).toBe(t.traceId);
    expect(httpSpans(traces(sent)[0]!)[0]!).toMatchObject({ span_id: parentId, name: "GET api.example.com", data: { status: 200 } });
  });

  it("adds no header outside a trace, with two traces open, or to this client's own requests", async () => {
    const sent = stubFetch();
    configure();

    expect(xhr("GET", "https://api.example.com/before").headers).toEqual({});
    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    expect(xhr("GET", "https://api.example.com/ambiguous").headers).toEqual({});
    b.finish();
    expect(xhr("POST", "https://tracker.example.com/api/v1/events").headers).toEqual({});
    expect(xhr("GET", "https://api.example.com/only-a").headers.traceparent).toMatch(TRACEPARENT);
    a.finish();
    expect(xhr("GET", "https://api.example.com/after").headers).toEqual({});
    await forgeOpsTracker.flushSpans();

    // This client's own deliveries to ForgeOps went through the same patched fetch, inside no trace
    // or not, and never got the header.
    expect(sent.filter((r) => r.url.startsWith("https://tracker.example.com/")).length).toBeGreaterThan(0);
    for (const own of sent.filter((r) => r.url.startsWith("https://tracker.example.com/"))) {
      expect(own.headers.traceparent).toBeUndefined();
    }
  });

  it("never adds the header to a delivery to ForgeOps made while a trace is open", async () => {
    const sent = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    forgeOpsTracker.captureException(new Error("boom"));
    await sleep(20);
    t.finish();

    const event = sent.find((r) => r.url.endsWith("/events"))!;
    expect(event.headers.traceparent).toBeUndefined();
  });

  it("never overwrites a traceparent the app set, on fetch or XMLHttpRequest, and still records the request", async () => {
    const sent = stubFetch();
    configure();
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const t = forgeOpsTracker.startTrace("t");
    await fetch("https://api.example.com/a", { headers: { TraceParent: own } });
    const { request, headers } = xhr("GET", "https://api.example.com/b", { traceparent: own });
    finishXhr(request, 200);
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent.find((r) => r.url.endsWith("/a"))!.headers.traceparent).toBe(own);
    expect(headers.traceparent).toBe(own);
    expect(httpSpans(traces(sent)[0]!)).toHaveLength(2);
  });

  it("adds no header with propagateTraces off, and still records the span", async () => {
    const sent = stubFetch();
    configure({ propagateTraces: false });

    const t = forgeOpsTracker.startTrace("t");
    await fetch("https://api.example.com/x");
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent[0]!.headers.traceparent).toBeUndefined();
    expect(httpSpans(traces(sent)[0]!)).toHaveLength(1);
  });

  it("by default adds the header only to same-origin requests, never cross-origin ones", async () => {
    const sent = stubFetch();
    configure({ tracePropagationTargets: undefined });
    const origin = window.location.origin;

    const t = forgeOpsTracker.startTrace("t");
    await fetch("/api/orders");
    await fetch(`${origin}/api/cart`);
    await fetch("https://api.example.com/orders");
    const sameOriginXhr = xhr("GET", `${origin}/api/me`);
    const crossOriginXhr = xhr("GET", "https://thirdparty.io/v1/rates");
    const otherPort = new URL(origin);
    otherPort.port = otherPort.port === "4000" ? "4001" : "4000";
    const otherPortXhr = xhr("GET", `${otherPort.origin}/api`);
    const explicit = t.httpSpan("GET", "https://api.example.com/");
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent.find((r) => r.url === "/api/orders")!.headers.traceparent).toMatch(TRACEPARENT);
    expect(sent.find((r) => r.url.endsWith("/api/cart"))!.headers.traceparent).toMatch(TRACEPARENT);
    expect(sent.find((r) => r.url === "https://api.example.com/orders")!.headers.traceparent).toBeUndefined();
    expect(sameOriginXhr.headers.traceparent).toMatch(TRACEPARENT);
    expect(crossOriginXhr.headers).toEqual({});
    expect(otherPortXhr.headers).toEqual({});
    expect(explicit.headers).toEqual({});
    // Cross-origin requests are still recorded as http spans, just without the header.
    expect(httpSpans(traces(sent)[0]!).map((s) => s.name)).toContain("GET api.example.com");
  });

  it("with a target list, a request gets the header when it is same-origin or matches the list", async () => {
    const sent = stubFetch();
    configure({ tracePropagationTargets: ["api.example.com"] });

    const t = forgeOpsTracker.startTrace("t");
    await fetch("/api/orders");
    await fetch("https://api.example.com/orders");
    await fetch("https://thirdparty.io/v1/rates");
    t.finish();

    expect(sent.find((r) => r.url === "/api/orders")!.headers.traceparent).toMatch(TRACEPARENT);
    expect(sent.find((r) => r.url === "https://api.example.com/orders")!.headers.traceparent).toMatch(TRACEPARENT);
    expect(sent.find((r) => r.url === "https://thirdparty.io/v1/rates")!.headers.traceparent).toBeUndefined();
  });

  it("propagateTraces off sends no header even to the page's own origin", async () => {
    const sent = stubFetch();
    configure({ tracePropagationTargets: undefined, propagateTraces: false });

    const t = forgeOpsTracker.startTrace("t");
    await fetch("/api/orders");
    t.finish();

    expect(sent.find((r) => r.url === "/api/orders")!.headers.traceparent).toBeUndefined();
  });

  it("only adds the header to tracePropagationTargets hosts: a string on a dot boundary, or a RegExp", () => {
    stubFetch();
    configure({ tracePropagationTargets: [".example.com", /^10\.0\./] });

    const t = forgeOpsTracker.startTrace("t");
    expect(xhr("GET", "https://example.com/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "https://api.EXAMPLE.com:8443/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "http://10.0.2.2:3000/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "https://badexample.com/").headers).toEqual({});
    expect(xhr("GET", "https://example.com.evil.net/").headers).toEqual({});
    expect(xhr("GET", "https://thirdparty.io/").headers).toEqual({});
    t.finish();
  });

  it("httpSpan returns the header for a request you make yourself and records it once, under the scope it came from", async () => {
    const sent = stubFetch();
    configure();
    let headers: Readonly<Record<string, string>> = {};

    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("submit", async (scope) => {
        const call = scope.httpSpan("post", "https://api.example.com/orders?coupon=secret");
        headers = call.headers;
        // Sent through XMLHttpRequest too, the way axios would: recorded once, by the explicit span.
        const { request } = xhr("POST", "https://api.example.com/orders", { ...call.headers });
        await sleep(5);
        finishXhr(request, 500);
        call.end(500);
        call.end(200);
      });
    });
    await forgeOpsTracker.flushSpans();

    const payload = traces(sent)[0]!;
    const http = httpSpans(payload);
    expect(http).toHaveLength(1);
    expect(http[0]!).toMatchObject({ name: "POST api.example.com", data: { status: 500 } });
    expect(http[0]!.parent_span_id).toBe(payload.spans.find((s) => s.name === "submit")!.span_id);
    expect(headers.traceparent).toBe(`00-${payload.trace_id}-${http[0]!.span_id}-01`);
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("httpSpan honors tracePropagationTargets and never covers ForgeOps itself; a disabled or finished trace hands out no header", () => {
    stubFetch();
    configure({ tracePropagationTargets: ["example.com"] });

    const t = forgeOpsTracker.startTrace("t");
    expect(t.httpSpan("GET", "https://thirdparty.io/").headers).toEqual({});
    t.finish();
    expect(t.httpSpan("GET", "https://api.example.com/").headers).toEqual({});

    forgeOpsTracker._resetForTesting();
    configure();
    const open = forgeOpsTracker.startTrace("t");
    expect(open.httpSpan("POST", "https://tracker.example.com/api/v1/events").headers).toEqual({});
    open.finish();

    forgeOpsTracker._resetForTesting();
    configure({ trackTracing: false });
    const disabled = forgeOpsTracker.startTrace("t");
    expect(disabled.httpSpan("GET", "https://api.example.com/").headers).toEqual({});
    expect(xhr("GET", "https://api.example.com/").headers).toEqual({});
  });

  it("t.fetch sends the header and records one http span with the status", async () => {
    const sent = stubFetch(404);
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    const response = await t.fetch("https://api.example.com/cart", { method: "PUT", headers: { "Content-Type": "application/json" } });
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(response.status).toBe(404);
    const call = sent.find((r) => r.url === "https://api.example.com/cart")!;
    expect(call.headers["content-type"]).toBe("application/json");
    const [, traceId, parentId] = TRACEPARENT.exec(call.headers.traceparent!)!;
    const payload = traces(sent)[0]!;
    expect(traceId).toBe(payload.trace_id);
    const http = httpSpans(payload);
    expect(http).toHaveLength(1);
    expect(http[0]!).toMatchObject({ span_id: parentId, name: "PUT api.example.com", data: { status: 404 } });
  });

  it("t.fetch keeps a traceparent already in init.headers, records once even with no header sent, and rethrows a failure", async () => {
    const sent = stubFetch();
    configure({ tracePropagationTargets: ["example.com"] });
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const t = forgeOpsTracker.startTrace("t");
    await t.fetch("https://api.example.com/a", { headers: { traceparent: own } });
    await t.fetch("https://thirdparty.io/b");
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent.find((r) => r.url.endsWith("/a"))!.headers.traceparent).toBe(own);
    expect(sent.find((r) => r.url.endsWith("/b"))!.headers.traceparent).toBeUndefined();
    expect(httpSpans(traces(sent)[0]!).map((s) => s.name).sort()).toEqual(["GET api.example.com", "GET thirdparty.io"]);

    const failure = new TypeError("Failed to fetch");
    globalThis.fetch = vi.fn(async () => {
      throw failure;
    });
    const recorded: TracePayload[] = [];
    const config = new Configuration();
    config.traceCaptureThresholdMs = 0;
    const direct = new Trace("t", config, (payload) => recorded.push(payload));
    await expect(direct.fetch("https://api.example.com/")).rejects.toBe(failure);
    direct.finish();
    expect(recorded[0]!.spans.find((s) => s.kind === "http")!.data).toEqual({});
  });

  it("a disabled trace's fetch is the page's fetch, untouched", async () => {
    const sent = stubFetch();
    configure({ trackTracing: false });

    await forgeOpsTracker.startTrace("t").fetch("https://api.example.com/", { headers: { a: "1" } });

    expect(sent[0]!.headers).toEqual({ a: "1" });
  });
});

describe("errors captured during a trace", () => {
  function events(sent: SentRequest[]): Record<string, unknown>[] {
    return sent.filter((r) => r.url.endsWith("/events")).map((r) => r.body as Record<string, unknown>);
  }

  async function waitForEvents(sent: SentRequest[], count: number): Promise<void> {
    for (let i = 0; i < 100 && events(sent).length < count; i++) {
      await sleep(5);
    }
  }

  it("carry the open trace's id as a top-level trace_id", async () => {
    const sent = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    forgeOpsTracker.captureException(new Error("payment declined"));
    t.finish();
    await waitForEvents(sent, 1);

    expect(events(sent)[0]!.trace_id).toBe(t.traceId);
  });

  it("an error the page-level handler catches carries it too", async () => {
    const sent = stubFetch();
    configure({ installGlobalHandlers: true });

    const t = forgeOpsTracker.startTrace("Checkout");
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("render failed"), message: "render failed" }));
    t.finish();
    await waitForEvents(sent, 1);

    expect(events(sent)[0]!.trace_id).toBe(t.traceId);
  });

  it("carry no trace_id outside a trace, with two traces open, or when tracing is off", async () => {
    const sent = stubFetch();
    configure();

    forgeOpsTracker.captureException(new Error("outside"));
    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    forgeOpsTracker.captureException(new Error("ambiguous"));
    a.finish();
    b.finish();
    await waitForEvents(sent, 2);
    forgeOpsTracker._resetForTesting();
    configure({ trackTracing: false });
    const disabled = forgeOpsTracker.startTrace("off");
    forgeOpsTracker.captureException(new Error("tracing off"));
    disabled.finish();
    await waitForEvents(sent, 3);

    expect(events(sent)).toHaveLength(3);
    for (const event of events(sent)) {
      expect(event).not.toHaveProperty("trace_id");
    }
  });
});
