import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";
import { PerformanceFlusher, installPerformance } from "../src/performanceFlusher.js";

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  body: { samples: Record<string, unknown>[] };
}

function newConfiguration(overrides: Partial<Configuration> = {}): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";
  config.performanceFlushIntervalMs = 3_600_000; // tests flush by hand unless they say otherwise
  return Object.assign(config, overrides);
}

// A fetch stand-in that records every call and answers with the next queued status (202 once the
// queue runs out), optionally holding the response until the test releases it.
function stubFetch(statuses: number[] = []): { calls: FetchCall[]; hold: () => () => void } {
  const calls: FetchCall[] = [];
  let holdReleases: (() => void)[] = [];
  let holding = false;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
    if (holding) {
      await new Promise<void>((resolve) => holdReleases.push(resolve));
    }
    return new Response(null, { status: statuses.shift() ?? 202 });
  });
  return {
    calls,
    hold: () => {
      holding = true;
      return () => {
        holding = false;
        holdReleases.forEach((release) => release());
        holdReleases = [];
      };
    },
  };
}

function flusherFor(config: Configuration): PerformanceFlusher {
  return new PerformanceFlusher(config, new Client(config));
}

let flusher: PerformanceFlusher | null = null;

beforeEach(() => {
  flusher = null;
});

afterEach(() => {
  flusher?.discard();
  globalThis.fetch = originalFetch;
});

