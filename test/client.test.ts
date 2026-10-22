import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function newConfiguration(dsn: string | null = "https://secret-key@tracker.example.com/api/v1/events"): Configuration {
  const config = new Configuration();
  config.dsn = dsn;
  return config;
}

describe("Client", () => {
  it("returns delivered on a successful response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const client = new Client(newConfiguration());

    expect(await client.deliver({ exception_class: "RuntimeError" } as never)).toBe("delivered");
  });

  it.each([400, 401, 403, 404, 413, 422])("returns rejected on a %i, which the server will never accept", async (status) => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status }));
    const client = new Client(newConfiguration());

    expect(await client.deliver({ exception_class: "RuntimeError" } as never)).toBe("rejected");
  });

  it.each([408, 429, 500, 502, 503])("returns failed on a %i, which may go through later", async (status) => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status }));
    const client = new Client(newConfiguration());

    expect(await client.deliver({ exception_class: "RuntimeError" } as never)).toBe("failed");
  });

  it("returns failed without throwing when the request throws a network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new Client(newConfiguration());

    await expect(client.deliver({ exception_class: "RuntimeError" } as never)).resolves.toBe("failed");
  });

  it("returns failed when there is no DSN configured", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const client = new Client(newConfiguration(null));

    expect(await client.deliver({ exception_class: "RuntimeError" } as never)).toBe("failed");
  });

  it("sends the api key as a bearer token, the payload as JSON, and keepalive: true", async () => {
    let capturedUri: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (uri: RequestInfo | URL, init?: RequestInit) => {
      capturedUri = uri;
      capturedInit = init;
      return new Response(null, { status: 202 });
    });
    const client = new Client(newConfiguration());

    await client.deliver({ exception_class: "RuntimeError", message: "boom" } as never);

    expect(capturedUri).toBe("https://tracker.example.com/api/v1/events");
    expect((capturedInit!.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(capturedInit!.body as string)).toEqual({
      exception_class: "RuntimeError",
      message: "boom",
    });
    expect(capturedInit!.keepalive).toBe(true);
  });

  it("deliverWebVitals posts to the web_vitals endpoint derived from the DSN", async () => {
    let capturedUri: RequestInfo | URL | undefined;
    globalThis.fetch = vi.fn(async (uri: RequestInfo | URL) => {
      capturedUri = uri;
      return new Response(null, { status: 202 });
    });
    const client = new Client(newConfiguration());

    const delivered = await client.deliverWebVitals({
      url: "https://example.com/",
      environment: "production",
      release: null,
      measured_at: "2026-01-01T00:00:00.000Z",
      lcp_ms: 1800,
      cls: 0.05,
      inp_ms: 120,
      fcp_ms: 900,
      ttfb_ms: 200,
    });

    expect(delivered).toBe("delivered");
    expect(capturedUri).toBe("https://tracker.example.com/api/v1/web_vitals");
  });

  it("deliverWebVitals returns failed when there is no DSN configured", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const client = new Client(newConfiguration(null));

    const delivered = await client.deliverWebVitals({
      url: "https://example.com/",
      environment: "production",
      release: null,
      measured_at: "2026-01-01T00:00:00.000Z",
      lcp_ms: null,
      cls: null,
      inp_ms: null,
      fcp_ms: null,
      ttfb_ms: null,
    });

    expect(delivered).toBe("failed");
  });
});
