import { describe, expect, it } from "vitest";
import { Breadcrumb, BreadcrumbBuffer } from "../src/breadcrumbs.js";
import { Configuration } from "../src/configuration.js";
import { Reporter } from "../src/reporter.js";

function enabledConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.enabledEnvironments = new Set(["production"]);
  config.environment = "production";
  return config;
}

function breadcrumbBufferWith(entries: Breadcrumb[]): BreadcrumbBuffer {
  const buffer = new BreadcrumbBuffer(enabledConfiguration());
  for (const entry of entries) {
    buffer.add(entry);
  }
  return buffer;
}

describe("Reporter", () => {
  it("builds and enqueues a payload when reporting is enabled, including the current breadcrumb trail", () => {
    const configuration = enabledConfiguration();
    const builtPayload = { exception_class: "RuntimeError" };
    const buildCalls: unknown[][] = [];
    const pushCalls: unknown[] = [];
    const eventBuilder = {
      build: (error: Error, context: unknown, breadcrumbs: unknown, replayId: unknown) => (
        buildCalls.push([error, context, breadcrumbs, replayId]), builtPayload
      ),
    };
    const deliveryQueue = { push: (payload: unknown) => pushCalls.push(payload) };
    const breadcrumb: Breadcrumb = { category: "console", message: "hi", level: "info", timestamp: "2026-01-01T00:00:00Z" };
    const breadcrumbs = breadcrumbBufferWith([breadcrumb]);

    const reporter = new Reporter(configuration, eventBuilder as never, deliveryQueue as never, breadcrumbs, {} as never);
    const error = new Error("boom");
    const context = { a: 1 };

    reporter.report(error, context);

    // replayId is null: sessionReplay is never installed in this test file, so
    // flushSessionReplay's own installed-check short-circuits to null regardless of the fake
    // client passed above.
    expect(buildCalls).toEqual([[error, context, [breadcrumb], null]]);
    expect(pushCalls).toEqual([builtPayload]);
  });

  it("passes the user through to the event builder", () => {
    const configuration = enabledConfiguration();
    const buildCalls: unknown[][] = [];
    const eventBuilder = {
      build: (error: Error, context: unknown, breadcrumbs: unknown, replayId: unknown, user: unknown) => (
        buildCalls.push([error, context, breadcrumbs, replayId, user]), {}
      ),
    };
    const deliveryQueue = { push: () => {} };

    const reporter = new Reporter(configuration, eventBuilder as never, deliveryQueue as never, breadcrumbBufferWith([]), {} as never);
    const error = new Error("boom");
    const user = { id: 42, email: "alice@example.com" };

    reporter.report(error, {}, user);

    expect(buildCalls).toEqual([[error, {}, [], null, user]]);
  });

  it("does nothing when reporting is disabled", () => {
    const configuration = enabledConfiguration();
    configuration.environment = "development"; // not in enabledEnvironments
    let pushCallCount = 0;
    const eventBuilder = { build: () => ({}) };
    const deliveryQueue = { push: () => (pushCallCount += 1) };

    new Reporter(configuration, eventBuilder as never, deliveryQueue as never, breadcrumbBufferWith([]), {} as never).report(new Error("boom"));

    expect(pushCallCount).toBe(0);
  });

  it("never throws even if building the event fails", () => {
    const configuration = enabledConfiguration();
    const eventBuilder = {
      build: () => {
        throw new Error("event builder exploded");
      },
    };
    const deliveryQueue = { push: () => {} };

    expect(() => {
      new Reporter(configuration, eventBuilder as never, deliveryQueue as never, breadcrumbBufferWith([]), {} as never).report(new Error("boom"));
    }).not.toThrow();
  });

  it("never throws even if enqueueing fails", () => {
    const configuration = enabledConfiguration();
    const eventBuilder = { build: () => ({}) };
    const deliveryQueue = {
      push: () => {
        throw new Error("queue exploded");
      },
    };

    expect(() => {
      new Reporter(configuration, eventBuilder as never, deliveryQueue as never, breadcrumbBufferWith([]), {} as never).report(new Error("boom"));
    }).not.toThrow();
  });
});
