import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";
import { installWebVitals, uninstallWebVitals, WebVitalsPayload } from "../src/webVitals.js";

// jsdom's own PerformanceObserver (actually Node's perf_hooks implementation under this test
// runner, confirmed directly by printing PerformanceObserver.supportedEntryTypes: it lists
// "mark"/"measure"/"gc"/etc., never "largest-contentful-paint"/"layout-shift"/"event"/"paint") has
// no support at all for any Web Vitals entry type, so there's no way to fire a real one under this
// test runner. This fake stands in for the constructor entirely, letting each test call the exact
// callback installWebVitals registered with fabricated entries shaped like the real DOM types
// (see webVitals.ts's own locally-declared interfaces), the same technique index.test.ts already
// uses for a real PromiseRejectionEvent jsdom itself doesn't implement.
class FakePerformanceObserver {
  static supportedEntryTypes = [ "largest-contentful-paint", "layout-shift", "event", "paint", "navigation" ];
  static instances: FakePerformanceObserver[] = [];

  type: string | undefined;
  private callback: PerformanceObserverCallback;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    FakePerformanceObserver.instances.push(this);
  }

  observe(options: PerformanceObserverInit & { type?: string }): void {
    this.type = options.type;
  }

  disconnect(): void {}

  fire<T extends PerformanceEntry>(entries: Partial<T>[]): void {
    const list = { getEntries: () => entries as T[] } as unknown as PerformanceObserverEntryList;
    this.callback(list, this as unknown as PerformanceObserver);
  }
}

// Minimal local shapes matching webVitals.ts's own (non-exported) entry interfaces, just enough
// to type the fabricated entries each test fires through FakePerformanceObserver above.
interface FakeLcpEntry extends PerformanceEntry {
  renderTime: number;
  loadTime: number;
}

interface FakeLayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

function observerFor(type: string): FakePerformanceObserver {
  const observer = FakePerformanceObserver.instances.find((o) => o.type === type);
  if (!observer) {
    throw new Error(`no observer registered for type ${type}`);
  }
  return observer;
}

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";
  config.release = "1.2.3";
  return config;
}

function hideThePage(): void {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  FakePerformanceObserver.instances = [];
  vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
});

afterEach(() => {
  uninstallWebVitals();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installWebVitals", () => {
  it("is a no-op the second time, without registering duplicate observers", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);

    installWebVitals(configuration, client);
    const countAfterFirstInstall = FakePerformanceObserver.instances.length;
    installWebVitals(configuration, client);

    expect(FakePerformanceObserver.instances).toHaveLength(countAfterFirstInstall);
  });

  it("delivers a measurement with every metric once the page becomes hidden", async () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("largest-contentful-paint").fire<FakeLcpEntry>([ { renderTime: 1800, loadTime: 0 } ]);
    observerFor("layout-shift").fire<FakeLayoutShiftEntry>([ { value: 0.05, hadRecentInput: false, startTime: 100 } ]);
    observerFor("event").fire([ { duration: 120 } ]);
    observerFor("paint").fire([ { name: "first-paint", startTime: 500 }, { name: "first-contentful-paint", startTime: 900 } ]);
    vi.mocked(performance.getEntriesByType).mockReturnValue([ { responseStart: 200 } as PerformanceNavigationTiming ]);

    hideThePage();

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const payload = deliverSpy.mock.calls[0]![0] as WebVitalsPayload;
    expect(payload.lcp_ms).toBe(1800);
    expect(payload.cls).toBe(0.05);
    expect(payload.inp_ms).toBe(120);
    expect(payload.fcp_ms).toBe(900);
    expect(payload.ttfb_ms).toBe(200);
    expect(payload.environment).toBe("production");
    expect(payload.release).toBe("1.2.3");
    expect(payload.url).toBe(window.location.href);
  });

  it("delivers whatever subset of metrics finished measuring, leaving the rest null", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("largest-contentful-paint").fire<FakeLcpEntry>([ { renderTime: 1800, loadTime: 0 } ]);
    // No layout-shift/event/paint entries fired at all, and no real navigation entry either.

    hideThePage();

    const payload = deliverSpy.mock.calls[0]![0] as WebVitalsPayload;
    expect(payload.lcp_ms).toBe(1800);
    expect(payload.inp_ms).toBeNull();
    expect(payload.fcp_ms).toBeNull();
    expect(payload.ttfb_ms).toBeNull();
  });

  it("reports cls as a real 0, not null, when the browser supports layout-shift but none occurred", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].cls).toBe(0);
  });

  it("uses loadTime instead of renderTime for a cross-origin LCP entry with no Timing-Allow-Origin header", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("largest-contentful-paint").fire<FakeLcpEntry>([ { renderTime: 0, loadTime: 1200 } ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].lcp_ms).toBe(1200);
  });

  it("keeps only the last largest-contentful-paint entry, matching real LCP semantics", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("largest-contentful-paint").fire<FakeLcpEntry>([
      { renderTime: 1200, loadTime: 0 },
      { renderTime: 1800, loadTime: 0 },
    ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].lcp_ms).toBe(1800);
  });

  it("excludes a layout shift flagged hadRecentInput from CLS", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("layout-shift").fire<FakeLayoutShiftEntry>([ { value: 0.3, hadRecentInput: true, startTime: 100 } ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].cls).toBe(0);
  });

  it("accumulates shifts within the same session window, then starts a new one after a big gap", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    const observer = observerFor("layout-shift");
    // Same session (100ms apart, well under the 1s/5s window limits): 0.05 + 0.05 = 0.10.
    observer.fire<FakeLayoutShiftEntry>([ { value: 0.05, hadRecentInput: false, startTime: 0 } ]);
    observer.fire<FakeLayoutShiftEntry>([ { value: 0.05, hadRecentInput: false, startTime: 100 } ]);
    // A new session starts here (6s later, past the 5s window), so this is compared as its own
    // total (0.03), not added to the first session's 0.10; the largest session (0.10) wins.
    observer.fire<FakeLayoutShiftEntry>([ { value: 0.03, hadRecentInput: false, startTime: 6000 } ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].cls).toBeCloseTo(0.1);
  });

  it("keeps the largest single interaction duration observed as INP, a deliberate simplification of the real percentile algorithm", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("event").fire([ { duration: 80 }, { duration: 250 }, { duration: 40 } ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].inp_ms).toBe(250);
  });

  it("only reads the first-contentful-paint entry, ignoring first-paint", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    observerFor("paint").fire([ { name: "first-paint", startTime: 400 } ]);
    hideThePage();

    expect(deliverSpy.mock.calls[0]![0].fcp_ms).toBeNull();
  });

  it("delivers exactly once even if both visibilitychange and pagehide fire", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    hideThePage();
    window.dispatchEvent(new Event("pagehide"));

    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it("does not deliver on a visibilitychange that isn't a transition to hidden", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");

    installWebVitals(configuration, client);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(deliverSpy).not.toHaveBeenCalled();
  });
});

describe("uninstallWebVitals", () => {
  it("disconnects every observer and removes the page-hide listeners", () => {
    const configuration = newConfiguration();
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverWebVitals").mockResolvedValue("delivered");
    installWebVitals(configuration, client);

    uninstallWebVitals();
    hideThePage();

    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("is safe to call when nothing was installed", () => {
    expect(() => uninstallWebVitals()).not.toThrow();
  });
});
