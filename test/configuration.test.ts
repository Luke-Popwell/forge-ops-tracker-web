import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = null;
  config.enabledEnvironments = new Set(["production", "staging"]);
  config.environment = "production";
  return config;
}

describe("Configuration", () => {
  it("extracts apiKey and a credential-free ingestionUri from the DSN", () => {
    const config = newConfiguration();
    config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

    expect(config.apiKey()).toBe("secret-key");
    expect(config.ingestionUri()).toBe("https://tracker.example.com/api/v1/events");
  });

  it("returns null for both when there is no DSN", () => {
    const config = newConfiguration();
    config.dsn = null;

    expect(config.apiKey()).toBeNull();
    expect(config.ingestionUri()).toBeNull();
  });

  it("returns null for both when the DSN is malformed", () => {
    const config = newConfiguration();
    config.dsn = "not a uri :: at all";

    expect(config.apiKey()).toBeNull();
    expect(config.ingestionUri()).toBeNull();
  });

  it("isEnabled is true with a valid DSN in an enabled environment", () => {
    const config = newConfiguration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    config.environment = "production";

    expect(config.isEnabled()).toBe(true);
  });

  it("isEnabled is false with no DSN configured", () => {
    const config = newConfiguration();
    config.dsn = null;

    expect(config.isEnabled()).toBe(false);
  });

  it("isEnabled is false when the DSN has no api key", () => {
    const config = newConfiguration();
    config.dsn = "https://tracker.example.com/api/v1/events";

    expect(config.isEnabled()).toBe(false);
  });

  it("isEnabled is false outside the configured enabledEnvironments", () => {
    const config = newConfiguration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    config.environment = "development";

    expect(config.isEnabled()).toBe(false);
  });

  it("defaults appOrigin from window.location.origin in a browser-like (jsdom) environment", () => {
    const config = new Configuration();
    expect(config.appOrigin).toBe(window.location.origin);
  });

  it("breadcrumbs/maxBreadcrumbs/webVitals default to true/30/true", () => {
    const config = new Configuration();

    expect(config.breadcrumbs).toBe(true);
    expect(config.maxBreadcrumbs).toBe(30);
    expect(config.webVitals).toBe(true);
  });

  it("webVitalsUri swaps the trailing /events for /web_vitals", () => {
    const config = newConfiguration();
    config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

    expect(config.webVitalsUri()).toBe("https://tracker.example.com/api/v1/web_vitals");
  });

  it("webVitalsUri is null with no DSN", () => {
    const config = newConfiguration();
    config.dsn = null;

    expect(config.webVitalsUri()).toBeNull();
  });

  it("performanceSamplesUri swaps the trailing events segment", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";

    expect(config.performanceSamplesUri()).toBe("https://tracker.example.com/api/v1/performance_samples");

    config.dsn = null;
    expect(config.performanceSamplesUri()).toBeNull();
  });
});

describe("trace propagation options", () => {
  it("default to same-origin requests only, and propagateTraces off turns the header off everywhere", () => {
    const config = new Configuration();
    expect(config.propagateTraces).toBe(true);
    expect(config.tracePropagationTargets).toBeUndefined();
    expect(config.propagatesTraceTo("api.example.com")).toBe(false);
    expect(config.propagatesTraceTo("app.example.com", true)).toBe(true);

    config.tracePropagationTargets = ["example.com"];
    expect(config.propagatesTraceTo("api.example.com")).toBe(true);
    expect(config.propagatesTraceTo("thirdparty.io")).toBe(false);
    expect(config.propagatesTraceTo("localhost", true)).toBe(true); // same-origin, whatever the list says

    config.propagateTraces = false;
    expect(config.propagatesTraceTo("api.example.com")).toBe(false);
    expect(config.propagatesTraceTo("localhost", true)).toBe(false);
  });

  it("a string matches the host or a subdomain on a dot boundary ignoring case and a leading dot; a RegExp is tested against the host", () => {
    const config = new Configuration();
    config.tracePropagationTargets = [".Example.com", /^10\.0\./g];

    expect(config.propagatesTraceTo("example.com")).toBe(true);
    expect(config.propagatesTraceTo("API.example.com")).toBe(true);
    expect(config.propagatesTraceTo("badexample.com")).toBe(false);
    expect(config.propagatesTraceTo("example.com.evil.net")).toBe(false);
    // Twice: a /g pattern's lastIndex must not make the second test fail.
    expect(config.propagatesTraceTo("10.0.2.2")).toBe(true);
    expect(config.propagatesTraceTo("10.0.2.2")).toBe(true);
    expect(config.propagatesTraceTo("192.168.0.1")).toBe(false);

    config.tracePropagationTargets = ["", "."];
    expect(config.propagatesTraceTo("example.com")).toBe(false);
    config.tracePropagationTargets = [];
    expect(config.propagatesTraceTo("example.com")).toBe(false);
  });
});
