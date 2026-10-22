/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";
import { EventBuilder, EventPayload, StrictEventPayload } from "../src/eventBuilder.js";
import * as forgeOpsTracker from "../src/index.js";
import { PerformanceFlusher } from "../src/performanceFlusher.js";
import { messageFingerprint, normalizeMessage, pageUrl, strictPath, sha256Hex, spanName } from "../src/strictPrivacy.js";
import { installWebVitals, uninstallWebVitals, WebVitalsPayload } from "../src/webVitals.js";
// A byte-identical copy of sdks/strict_privacy_vectors.json, generated from the server's own
// app/services/strict_privacy.rb: the results every SDK and the server have to agree on.
import vectorsJson from "./fixtures/strict_privacy_vectors.json?raw";

interface Vectors {
  fingerprint: { message: string; normalized: string; fingerprint: string }[];
  span_name: { name: string; strict: string }[];
  path: { path: string; strict: string }[];
  page_url: { url: string; strict: string }[];
}

const vectors = JSON.parse(vectorsJson) as Vectors;
const originalFetch = globalThis.fetch;

function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function mockFetchCapturing(): { uri: RequestInfo | URL; body: string }[] {
  const requests: { uri: RequestInfo | URL; body: string }[] = [];
  globalThis.fetch = vi.fn(async (uri: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ uri, body: String(init?.body) });
    return new Response(null, { status: 202 });
  });
  return requests;
}