describe("PerformanceFlusher", () => {
  it("buckets by transaction name with count, sum, and max", () => {
    flusher = flusherFor(newConfiguration());

    flusher.record("GET /users/:id", 10);
    flusher.record("GET /users/:id", 30);
    flusher.record("POST /orders", 5);

    expect(flusher.tallies().get("GET /users/:id")).toEqual([2, 40, 30]);
    expect(flusher.tallies().get("POST /orders")).toEqual([1, 5, 5]);
  });

  it("record does nothing when trackPerformance is off, or when reporting isn't enabled for this environment", () => {
    const off = flusherFor(newConfiguration({ trackPerformance: false }));
    off.record("x", 10);
    expect(off.tallies().size).toBe(0);

    const development = flusherFor(newConfiguration({ environment: "development" }));
    development.record("x", 10);
    expect(development.tallies().size).toBe(0);
  });

  it("flush delivers one batch to performance_samples and empties the buckets", async () => {
    const fetchStub = stubFetch();
    flusher = flusherFor(newConfiguration({ release: "a1b2c3d" }));
    flusher.record("GET /users/:id", 10);
    flusher.record("GET /users/:id", 30);

    await flusher.flush();

    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]!.url).toBe("https://tracker.example.com/api/v1/performance_samples");
    const sample = fetchStub.calls[0]!.body.samples[0]!;
    expect(sample).toMatchObject({
      transaction_name: "GET /users/:id",
      request_count: 2,
      duration_sum_ms: 40,
      max_duration_ms: 30,
      environment: "production",
      release: "a1b2c3d",
    });
    expect(sample.period_started_at).toMatch(/Z$/);
    expect(flusher.tallies().size).toBe(0);
  });

  it("flush does nothing when there is nothing to send", async () => {
    const fetchStub = stubFetch();
    flusher = flusherFor(newConfiguration());

    await flusher.flush();

    expect(fetchStub.calls).toHaveLength(0);
  });

  it("a failed delivery keeps every bucket so the next flush carries more", async () => {
    const fetchStub = stubFetch([500, 202]);
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /x", 10);

    await flusher.flush();
    expect(flusher.tallies().get("GET /x")).toEqual([1, 10, 10]);

    flusher.record("GET /x", 20);
    await flusher.flush();

    expect(fetchStub.calls[1]!.body.samples[0]!.request_count).toBe(2);
    expect(flusher.tallies().size).toBe(0);
  });

  it.each([400, 401, 403, 413, 422])("a batch the server rejects with a %i is dropped and never sent again", async (status) => {
    const logs: string[] = [];
    const fetchStub = stubFetch([status]);
    flusher = flusherFor(newConfiguration({ logger: (message) => logs.push(message) }));
    flusher.record("GET /x", 10);

    await flusher.flush();
    expect(flusher.tallies().size).toBe(0);
    await flusher.flush(); // nothing left: no second delivery
    expect(fetchStub.calls).toHaveLength(1);

    flusher.record("GET /x", 20);
    await flusher.flush();

    expect(fetchStub.calls[1]!.body.samples[0]!.request_count).toBe(1);
    expect(logs).toEqual(["[forge-ops-tracker] dropping 1 performance sample(s): the server rejected them"]);
  });

  it("a record that lands while a rejected batch is in flight is kept", async () => {
    const fetchStub = stubFetch([403]);
    const release = fetchStub.hold();
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /x", 10);

    const flushing = flusher.flush();
    await vi.waitFor(() => expect(fetchStub.calls).toHaveLength(1));
    flusher.record("GET /x", 25);
    release();
    await flushing;

    expect(flusher.tallies().get("GET /x")).toEqual([1, 25, 25]);
  });

  it.each([
    ["a 5xx", [500, 502, 503, 504, 500]],
    ["a 408 or a 429", [408, 429, 408, 429, 408]],
  ])("keeps the batch through four failed flushes (%s), and the fifth in a row drops it", async (_label, statuses) => {
    const logs: string[] = [];
    const fetchStub = stubFetch([...statuses]);
    flusher = flusherFor(newConfiguration({ logger: (message) => logs.push(message) }));
    flusher.record("GET /x", 10);

    for (let i = 0; i < 4; i++) {
      await flusher.flush();
    }
    expect(flusher.tallies().get("GET /x")).toEqual([1, 10, 10]);
    expect(logs).toEqual([]);

    await flusher.flush(); // the fifth: gives up on the batch
    expect(flusher.tallies().size).toBe(0);
    await flusher.flush(); // nothing left: no sixth delivery

    expect(fetchStub.calls).toHaveLength(5);
    expect(logs).toEqual(["[forge-ops-tracker] dropping 1 performance sample(s): 5 flushes in a row failed"]);
  });

  it("a network failure keeps the batch, and a delivery in between resets the count of failed flushes", async () => {
    const calls: number[] = [];
    let failing = true;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(init!.body as string).samples[0].request_count);
      if (failing) {
        throw new TypeError("Network request failed");
      }
      return new Response(null, { status: 202 });
    });
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /x", 10);

    for (let i = 0; i < 4; i++) {
      await flusher.flush();
    }
    expect(flusher.tallies().get("GET /x")).toEqual([1, 10, 10]);

    failing = false;
    await flusher.flush();
    expect(flusher.tallies().size).toBe(0);

    failing = true;
    flusher.record("GET /x", 20);
    for (let i = 0; i < 4; i++) {
      await flusher.flush();
    }

    // Four failures after the delivery are not five in a row: the tally is still held.
    expect(flusher.tallies().get("GET /x")).toEqual([1, 20, 20]);
    expect(calls).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("a record that lands during delivery is never lost", async () => {
    // Deterministic reproduction of the race flush()'s own comment describes: the stubbed fetch
    // holds its response until this test has recorded again, guaranteeing record() runs strictly
    // between the snapshot and delivery succeeding.
    const fetchStub = stubFetch();
    const release = fetchStub.hold();
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /x", 10);

    const flushing = flusher.flush();
    expect(fetchStub.calls).toHaveLength(1); // delivery is genuinely in flight

    flusher.record("GET /x", 25); // same transaction, mid-delivery
    flusher.record("GET /new", 7); // a brand-new one, mid-delivery
    release();
    await flushing;

    expect(flusher.tallies().get("GET /x")).toEqual([1, 25, 25]);
    expect(flusher.tallies().get("GET /new")).toEqual([1, 7, 7]);
  });

  it("a second flush while one is in flight does nothing rather than delivering the same snapshot twice", async () => {
    const fetchStub = stubFetch();
    const release = fetchStub.hold();
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /x", 10);

    const first = flusher.flush();
    await flusher.flush(); // returns immediately: the first is still awaiting the network
    release();
    await first;

    expect(fetchStub.calls).toHaveLength(1);
  });

  it("the timer flushes on its own interval, and only while there is something to flush", async () => {
    vi.useFakeTimers();
    try {
      const fetchStub = stubFetch();
      flusher = flusherFor(newConfiguration({ performanceFlushIntervalMs: 50 }));

      flusher.record("GET /x", 10);
      await vi.advanceTimersByTimeAsync(60);
      expect(fetchStub.calls).toHaveLength(1);

      // Nothing recorded since: no timer is left running, so no further flush happens.
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchStub.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      flusher.record("GET /y", 10);
      await vi.advanceTimersByTimeAsync(60);
      expect(fetchStub.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discard cancels the timer and delivers nothing", async () => {
    vi.useFakeTimers();
    try {
      const fetchStub = stubFetch();
      flusher = flusherFor(newConfiguration({ performanceFlushIntervalMs: 50 }));
      flusher.record("GET /x", 10);

      flusher.discard();
      await vi.advanceTimersByTimeAsync(500);

      expect(fetchStub.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installPerformance", () => {
  // jsdom's XMLHttpRequest.send() really tries to reach the host it is given, and its own "loadend"
  // then arrives asynchronously, in the middle of some *later* test, recording a request nobody in
  // that test made. The tests here dispatch "loadend" themselves, so the real send is replaced with
  // a no-op that the instrumentation under test wraps instead.
  beforeEach(() => {
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function requestXhr(method: string, url: string): XMLHttpRequest {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.send();
    // The real "loadend" event only fires once a response actually arrives; dispatched here
    // directly to exercise the listener installed during send() without a real network round trip.
    xhr.dispatchEvent(new Event("loadend"));
    return xhr;
  }

  it("times each completed fetch under METHOD host, never the full URL", async () => {
    const config = newConfiguration();
    flusher = flusherFor(config);
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const stop = installPerformance(config, flusher);

    await fetch("https://api.example.com/orders/42");
    await fetch("https://api.example.com/orders/43?expand=items");
    await fetch("https://api.example.com:8443/charge", { method: "POST" });

    expect(flusher.tallies().get("GET api.example.com")?.[0]).toBe(2);
    expect(flusher.tallies().get("POST api.example.com:8443")?.[0]).toBe(1);
    stop();
  });

  it("times a fetch that rejects too: how long it took to fail is still a real duration", async () => {
    const config = newConfiguration();
    flusher = flusherFor(config);
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const stop = installPerformance(config, flusher);

    await expect(fetch("https://api.example.com/x")).rejects.toThrow(TypeError);

    expect(flusher.tallies().get("GET api.example.com")?.[0]).toBe(1);
    stop();
  });

  it("times each completed XMLHttpRequest the same way", () => {
    const config = newConfiguration();
    flusher = flusherFor(config);
    const stop = installPerformance(config, flusher);

    requestXhr("get", "https://api.example.com/orders/42");

    expect(flusher.tallies().get("GET api.example.com")?.[0]).toBe(1);
    stop();
  });

  it("never times this client's own delivery requests: events, web_vitals, session_replays, or performance_samples", async () => {
    const config = newConfiguration();
    flusher = flusherFor(config);
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const stop = installPerformance(config, flusher);

    for (const endpoint of ["events", "web_vitals", "session_replays", "performance_samples"]) {
      await fetch(`https://tracker.example.com/api/v1/${endpoint}`, { method: "POST" });
    }

    expect(flusher.tallies().size).toBe(0);
    stop();
  });

  it("flushes when the page is hidden, and when it is being hidden by pagehide", async () => {
    const fetchStub = stubFetch();
    const config = newConfiguration();
    flusher = flusherFor(config);
    const stop = installPerformance(config, flusher);
    flusher.record("GET /x", 10);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(fetchStub.calls).toHaveLength(0); // still visible: nothing to do

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchStub.calls).toHaveLength(1));
    // The fetch has been *called*, not finished: wait for the flush to finish delivering too, or the
    // next flush below would be ignored as a second one while the first is still in flight.
    await vi.waitFor(() => expect(flusher!.tallies().size).toBe(0));

    flusher.record("GET /y", 10);
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(fetchStub.calls).toHaveLength(2));
    stop();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("stopping it restores fetch and XMLHttpRequest, and removes the page listeners", async () => {
    const originalFetchRef = globalThis.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const config = newConfiguration();
    flusher = flusherFor(config);
    const fetchStub = stubFetch();
    const stubbed = globalThis.fetch;
    const stop = installPerformance(config, flusher);
    expect(globalThis.fetch).not.toBe(stubbed);

    stop();

    expect(globalThis.fetch).toBe(stubbed);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).toBe(originalSend);
    flusher.record("GET /x", 10);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(fetchStub.calls).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    globalThis.fetch = originalFetchRef;
  });
});

describe("PerformanceFlusher latency histogram", () => {
  it("delivers a count per latency bucket alongside count, sum, and max", async () => {
    const fetchStub = stubFetch();
    flusher = flusherFor(newConfiguration());
    for (const duration of [10, 40, 120, 700, 12000]) {
      flusher.record("GET /posts", duration);
    }

    await flusher.flush();

    const sample = fetchStub.calls[0]!.body.samples[0]!;
    expect(sample.histogram).toEqual({ "50": 2, "250": 1, "1000": 1, inf: 1 });
    const total = Object.values(sample.histogram as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(sample.request_count);
  });

  it("keeps histogram counts for the next flush when delivery fails", async () => {
    const fetchStub = stubFetch([500, 202]);
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /posts", 10);
    await flusher.flush();

    flusher.record("GET /posts", 300);
    await flusher.flush();

    expect(fetchStub.calls[1]!.body.samples[0]!.histogram).toEqual({ "50": 1, "500": 1 });
  });

  it("a histogram count recorded during delivery is sent on the next flush, not lost", async () => {
    const fetchStub = stubFetch();
    const release = fetchStub.hold();
    flusher = flusherFor(newConfiguration());
    flusher.record("GET /posts", 10);

    const flushing = flusher.flush();
    flusher.record("GET /posts", 300); // same transaction, mid-delivery
    flusher.record("GET /new", 5); // a brand-new one, mid-delivery
    release();
    await flushing;
    expect(fetchStub.calls[0]!.body.samples[0]!.histogram).toEqual({ "50": 1 });

    await flusher.flush();
    const second = Object.fromEntries(fetchStub.calls[1]!.body.samples.map((s) => [s.transaction_name, s]));
    expect(second["GET /posts"]!.histogram).toEqual({ "500": 1 });
    expect(second["GET /new"]!.histogram).toEqual({ "50": 1 });
  });
});
