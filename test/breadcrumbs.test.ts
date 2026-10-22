import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBuffer, installBreadcrumbs, uninstallBreadcrumbs } from "../src/breadcrumbs.js";
import { Configuration } from "../src/configuration.js";

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  return config;
}

beforeEach(() => {
  uninstallBreadcrumbs();
});

describe("BreadcrumbBuffer", () => {
  it("keeps entries in the order they were added", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    buffer.add({ category: "console", message: "first", level: "info", timestamp: "t1" });
    buffer.add({ category: "console", message: "second", level: "info", timestamp: "t2" });

    expect(buffer.all().map((b) => b.message)).toEqual(["first", "second"]);
  });

  it("drops the oldest entry once maxBreadcrumbs is exceeded", () => {
    const config = newConfiguration();
    config.maxBreadcrumbs = 2;
    const buffer = new BreadcrumbBuffer(config);

    buffer.add({ category: "console", message: "one", level: "info", timestamp: "t1" });
    buffer.add({ category: "console", message: "two", level: "info", timestamp: "t2" });
    buffer.add({ category: "console", message: "three", level: "info", timestamp: "t3" });

    expect(buffer.all().map((b) => b.message)).toEqual(["two", "three"]);
  });

  it("reads maxBreadcrumbs freshly on every add, not just at construction", () => {
    const config = newConfiguration();
    config.maxBreadcrumbs = 1;
    const buffer = new BreadcrumbBuffer(config);
    buffer.add({ category: "console", message: "one", level: "info", timestamp: "t1" });

    config.maxBreadcrumbs = 5;
    buffer.add({ category: "console", message: "two", level: "info", timestamp: "t2" });

    expect(buffer.all()).toHaveLength(2);
  });

  it("adds nothing when maxBreadcrumbs is 0", () => {
    const config = newConfiguration();
    config.maxBreadcrumbs = 0;
    const buffer = new BreadcrumbBuffer(config);

    buffer.add({ category: "console", message: "one", level: "info", timestamp: "t1" });

    expect(buffer.all()).toEqual([]);
  });

  it("all() returns a copy, not the live internal array", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    buffer.add({ category: "console", message: "one", level: "info", timestamp: "t1" });

    const snapshot = buffer.all();
    snapshot.pop();

    expect(buffer.all()).toHaveLength(1);
  });

  it("clear() empties the buffer", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    buffer.add({ category: "console", message: "one", level: "info", timestamp: "t1" });

    buffer.clear();

    expect(buffer.all()).toEqual([]);
  });
});

describe("installBreadcrumbs", () => {
  afterEach(() => {
    uninstallBreadcrumbs();
  });

  it("is a no-op the second time, without double-wrapping console methods", () => {
    const config = newConfiguration();
    const buffer = new BreadcrumbBuffer(config);
    installBreadcrumbs(config, buffer);
    const afterFirstInstall = console.log;

    installBreadcrumbs(config, buffer);

    expect(console.log).toBe(afterFirstInstall);
  });

  describe("console breadcrumbs", () => {
    it("records a breadcrumb and still calls through to the original console method", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      installBreadcrumbs(config, buffer);

      console.log("hello", "world");

      expect(buffer.all()).toEqual([expect.objectContaining({ category: "console", message: "hello world", level: "info" })]);
      expect(logSpy).toHaveBeenCalledWith("hello", "world");
    });

    it("maps console.error/warn to the error/warning levels", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installBreadcrumbs(config, buffer);

      console.error("boom");
      console.warn("careful");

      expect(buffer.all().map((b) => b.level)).toEqual(["error", "warning"]);
    });
  });

  describe("navigation breadcrumbs", () => {
    it("records a breadcrumb when a SPA router calls history.pushState", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      installBreadcrumbs(config, buffer);

      history.pushState({}, "", "/somewhere-new");

      const entry = buffer.all().find((b) => b.category === "navigation");
      expect(entry?.message).toContain("/somewhere-new");
      history.pushState({}, "", "/"); // leave location as this test found it
    });

    it("records a breadcrumb when history.replaceState is called", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      installBreadcrumbs(config, buffer);

      history.replaceState({}, "", "/replaced");

      const entry = buffer.all().find((b) => b.category === "navigation");
      expect(entry?.message).toContain("/replaced");
      history.replaceState({}, "", "/");
    });

    it("registers a popstate listener for real back/forward navigation", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      const addEventListenerSpy = vi.spyOn(window, "addEventListener");

      installBreadcrumbs(config, buffer);

      expect(addEventListenerSpy).toHaveBeenCalledWith("popstate", expect.any(Function));
    });
  });

  describe("click breadcrumbs", () => {
    it("describes the clicked element by tag, id, and class", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      installBreadcrumbs(config, buffer);
      const button = document.createElement("button");
      button.id = "submit";
      button.className = "btn btn-primary";
      document.body.append(button);

      button.click();

      expect(buffer.all()).toEqual([expect.objectContaining({ category: "click", message: "button#submit.btn.btn-primary" })]);
      button.remove();
    });
  });

  describe("network breadcrumbs", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("records a fetch breadcrumb with the method, url, and response status", async () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
      installBreadcrumbs(config, buffer);

      await fetch("https://api.example.com/widgets", { method: "POST" });

      expect(buffer.all()).toEqual([
        expect.objectContaining({ category: "fetch", message: "POST https://api.example.com/widgets", level: "info" }),
      ]);
    });

    it("records an error-level breadcrumb for a non-ok response", async () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 }));
      installBreadcrumbs(config, buffer);

      await fetch("https://api.example.com/widgets");

      expect(buffer.all()[0]?.level).toBe("warning");
    });

    it("never breadcrumbs this client's own delivery requests, to avoid a reported error leaving a breadcrumb about itself", async () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
      installBreadcrumbs(config, buffer);

      await fetch(config.ingestionUri()!, { method: "POST" });

      expect(buffer.all()).toEqual([]);
    });

    it("records an XHR breadcrumb using the method/url captured at open() time", () => {
      const config = newConfiguration();
      const buffer = new BreadcrumbBuffer(config);
      installBreadcrumbs(config, buffer);

      const xhr = new XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/widgets");
      xhr.send();
      // The real "loadend" event only fires once a response actually arrives; dispatched here
      // directly to exercise the listener installed during send() without a real network round
      // trip, the same reason DeliveryQueue/Client tests never hit a real server either.
      xhr.dispatchEvent(new Event("loadend"));

      expect(buffer.all()).toEqual([expect.objectContaining({ category: "xhr", message: "GET https://api.example.com/widgets" })]);
    });
  });
});

describe("uninstallBreadcrumbs", () => {
  it("restores the original console methods", () => {
    const config = newConfiguration();
    const buffer = new BreadcrumbBuffer(config);
    const original = console.log;
    installBreadcrumbs(config, buffer);

    uninstallBreadcrumbs();

    expect(console.log).toBe(original);
  });

  it("is safe to call when nothing was installed", () => {
    expect(() => uninstallBreadcrumbs()).not.toThrow();
  });
});

describe("Configuration#breadcrumbs / maxBreadcrumbs defaults", () => {
  it("breadcrumbs defaults to true and maxBreadcrumbs defaults to 30", () => {
    const config = new Configuration();

    expect(config.breadcrumbs).toBe(true);
    expect(config.maxBreadcrumbs).toBe(30);
  });
});