function initEnabled(options: forgeOpsTracker.InitOptions = {}): Configuration {
  return forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    environment: "production",
    installGlobalHandlers: false,
    webVitals: false,
    trackPerformance: false,
    ...options,
  });
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
  uninstallWebVitals();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("strict privacy vectors", () => {
  // That the fixture matches the repo's sdks/strict_privacy_vectors.json is checked by the server's
  // own suite (spec/models/sdk_strict_privacy_vectors_spec.rb): a published package's tests can't
  // read outside its own directory.
  it.each(vectors.fingerprint)("fingerprint vector %j", (vector) => {
    expect(normalizeMessage(vector.message)).toBe(vector.normalized);
    expect(messageFingerprint(vector.message)).toBe(vector.fingerprint);
  });

  it.each(vectors.path)("path vector %j", (vector) => {
    expect(strictPath(vector.path)).toBe(vector.strict);
  });

  it.each(vectors.span_name)("span_name vector %j", (vector) => {
    expect(spanName(vector.name)).toBe(vector.strict);
  });

  it("the self-contained SHA-256 matches known digests, across block boundaries", () => {
    const bytes = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
    expect(sha256Hex([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex(bytes("a".repeat(1000)))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  it.each(vectors.page_url)("page_url vector %j", (vector) => {
    expect(pageUrl(vector.url)).toBe(vector.strict);
  });
});

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";
  config.release = "abc123";
  config.captureSqlStatement = true;
  return config;
}

function sqlError(): Error {
  const error = new Error("Couldn't find Patient with id=8821 (jane@example.com)") as Error & { sql: string };
  error.sql = "SELECT * FROM patients WHERE email = 'jane@example.com'";
  return error;
}

describe("EventBuilder#buildStrict", () => {
  it("keeps only structured facts", () => {
    const config = newConfiguration();
    config.strictPrivacy = true;
    config.privacyAllowedFields = ["error_code", "nested", "missing"];

    const payload: StrictEventPayload = new EventBuilder(config).buildStrict(
      sqlError(),
      { error_code: "E42", diagnosis: "flu", nested: { error_code: "x" } },
      { id: 7, email: "jane@example.com", username: "jane" },
      "a".repeat(32),
    );

    expect("message" in payload).toBe(false);
    expect(payload.message_fingerprint).toBe(messageFingerprint("Couldn't find Patient with id=8821 ([EMAIL FILTERED])"));
    expect(payload.message_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect("breadcrumbs" in payload).toBe(false);
    expect("replay_id" in payload).toBe(false);
    expect("endpoint" in payload).toBe(false);
    expect("sql_statement" in payload).toBe(false);
    expect(payload.sql_objects?.relations).toEqual(["patients"]);
    expect(payload.context).toEqual({ error_code: "E42" });
    expect("tags" in payload).toBe(false);
    expect(payload.user).toEqual({ id: "7" });
    expect(payload.trace_id).toBe("a".repeat(32));
    expect(payload.backtrace.length).toBeGreaterThan(0);
    for (const frame of payload.backtrace) {
      expect(Object.keys(frame).sort()).toEqual(["file", "in_app", "line", "method"]);
    }
    expect(JSON.stringify(payload)).not.toMatch(/jane|flu|8821/);
  });

  it("leaves context, tags and user out when nothing is allowed or there's no id", () => {
    const config = newConfiguration();
    config.strictPrivacy = true;

    const payload = new EventBuilder(config).buildStrict(new Error("boom"), { error_code: "E42" }, { email: "jane@example.com" });

    expect("context" in payload).toBe(false);
    expect("tags" in payload).toBe(false);
    expect("user" in payload).toBe(false);
    expect(payload.message_fingerprint).toBe("81f52337ebb4cb1669bb802c708807dd");
  });
});

describe("captureException with strict privacy", () => {
  it("sends no message, breadcrumbs or replay id, and records no breadcrumbs", async () => {
    const requests = mockFetchCapturing();
    initEnabled({ strictPrivacy: true, privacyAllowedFields: ["error_code"], sessionReplay: true });

    forgeOpsTracker.addBreadcrumb({ category: "ui", level: "info", message: "Viewed patient Jane Doe" });
    console.log("Jane Doe's chart"); // the console source isn't installed under strict privacy
    forgeOpsTracker.captureException(new Error("Patient Jane Doe not found"), { error_code: "E1", name: "Jane" });

    await waitUntil(() => requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20)); // a replay upload, if one went out
    expect(requests).toHaveLength(1);
    expect(String(requests[0]!.uri)).toMatch(/\/events$/);
    const event = JSON.parse(requests[0]!.body) as StrictEventPayload & Partial<EventPayload>;
    expect(event.message).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.replay_id).toBeUndefined();
    expect(event.message_fingerprint).toBe(messageFingerprint("Patient Jane Doe not found"));
    expect(event.context).toEqual({ error_code: "E1" });
    expect(requests[0]!.body).not.toMatch(/Jane/);
  });

  it("with strict privacy off, events are exactly as before", async () => {
    const requests = mockFetchCapturing();
    initEnabled({ privacyAllowedFields: ["error_code"] }); // ignored while strictPrivacy is off

    forgeOpsTracker.addBreadcrumb({ category: "ui", level: "info", message: "clicked save" });
    forgeOpsTracker.captureException(new Error("boom 42"), { error_code: "E1", feature: "x" }, { id: 7, email: "a@b.co" });

    await waitUntil(() => requests.length === 1);
    const event = JSON.parse(requests[0]!.body) as EventPayload & { message_fingerprint?: string };
    expect(event.message).toBe("boom 42");
    expect(event.message_fingerprint).toBeUndefined();
    expect(event.breadcrumbs).toHaveLength(1);
    expect(event.replay_id).toBeNull();
    expect(event.context).toEqual({ error_code: "E1", feature: "x" });
    expect(event.tags).toEqual({});
    expect(event.user).toEqual({ id: 7, email: "a@b.co" });
  });
});

describe("traces with strict privacy", () => {
  it("names network spans by method and host and keeps only db.statement/db.system", async () => {
    const requests = mockFetchCapturing();
    initEnabled({ strictPrivacy: true, traceCaptureThresholdMs: 0 });

    forgeOpsTracker.trace("GET /patients/42", (t) => {
      t.recordSpan("GET https://api.example.com/patients/42?x=1", { kind: "http", startedAt: Date.now(), durationMs: 5, data: { status: 200, url: "/patients/42" } });
      t.recordSpan("load", { kind: "database", startedAt: Date.now(), durationMs: 1, statement: "SELECT * FROM notes WHERE id = 3", dbSystem: "sqlite", data: { rows: 2 } });
    });

    await waitUntil(() => requests.some((r) => String(r.uri).endsWith("/spans")));
    const body = JSON.parse(requests.find((r) => String(r.uri).endsWith("/spans"))!.body) as { spans: { name: string; kind: string; data: Record<string, unknown> }[] };
    expect(body.spans.find((s) => s.kind === "controller")!.name).toBe("GET /patients/:path");
    const http = body.spans.find((s) => s.kind === "http")!;
    expect(http.name).toBe("GET api.example.com");
    expect(http.data).toEqual({});
    expect(body.spans.find((s) => s.kind === "database")!.data).toEqual({ "db.system": "sqlite", "db.statement": "SELECT * FROM notes WHERE id = ?" });
  });

  it("with strict privacy off, spans are unchanged", async () => {
    const requests = mockFetchCapturing();
    initEnabled({ traceCaptureThresholdMs: 0 });

    forgeOpsTracker.trace("GET /patients/42", (t) => {
      t.recordSpan("GET api.example.com", { kind: "http", startedAt: Date.now(), durationMs: 5, data: { status: 200 } });
    });

    await waitUntil(() => requests.some((r) => String(r.uri).endsWith("/spans")));
    const body = JSON.parse(requests.find((r) => String(r.uri).endsWith("/spans"))!.body) as { spans: { name: string; kind: string; data: Record<string, unknown> }[] };
    expect(body.spans.find((s) => s.kind === "controller")!.name).toBe("GET /patients/42");
    expect(body.spans.find((s) => s.kind === "http")!.data).toEqual({ status: 200 });
  });
});

describe("session replay with strict privacy", () => {
  it("is never installed, uploaded or referenced, even with sessionReplay on", async () => {
    const requests = mockFetchCapturing();
    document.body.innerHTML = "<p>Jane Doe</p>";
    initEnabled({ strictPrivacy: true, sessionReplay: true });

    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.some((r) => String(r.uri).endsWith("/session_replays"))).toBe(false);
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty("replay_id");
    document.body.innerHTML = "";
  });
});

describe("web vitals with strict privacy", () => {
  class FakePerformanceObserver {
    static supportedEntryTypes = ["layout-shift"];
    observe(): void {}
    disconnect(): void {}
  }

  function deliverOnHide(strict: boolean): WebVitalsPayload {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    window.history.replaceState(null, "", "/patients/42/notes?q=jane#top");
    const configuration = newConfiguration();
    configuration.strictPrivacy = strict;
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    return deliverSpy.mock.calls[0]![0] as WebVitalsPayload;
  }

  it("sends the page's scheme, host (no port) and only the first segment of its path, never its query or fragment", () => {
    expect(deliverOnHide(true).url).toBe(`${window.location.protocol}//${window.location.hostname}/patients/:path`);
  });

  it("sends the full URL with strict privacy off", () => {
    expect(deliverOnHide(false).url).toBe(window.location.href);
  });
});

describe("performance samples with strict privacy", () => {
  it.each([true, false])("strictPrivacy %s: a raw-path transaction name loses its ids only when on, and a route is kept", async (strict) => {
    const config = newConfiguration();
    config.strictPrivacy = strict;
    const client = new Client(config);
    const deliverSpy = vi.spyOn(client, "deliverPerformanceSamples").mockResolvedValue("delivered");
    const flusher = new PerformanceFlusher(config, client);

    flusher.record("GET /patients/42", 100);
    flusher.record("GET /patients/43", 100);
    flusher.record("checkout", 100);
    await flusher.flush();

    const names = deliverSpy.mock.calls[0]![0].map((sample) => sample.transaction_name).sort();
    expect(names).toEqual(strict ? ["GET /patients/:path", "checkout"] : ["GET /patients/42", "GET /patients/43", "checkout"]);
    flusher.discard();
  });
});
