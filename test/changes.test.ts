import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as forgeOpsTracker from "../src/index.js";
import { buildChangePayload, normalizeChangeKind } from "../src/changes.js";
import { Configuration } from "../src/configuration.js";

const originalFetch = globalThis.fetch;
const DSN = "https://key@tracker.example.com/api/v1/events";

interface CapturedRequest {
  uri: RequestInfo | URL;
  init?: RequestInit;
}

function mockFetch(status = 202): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (uri: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ uri, init });
    return new Response(null, { status });
  });
  return requests;
}

function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

function body(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.init!.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

describe("recordChange", () => {
  it("posts the change to /api/v1/changes with the bearer key", async () => {
    const requests = mockFetch();
    forgeOpsTracker.init({ dsn: DSN, environment: "staging", installGlobalHandlers: false });

    forgeOpsTracker.recordChange("feature_flag", "new_checkout turned on", {
      details: { key: "new_checkout", from: false, to: true },
      actor: "flag-service",
      url: "https://flags.example.com/new_checkout",
      id: "flag-123",
      occurredAt: new Date("2026-09-25T12:00:00Z"),
    });

    await waitUntil(() => requests.length === 1);
    expect(requests[0]!.uri).toBe("https://tracker.example.com/api/v1/changes");
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
    expect(body(requests[0]!)).toEqual({
      kind: "feature_flag",
      title: "new_checkout turned on",
      environment: "staging",
      occurred_at: "2026-09-25T12:00:00.000Z",
      details: { key: "new_checkout", from: false, to: true },
      actor: "flag-service",
      url: "https://flags.example.com/new_checkout",
      id: "flag-123",
    });
  });

  it("defaults occurred_at to now and leaves unset options out", async () => {
    const requests = mockFetch();
    forgeOpsTracker.init({ dsn: DSN, installGlobalHandlers: false });

    forgeOpsTracker.recordChange("config", "checkout timeout raised");

    await waitUntil(() => requests.length === 1);
    const sent = body(requests[0]!);
    expect(Object.keys(sent).sort()).toEqual(["environment", "kind", "occurred_at", "title"]);
    expect(sent.environment).toBe("production");
    expect(Number.isNaN(Date.parse(sent.occurred_at as string))).toBe(false);
  });

  it("is a no-op when reporting isn't enabled", async () => {
    const requests = mockFetch();
    forgeOpsTracker.init({ dsn: DSN, environment: "development", installGlobalHandlers: false });

    forgeOpsTracker.recordChange("feature_flag", "ignored");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toHaveLength(0);
  });

  it("never throws on a 403, a 500, or a network error", async () => {
    forgeOpsTracker.init({ dsn: DSN, installGlobalHandlers: false });

    for (const status of [403, 500]) {
      const requests = mockFetch(status);
      expect(() => forgeOpsTracker.recordChange("feature_flag", "x")).not.toThrow();
      await waitUntil(() => requests.length === 1);
    }

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(() => forgeOpsTracker.recordChange("feature_flag", "x")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("drops a change with no title instead of sending it", async () => {
    const requests = mockFetch();
    forgeOpsTracker.init({ dsn: DSN, installGlobalHandlers: false });

    forgeOpsTracker.recordChange("feature_flag", "   ");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toHaveLength(0);
  });
});

describe("buildChangePayload", () => {
  const config = new Configuration();

  it("keeps each of the six kinds and sends anything else as other", () => {
    for (const kind of forgeOpsTracker.CHANGE_KINDS) {
      expect(normalizeChangeKind(kind)).toBe(kind);
    }
    expect(normalizeChangeKind("flag")).toBe("other");
    expect(normalizeChangeKind(undefined)).toBe("other");
    expect(buildChangePayload(config, "deploy", "x")!.kind).toBe("other");
  });

  it("truncates the title to 200 characters", () => {
    expect(buildChangePayload(config, "other", "a".repeat(250))!.title).toHaveLength(200);
  });

  it("leaves out a url that isn't http(s) and details that aren't an object", () => {
    const payload = buildChangePayload(config, "other", "x", {
      url: "javascript:alert(1)",
      details: ["not", "an", "object"] as unknown as Record<string, unknown>,
    })!;
    expect(payload.url).toBeUndefined();
    expect(payload.details).toBeUndefined();
  });

  it("uses an explicit environment and service over the defaults", () => {
    const payload = buildChangePayload(config, "other", "x", { environment: "qa", service: "web" })!;
    expect(payload.environment).toBe("qa");
    expect(payload.service).toBe("web");
  });
});
