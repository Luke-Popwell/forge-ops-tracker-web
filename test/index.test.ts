import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as forgeOpsTracker from "../src/index.js";

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

interface CapturedRequest {
  uri: RequestInfo | URL;
  init?: RequestInit;
}

function mockFetchCapturing(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (uri: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ uri, init });
    return new Response(null, { status: 202 });
  });
  return requests;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

describe("index", () => {
  it("init configures and returns the configuration", () => {
    const config = forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      release: "abc123",
    });

    expect(config.dsn).toBe("https://key@tracker.example.com/api/v1/events");
    expect(config.release).toBe("abc123");
  });

  it("init rejects an unknown configuration property", () => {
    expect(() => {
      forgeOpsTracker.init({ notARealSetting: true } as never);
    }).toThrow(TypeError);
  });

  it("captureException delivers through the full stack", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error as Error);
    }

    await waitUntil(() => requests.length === 1);
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("setUser attaches the user to a later captureException call", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    forgeOpsTracker.setUser({ id: 42, email: "alice@example.com" });
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error as Error);
    }

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.user).toEqual({ id: 42, email: "alice@example.com" });
  });

  it("an explicit user argument overrides whatever setUser last set", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    forgeOpsTracker.setUser({ id: 42 });
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error as Error, {}, { id: 99 });
    }

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.user).toEqual({ id: 99 });
  });

  it("setUser with nothing clears whatever was set", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    forgeOpsTracker.setUser({ id: 42 });
    forgeOpsTracker.setUser();
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error as Error);
    }

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.user).toBeUndefined();
  });

  it("window 'error' listener reports an uncaught exception with no further wiring", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("uncaught"), message: "uncaught" }));

    await waitUntil(() => requests.length === 1);
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("window 'unhandledrejection' listener reports the rejection reason", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    const rejected = Promise.reject(new Error("rejected"));
    // Prevent this deliberately-rejected promise from also being reported by the test runner's
    // own unhandled-rejection tracking: we're testing our listener directly via a dispatched
    // event below, not relying on the runtime's real unhandled-rejection detection timing.
    rejected.catch(() => {});
    // jsdom doesn't implement the real PromiseRejectionEvent constructor (confirmed directly,
    // it throws "PromiseRejectionEvent is not defined", not assumed) even though every real
    // browser does; a minimal structural polyfill is enough since the listener only reads
    // event.reason, not any other PromiseRejectionEvent-specific behavior.
    class PromiseRejectionEventPolyfill extends Event {
      reason: unknown;
      promise: Promise<unknown>;
      constructor(type: string, init: { promise: Promise<unknown>; reason: unknown }) {
        super(type);
        this.promise = init.promise;
        this.reason = init.reason;
      }
    }
    window.dispatchEvent(
      new PromiseRejectionEventPolyfill("unhandledrejection", {
        promise: rejected,
        reason: new Error("rejected"),
      }) as unknown as Event,
    );

    await waitUntil(() => requests.length === 1);
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("captureException includes the current breadcrumb trail", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });
    forgeOpsTracker.addBreadcrumb({ category: "custom", message: "user logged in", level: "info" });

    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.breadcrumbs).toEqual([expect.objectContaining({ category: "custom", message: "user logged in", level: "info" })]);
  });

  it("addBreadcrumb stamps a timestamp when none is given", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    forgeOpsTracker.addBreadcrumb({ category: "custom", message: "hi", level: "info" });
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.breadcrumbs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("automatic breadcrumb sources are installed by default", () => {
    const originalLog = console.log;

    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events" });

    expect(console.log).not.toBe(originalLog); // console.log has been wrapped
  });

  it("breadcrumbs: false in init() leaves the automatic sources uninstalled", () => {
    const originalLog = console.log;

    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events", breadcrumbs: false });

    expect(console.log).toBe(originalLog);
  });

  it("automatic Web Vitals capture is installed by default", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events" });

    expect(addEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("webVitals: false in init() leaves Web Vitals capture uninstalled", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    // trackPerformance: false too: performance monitoring registers its own visibilitychange
    // listener (to flush when the page is hidden), so with it left on this assertion could no
    // longer tell Web Vitals apart from it.
    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events", webVitals: false, trackPerformance: false });

    expect(addEventListenerSpy).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("installGlobalHandlers: false leaves window listeners uninstalled", () => {
    // Asserted via a spy on addEventListener itself, rather than by dispatching a real ErrorEvent
    // and checking nothing reported: jsdom's own default action for an unhandled "error" event
    // (confirmed directly: it surfaces as an uncaught exception at the test-runner level) makes
    // that approach unreliable here regardless of whether this client's own listener is installed.
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");

    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      installGlobalHandlers: false,
    });

    expect(addEventListenerSpy).not.toHaveBeenCalledWith("error", expect.anything());
    expect(addEventListenerSpy).not.toHaveBeenCalledWith("unhandledrejection", expect.anything());
  });

  function initForPerformance(overrides: Record<string, unknown> = {}): CapturedRequest[] {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
      breadcrumbs: false,
      performanceFlushIntervalMs: 3_600_000, // flushed by hand below
      ...overrides,
    });
    return requests;
  }

  it("recordPerformance tallies in-process and flushPerformance delivers one aggregate batch", async () => {
    const requests = initForPerformance();

    forgeOpsTracker.recordPerformance("HomeScreen.load", 10);
    forgeOpsTracker.recordPerformance("HomeScreen.load", 30);
    await forgeOpsTracker.flushPerformance();

    expect(String(requests[0]!.uri)).toBe("https://tracker.example.com/api/v1/performance_samples");
    const sample = JSON.parse(requests[0]!.init!.body as string).samples[0];
    expect(sample).toMatchObject({ transaction_name: "HomeScreen.load", request_count: 2 });
  });

  it("timeTransaction returns a synchronous value and records how long it took", async () => {
    const requests = initForPerformance();

    const value = forgeOpsTracker.timeTransaction("timed", () => 42);
    await forgeOpsTracker.flushPerformance();

    expect(value).toBe(42);
    expect(JSON.parse(requests[0]!.init!.body as string).samples[0].transaction_name).toBe("timed");
  });

  it("timeTransaction records even when the function throws, and rethrows it unchanged", async () => {
    const requests = initForPerformance();

    expect(() =>
      forgeOpsTracker.timeTransaction("timed throws", () => {
        throw new RangeError("inside");
      }),
    ).toThrow(RangeError);
    await forgeOpsTracker.flushPerformance();

    expect(JSON.parse(requests[0]!.init!.body as string).samples[0].transaction_name).toBe("timed throws");
  });

  it("timeTransaction times an async function until it settles, fulfilled or rejected", async () => {
    const requests = initForPerformance();

    const value = await forgeOpsTracker.timeTransaction("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    });
    await expect(
      forgeOpsTracker.timeTransaction("slow fails", async () => {
        throw new RangeError("later");
      }),
    ).rejects.toThrow(RangeError);
    await forgeOpsTracker.flushPerformance();

    expect(value).toBe("done");
    const samples = JSON.parse(requests[0]!.init!.body as string).samples as { transaction_name: string; duration_sum_ms: number }[];
    const slow = samples.find((s) => s.transaction_name === "slow")!;
    expect(slow.duration_sum_ms).toBeGreaterThanOrEqual(50); // timed across the await, not just the call
    expect(samples.some((s) => s.transaction_name === "slow fails")).toBe(true);
  });

  it("trackPerformance off records and delivers nothing", async () => {
    const requests = initForPerformance({ trackPerformance: false });

    forgeOpsTracker.recordPerformance("never recorded", 10);
    await forgeOpsTracker.flushPerformance();

    expect(requests).toHaveLength(0);
  });


  it("init installs the automatic network timing by default, and trackPerformance: false turns it off", async () => {
    const requests = initForPerformance();
    const stubbed = globalThis.fetch;
    // A request to another host, through the patched fetch (which wraps the stub above).
    await fetch("https://api.example.com/orders/42");
    await forgeOpsTracker.flushPerformance();
    const performanceRequest = requests.find((r) => String(r.uri).endsWith("/performance_samples"));
    expect(JSON.parse(performanceRequest!.init!.body as string).samples[0].transaction_name).toBe("GET api.example.com");

    forgeOpsTracker._resetForTesting();
    globalThis.fetch = stubbed;
    const offRequests = initForPerformance({ trackPerformance: false });
    await fetch("https://api.example.com/orders/42");
    await forgeOpsTracker.flushPerformance();
    expect(offRequests.filter((r) => String(r.uri).endsWith("/performance_samples"))).toHaveLength(0);
  });
});
