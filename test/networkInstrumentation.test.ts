import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import { addNetworkListener, isOwnRequest, NetworkCompletion } from "../src/networkInstrumentation.js";

const originalFetch = globalThis.fetch;

// jsdom's XMLHttpRequest.send() really tries to reach the host it is given, and its own "loadend"
// then arrives asynchronously during some later test. Replaced with a no-op that the
// instrumentation under test wraps instead; these tests dispatch "loadend" themselves.
beforeEach(() => {
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function config(): Configuration {
  const c = new Configuration();
  c.dsn = "https://key@tracker.example.com/api/v1/events";
  return c;
}

describe("networkInstrumentation", () => {
  it("patches once for any number of listeners, and every listener sees every request", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const seenA: NetworkCompletion[] = [];
    const seenB: NetworkCompletion[] = [];
    const removeA = addNetworkListener(config(), (c) => seenA.push(c));
    const patched = globalThis.fetch;
    const removeB = addNetworkListener(config(), (c) => seenB.push(c));

    expect(globalThis.fetch).toBe(patched); // the second listener did not wrap it again
    await fetch("https://api.example.com/x");

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]).toMatchObject({ kind: "fetch", method: "GET", url: "https://api.example.com/x", status: 200, ok: true });
    removeA();
    removeB();
  });

  it("reports a rejected fetch with a null status, never ok, and still rethrows it", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const seen: NetworkCompletion[] = [];
    const remove = addNetworkListener(config(), (c) => seen.push(c));

    await expect(fetch("https://api.example.com/x")).rejects.toThrow(TypeError);

    expect(seen[0]).toMatchObject({ kind: "fetch", status: null, ok: false });
    remove();
  });

  it("classifies fetch ok as 2xx and xhr ok as 2xx or 3xx, matching what each API's own success means", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 }));
    const seen: NetworkCompletion[] = [];
    const remove = addNetworkListener(config(), (c) => seen.push(c));

    await fetch("https://api.example.com/x");
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/y");
    xhr.send();
    Object.defineProperty(xhr, "status", { value: 302 });
    xhr.dispatchEvent(new Event("loadend"));

    expect(seen[0]).toMatchObject({ kind: "fetch", status: 500, ok: false });
    expect(seen[1]).toMatchObject({ kind: "xhr", status: 302, ok: true });
    remove();
  });

  it("removing one listener leaves the other working; removing the last restores the originals", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const stubbed = globalThis.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const seenB: NetworkCompletion[] = [];
    const removeA = addNetworkListener(config(), () => {});
    const removeB = addNetworkListener(config(), (c) => seenB.push(c));

    removeA();
    await fetch("https://api.example.com/x");
    expect(seenB).toHaveLength(1);
    expect(globalThis.fetch).not.toBe(stubbed);

    removeB();
    expect(globalThis.fetch).toBe(stubbed);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
  });

  it("isOwnRequest matches every endpoint under the DSN's directory, and nothing else", () => {
    const c = config();

    for (const endpoint of ["events", "web_vitals", "session_replays", "performance_samples"]) {
      expect(isOwnRequest(c, `https://tracker.example.com/api/v1/${endpoint}`)).toBe(true);
    }
    expect(isOwnRequest(c, "https://tracker.example.com/other")).toBe(false);
    expect(isOwnRequest(c, "https://api.example.com/api/v1/events")).toBe(false);
    expect(isOwnRequest(new Configuration(), "https://tracker.example.com/api/v1/events")).toBe(false);
  });
});
