import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryStatus } from "../src/client.js";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";
import { MAX_METRIC_ENTRIES, MetricBuffer } from "../src/metricBuffer.js";

const originalFetch = globalThis.fetch;

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";
  config.release = "a1b2c3d";
  config.enabledEnvironments = new Set(["production"]);
  return config;
}

const buffers: MetricBuffer[] = [];
function newBuffer(
  deliver: (entries: Record<string, unknown>[]) => Promise<DeliveryStatus>,
  intervalMs = 3_600_000,
  logs: string[] = [],
): MetricBuffer {
  const config = newConfiguration();
  config.logger = (message) => logs.push(message);
  const buffer = new MetricBuffer(config, deliver, () => intervalMs);
  buffers.push(buffer);
  return buffer;
}

function names(entries: Record<string, unknown>[]): unknown[] {
  return entries.map((e) => e.metric_name);
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  buffers.splice(0).forEach((b) => b.discard());
  forgeOpsTracker._resetForTesting();
  globalThis.fetch = originalFetch;
});

describe("MetricBuffer", () => {
  it("delivers every entry as one batch, stamped with a seconds-precision UTC recorded_at", async () => {
    const delivered: Record<string, unknown>[][] = [];
    const buffer = newBuffer(async (entries) => {
      delivered.push(entries);
      return "delivered";
    });

    expect(buffer.record({ metric_name: "signup", value: 1 })).toBe(true);
    expect(buffer.record({ metric_name: "refund", value: -12.5 })).toBe(true);
    await buffer.flush();

    expect(delivered).toHaveLength(1);
    expect(names(delivered[0]!)).toEqual(["signup", "refund"]);
    expect(delivered[0]![1]!.value).toBe(-12.5);
    expect(delivered[0]![0]!.recorded_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(buffer.size).toBe(0);
  });

  it("drops NaN, infinite and non-numeric values so one bad entry cannot poison a batch", () => {
    const buffer = newBuffer(async () => "delivered");
    expect(buffer.record({ metric_name: "nan", value: NaN })).toBe(false);
    expect(buffer.record({ metric_name: "inf", value: Infinity })).toBe(false);
    expect(buffer.record({ metric_name: "str", value: "12" })).toBe(false);
    expect(buffer.record({ metric_name: "ok", value: 3 })).toBe(true);
  });

  it("a failed delivery keeps every entry for the next flush", async () => {
    const outcomes: DeliveryStatus[] = ["failed", "delivered"];
    const delivered: unknown[][] = [];
    const buffer = newBuffer(async (entries) => {
      delivered.push(names(entries));
      return outcomes.shift()!;
    });

    buffer.record({ metric_name: "a", value: 1 });
    await buffer.flush();
    buffer.record({ metric_name: "b", value: 2 });
    await buffer.flush();
    await buffer.flush(); // nothing left: no third delivery

    expect(delivered).toEqual([["a"], ["a", "b"]]);
  });

  it("an entry recorded while delivery is in flight is never lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: unknown[][] = [];
    const buffer = newBuffer(async (entries) => {
      delivered.push(names(entries));
      if (delivered.length === 1) {
        await gate;
      }
      return "delivered";
    });

    buffer.record({ metric_name: "first", value: 1 });
    const flushing = buffer.flush();
    buffer.record({ metric_name: "during", value: 2 });
    release();
    await flushing;
    await buffer.flush();

    expect(delivered).toEqual([["first"], ["during"]]);
  });

  it("is capped and drops further entries until a flush succeeds", () => {
    const buffer = newBuffer(async () => "failed");
    let accepted = 0;
    for (let i = 0; i < MAX_METRIC_ENTRIES + 50; i++) {
      if (buffer.record({ metric_name: "m", value: 1 })) accepted += 1;
    }
    expect(accepted).toBe(MAX_METRIC_ENTRIES);
  });

  it("flushes on its own interval", async () => {
    const delivered = vi.fn(async (): Promise<DeliveryStatus> => "delivered");
    const buffer = newBuffer(delivered, 20);
    buffer.record({ metric_name: "tick", value: 1 });

    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("a batch the server rejects is dropped and never sent again", async () => {
    const logs: string[] = [];
    const delivered: unknown[][] = [];
    const buffer = newBuffer(
      async (entries) => {
        delivered.push(names(entries));
        return "rejected";
      },
      3_600_000,
      logs,
    );

    buffer.record({ metric_name: "a", value: 1 });
    await buffer.flush();
    await buffer.flush(); // nothing left: no second delivery
    buffer.record({ metric_name: "b", value: 2 });
    await buffer.flush();

    expect(delivered).toEqual([["a"], ["b"]]);
    expect(logs).toEqual([
      "[forge-ops-tracker] dropping 1 metric(s): the server rejected them",
      "[forge-ops-tracker] dropping 1 metric(s): the server rejected them",
    ]);
  });

  it("a rejected batch frees a full buffer for new metrics", async () => {
    const buffer = newBuffer(async () => "rejected");
    for (let i = 0; i < MAX_METRIC_ENTRIES; i++) {
      buffer.record({ metric_name: "m", value: 1 });
    }
    expect(buffer.record({ metric_name: "m", value: 1 })).toBe(false);

    await buffer.flush();

    expect(buffer.size).toBe(0);
    expect(buffer.record({ metric_name: "m", value: 1 })).toBe(true);
  });

  it("the fifth failed flush in a row drops the batch and starts clean", async () => {
    const logs: string[] = [];
    const delivered: unknown[][] = [];
    const buffer = newBuffer(
      async (entries) => {
        delivered.push(names(entries));
        return "failed";
      },
      3_600_000,
      logs,
    );

    buffer.record({ metric_name: "a", value: 1 });
    for (let i = 0; i < 4; i++) {
      await buffer.flush();
    }
    expect(buffer.size).toBe(1);
    expect(logs).toEqual([]);
    await buffer.flush(); // the fifth: gives up on the batch
    await buffer.flush(); // nothing left: no sixth delivery

    expect(delivered).toHaveLength(5);
    expect(buffer.size).toBe(0);
    expect(logs).toEqual(["[forge-ops-tracker] dropping 1 metric(s): 5 flushes in a row failed"]);

    // Clean again: the next batch gets its own five tries.
    buffer.record({ metric_name: "b", value: 2 });
    await buffer.flush();
    await buffer.flush();
    expect(delivered.slice(5)).toEqual([["b"], ["b"]]);
  });

  it("a delivery in between resets the count of failed flushes", async () => {
    const outcomes: DeliveryStatus[] = ["failed", "failed", "failed", "failed", "delivered", "failed", "failed", "failed", "failed"];
    const buffer = newBuffer(async () => outcomes.shift() ?? "delivered");

    buffer.record({ metric_name: "a", value: 1 });
    for (let i = 0; i < 5; i++) {
      await buffer.flush();
    }
    buffer.record({ metric_name: "b", value: 2 });
    for (let i = 0; i < 4; i++) {
      await buffer.flush();
    }

    // Four failures after the delivery are not five in a row: "b" is still held.
    expect(buffer.size).toBe(1);
  });
});

describe("captureMetric / captureInfrastructureMetric", () => {
  function stubFetch(): { path: string; auth: string; body: { metrics: Record<string, unknown>[] } }[] {
    const calls: { path: string; auth: string; body: { metrics: Record<string, unknown>[] } }[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(url)).pathname,
        auth: (init!.headers as Record<string, string>).Authorization!,
        body: JSON.parse(init!.body as string),
      });
      return new Response(null, { status: 202 });
    });
    return calls;
  }

  function configure(overrides: Record<string, unknown> = {}): void {
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      environment: "production",
      release: "a1b2c3d",
      serverName: "host-1",
      enabledEnvironments: new Set(["production"]),
      installGlobalHandlers: false,
      webVitals: false,
      breadcrumbs: false,
      trackPerformance: false,
      trackTracing: false,
      ...overrides,
    });
  }

  it("delivers to their own endpoints end to end", async () => {
    const calls = stubFetch();
    configure();

    forgeOpsTracker.captureMetric("signup");
    forgeOpsTracker.captureMetric("payment", 49);
    forgeOpsTracker.captureInfrastructureMetric("battery", 0.42, { hostname: "db-1" });
    forgeOpsTracker.captureInfrastructureMetric("memory", 0.7);
    await forgeOpsTracker.flushMetrics();

    const byPath = Object.fromEntries(calls.map((c) => [c.path, c]));
    const custom = byPath["/api/v1/custom_metrics"]!;
    expect(custom.auth).toBe("Bearer key");
    expect(names(custom.body.metrics)).toEqual(["signup", "payment"]);
    expect(custom.body.metrics.map((m) => m.value)).toEqual([1, 49]);
    expect(custom.body.metrics[0]!.environment).toBe("production");
    expect(custom.body.metrics[0]!.release).toBe("a1b2c3d");
    const infrastructure = byPath["/api/v1/infrastructure_metrics"]!.body.metrics;
    expect(infrastructure[0]!.hostname).toBe("db-1");
    expect(infrastructure[1]!.hostname).toBe("host-1");
  });

  it("drops an infrastructure reading that has no hostname, and says so", async () => {
    const calls = stubFetch();
    const logged: string[] = [];
    configure({ serverName: null, logger: (m: string) => logged.push(m) });
    forgeOpsTracker.captureInfrastructureMetric("battery", 1);
    await forgeOpsTracker.flushMetrics();

    expect(calls).toHaveLength(0);
    expect(logged.join("\n")).toContain("no hostname");
  });

  it("is a no-op when reporting is not enabled", async () => {
    const calls = stubFetch();
    configure({ environment: "development" });
    forgeOpsTracker.captureMetric("signup");
    forgeOpsTracker.captureInfrastructureMetric("battery", 1);
    await forgeOpsTracker.flushMetrics();

    expect(calls).toHaveLength(0);
  });

  it("the metric uris swap the trailing events segment", () => {
    const config = newConfiguration();
    expect(config.customMetricsUri()).toBe("https://tracker.example.com/api/v1/custom_metrics");
    expect(config.infrastructureMetricsUri()).toBe("https://tracker.example.com/api/v1/infrastructure_metrics");
  });
});
