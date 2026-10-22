import { RecordChangeOptions, buildChangePayload } from "./changes.js";
import { Breadcrumb, BreadcrumbBuffer, installBreadcrumbs, uninstallBreadcrumbs } from "./breadcrumbs.js";
import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { DeliveryQueue } from "./deliveryQueue.js";
import { EventBuilder } from "./eventBuilder.js";
import { PerformanceFlusher, installPerformance } from "./performanceFlusher.js";
import { Reporter } from "./reporter.js";
import { MetricBuffer } from "./metricBuffer.js";
import { SpanQueue, Trace, installHttpTracing, soleOpenTrace } from "./tracing.js";
import { installSessionReplay, uninstallSessionReplay } from "./sessionReplay.js";
import { installWebVitals, uninstallWebVitals } from "./webVitals.js";

export { Configuration };
export type { BacktraceFrame, EventPayload, StrictEventPayload } from "./eventBuilder.js";
export type { Breadcrumb, BreadcrumbLevel } from "./breadcrumbs.js";
export type { WebVitalsPayload } from "./webVitals.js";
export type { SessionReplayPayload } from "./sessionReplay.js";
export { Trace } from "./tracing.js";
export { withSql } from "./sqlStatement.js";
export { CHANGE_KINDS } from "./changes.js";
export type { ChangeKind, RecordChangeOptions } from "./changes.js";
export type { HttpSpan, RecordSpanOptions, SpanKind, SpanOptions, TraceScope } from "./tracing.js";

let configuration: Configuration | null = null;
let client: Client | null = null;
let reporter: Reporter | null = null;
let breadcrumbBuffer: BreadcrumbBuffer | null = null;
let performanceFlusher: PerformanceFlusher | null = null;
let stopPerformance: (() => void) | null = null;
let spanQueue: SpanQueue | null = null;
let metricBuffers: { custom: MetricBuffer; infrastructure: MetricBuffer } | null = null;
let stopHttpTracing: (() => void) | null = null;
const openTraces = new Set<Trace>();
let handlersInstalled = false;
let errorListener: ((event: ErrorEvent) => void) | null = null;
let rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null;
// A plain module-level variable, not a thread-local/AsyncLocalStorage the way the Node client
// needs (see that client's own comment on userStorage): a browser tab is inherently single-user,
// so there's no concurrent-request isolation problem here for a simple mutable variable to cause.
let currentUser: Record<string, unknown> | null = null;

function getConfiguration(): Configuration {
  if (configuration === null) {
    configuration = new Configuration();
  }
  return configuration;
}

function getClient(): Client {
  if (client === null) {
    client = new Client(getConfiguration());
  }
  return client;
}

function getBreadcrumbBuffer(): BreadcrumbBuffer {
  if (breadcrumbBuffer === null) {
    breadcrumbBuffer = new BreadcrumbBuffer(getConfiguration());
  }
  return breadcrumbBuffer;
}

function getPerformanceFlusher(): PerformanceFlusher {
  if (performanceFlusher === null) {
    performanceFlusher = new PerformanceFlusher(getConfiguration(), getClient());
  }
  return performanceFlusher;
}

/** The two metric buffers, created together on first use: independent of each other (a page may only ever call one), but cheap enough that creating both is simpler than tracking which. */
function getMetricBuffers(): { custom: MetricBuffer; infrastructure: MetricBuffer } {
  if (metricBuffers === null) {
    const config = getConfiguration();
    const client = getClient();
    metricBuffers = {
      custom: new MetricBuffer(config, (entries) => client.deliverMetrics(entries), () => config.metricFlushIntervalMs),
      infrastructure: new MetricBuffer(
        config,
        (entries) => client.deliverInfrastructureMetrics(entries),
        () => config.infrastructureMetricFlushIntervalMs,
      ),
    };
  }
  return metricBuffers;
}

function getSpanQueue(): SpanQueue {
  if (spanQueue === null) {
    spanQueue = new SpanQueue(getConfiguration(), getClient());
  }
  return spanQueue;
}

function getReporter(): Reporter {
  if (reporter === null) {
    const config = getConfiguration();
    const client = getClient();
    const deliveryQueue = new DeliveryQueue(config, client);
    reporter = new Reporter(config, new EventBuilder(config), deliveryQueue, getBreadcrumbBuffer(), client);
  }
  return reporter;
}

export interface InitOptions extends Partial<Configuration> {
  /** Install window.onerror/unhandledrejection listeners. Defaults to true. */
  installGlobalHandlers?: boolean;
}

/** Configure the client. Call once, as early as possible in the page's lifecycle. */
export function init(options: InitOptions = {}): Configuration {
  const config = getConfiguration();
  const { installGlobalHandlers, ...overrides } = options;

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in config)) {
      throw new TypeError(`Configuration has no property ${JSON.stringify(key)}`);
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }

  if ((installGlobalHandlers ?? true) && typeof window !== "undefined") {
    installGlobalErrorHandlers();
  }

  // Strict privacy records no breadcrumbs and no session replay at all (see strictPrivacy.ts).
  if (config.breadcrumbs && !config.strictPrivacy) {
    installBreadcrumbs(config, getBreadcrumbBuffer());
  } else if (config.strictPrivacy) {
    uninstallBreadcrumbs();
  }

  if (config.webVitals) {
    installWebVitals(config, getClient());
  }

  if (config.trackPerformance && stopPerformance === null) {
    stopPerformance = installPerformance(config, getPerformanceFlusher());
  }

  if (config.sessionReplay && !config.strictPrivacy) {
    installSessionReplay();
  } else if (config.strictPrivacy) {
    uninstallSessionReplay();
  }

  if (config.trackTracing && stopHttpTracing === null) {
    stopHttpTracing = installHttpTracing(config, openTraces);
  }

  return config;
}

/**
 * Distributed tracing: one flow's own call tree (a page load's data fetching, a checkout, a click
 * handler and what it triggered), sent to ForgeOps only when the whole thing took at least
 * `traceCaptureThresholdMs` (1s), so fast flows cost nothing on the wire. A request made inside the
 * trace carries a W3C `traceparent` header, so a backend reporting to ForgeOps continues the same
 * trace, and an error captured while it's open carries its trace id.
 *
 *     const order = await trace("checkout", async (t) => {
 *       const cart = await t.span("load cart", () => api.cart(), { kind: "http" });
 *       return t.span("charge", () => api.charge(cart), { data: { items: cart.length } });
 *     });
 *
 * Or hold the trace yourself across the flow and finish it when it ends:
 *
 *     const t = startTrace("checkout");
 *     ...
 *     t.finish();
 *
 * Every fetch or XMLHttpRequest made while exactly one trace is open is also recorded into it, as an
 * "http" span named "METHOD host", and gets the `traceparent` header (see
 * Configuration#propagateTraces and #tracePropagationTargets: same-origin requests only by default,
 * since a cross-origin request with it needs that server's CORS configuration to allow the header); `t.fetch()` and `t.httpSpan()` do the same
 * explicitly, under any span. Nesting is explicit: a span's callback receives the scope to nest
 * children under (a browser has no async-context storage), which stays correct across `await`s and
 * for children started in parallel. `trace()` finishes even if `fn` throws or rejects (the error
 * propagates unchanged). When tracing is off, or reporting isn't enabled, everything is a no-op that
 * still runs `fn`, so callers never check. Delivery is async and in-memory.
 */
export function trace<T>(name: string, fn: (trace: Trace) => T): T {
  const t = startTrace(name);
  let result: T;
  try {
    result = fn(t);
  } catch (error) {
    t.finish();
    throw error;
  }

  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        t.finish();
        return value;
      },
      (error: unknown) => {
        t.finish();
        throw error;
      },
    ) as T;
  }

  t.finish();
  return result;
}

/** Starts a trace you finish yourself with `finish()`: see `trace()`. Returns a disabled no-op trace when tracing is off or reporting isn't enabled. */
export function startTrace(name: string): Trace {
  const config = getConfiguration();
  if (!config.trackTracing || !config.isEnabled()) {
    return new Trace(name, config, null);
  }

  const queue = getSpanQueue();
  const t = new Trace(
    name,
    config,
    (payload) => queue.push(payload),
    (finished) => openTraces.delete(finished),
  );
  openTraces.add(t);
  return t;
}

/**
 * Records a named business metric (a sign-up, a purchase, anything you want to name), buffered and
 * flushed periodically as one batch rather than one network call per capture. `value` defaults to 1 so
 * a bare counter-style call needs no argument; pass one for a real magnitude
 * (`captureMetric("payment", 49)`); it may be negative (a refund). A no-op when reporting isn't enabled
 * (no DSN, or this environment isn't in `enabledEnvironments`), and a NaN or infinite value is dropped.
 * Nothing here is automatic, so there is no `trackMetrics` flag. A page can be torn down at any moment,
 * so a flow that ends on unload should `await flushMetrics()` first.
 */
export function captureMetric(name: string, value = 1): void {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  getMetricBuffers().custom.record({ metric_name: name, value, environment: config.environment, release: config.release ?? null });
}

/**
 * Records one infrastructure reading (anything your page measures about a machine) from one of your own
 * hosts. A browser has no hostname, so pass `{ hostname }` or set `serverName` in `init`: the server
 * skips a reading without one. Same buffered-batch delivery and no-op-when-disabled contract as
 * `captureMetric`.
 */
export function captureInfrastructureMetric(name: string, value: number, options: { hostname?: string } = {}): void {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  const hostname = options.hostname ?? config.serverName;
  if (!hostname) {
    // The endpoint requires one and skips a row without it: say so here instead of sending it.
    config.log("[forge-ops-tracker] dropped an infrastructure metric with no hostname: pass one or set serverName");
    return;
  }
  getMetricBuffers().infrastructure.record({ metric_name: name, value, hostname });
}

/**
 * Records one change to what your app is running: a feature flag flipped, a remote config value
 * updated, anything that could explain a shift in errors or performance. ForgeOps shows it on the
 * timeline next to the errors around it. `kind` is one of CHANGE_KINDS; anything else is sent as
 * "other". Sent right away, in the background: this returns immediately and never throws, even when
 * the request fails or the plan doesn't include change tracking. A no-op when reporting isn't enabled.
 *
 *     flags.on("change", (key, value, previous) => {
 *       recordChange("feature_flag", `${key} turned ${value ? "on" : "off"}`, { details: { key, from: previous, to: value } });
 *     });
 */
export function recordChange(kind: string, title: string, options: RecordChangeOptions = {}): void {
  try {
    const config = getConfiguration();
    if (!config.isEnabled()) {
      return;
    }
    const payload = buildChangePayload(config, kind, title, options);
    if (payload === null) {
      config.log("[forge-ops-tracker] dropped a change with no title");
      return;
    }
    // Deliberately not awaited: post() never rejects, and a flag callback shouldn't wait on the network.
    void getClient().deliverChange(payload);
  } catch (e) {
    const err = e as Error;
    getConfiguration().log(`[forge-ops-tracker] recordChange failed: ${err.name}: ${err.message}`);
  }
}

/** Delivers every buffered metric and infrastructure reading right now, instead of waiting for the next flush interval. */
export async function flushMetrics(): Promise<void> {
  if (metricBuffers === null) {
    return;
  }
  await Promise.all([metricBuffers.custom.flush(), metricBuffers.infrastructure.flush()]);
}

/** Resolves once every finished trace that is still queued has been delivered: call it before a flow that ends on page unload. */
export function flushSpans(): Promise<void> {
  return spanQueue?.flush() ?? Promise.resolve();
}

/**
 * Report an exception you've already caught. `user` defaults to whatever setUser() last set, if
 * anything; pass one explicitly to override that for this one report. Captured while exactly one
 * trace is open (see `trace()`), the event carries that trace's id, which is what links it to an
 * error the backend reported for the same request. Errors the page-level handlers catch go through
 * here too, so they carry it the same way.
 */
export function captureException(error: Error, context: Record<string, unknown> = {}, user: Record<string, unknown> | null = null): void {
  getReporter().report(error, context, user ?? currentUser, soleOpenTrace(openTraces)?.traceId ?? null);
}

/**
 * Manually attaches an affected user to every subsequently reported error, until changed or
 * cleared: `id`/`email`/`username` are all independently optional; call with no arguments (or an
 * empty object) to clear whatever was set, e.g. on logout.
 */
export function setUser(user: Record<string, unknown> = {}): void {
  currentUser = Object.keys(user).length > 0 ? { ...user } : null;
}

/**
 * Adds a custom breadcrumb to the trail alongside whatever the automatic sources are already
 * capturing (see breadcrumbs.ts), for anything specific to this app that none of them would
 * know to record, e.g. addBreadcrumb({ category: "auth", message: "user logged in" }). Works
 * even with Configuration#breadcrumbs turned off: that flag only gates the automatic sources,
 * not this. With Configuration#strictPrivacy on it records nothing.
 */
export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
  getBreadcrumbBuffer().add({ timestamp: new Date().toISOString(), ...breadcrumb });
}

/**
 * Records one timed call's duration, in milliseconds, under `transactionName`: tallied in-process
 * (count, total, max) and flushed every `performanceFlushIntervalMs` (60s) as one small aggregate
 * report per transaction, for the Performance page's per-transaction table, not one network call
 * per call. A no-op when `Configuration#trackPerformance` is false or reporting isn't enabled for
 * this environment.
 *
 * Every fetch and XMLHttpRequest is already timed automatically, under "METHOD host" (see
 * performanceFlusher.ts's installPerformance); this is for anything else you want on the Performance
 * page, e.g. a route change or a heavy render. Keep `transactionName` low-cardinality
 * ("route:/checkout", not one per item id): every distinct name is its own row. Separate from Web
 * Vitals, which measures how one page load felt.
 */
export function recordPerformance(transactionName: string, durationMs: number): void {
  getPerformanceFlusher().record(transactionName, durationMs);
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Runs `fn`, records how long it took under `transactionName` (see recordPerformance), and returns
 * whatever `fn` returned. If `fn` returns a promise, times until it settles (fulfilled or rejected)
 * and returns a promise resolving or rejecting the same way. Recorded even if `fn` throws (the
 * error propagates unchanged): a call that fails is exactly one worth seeing on the Performance
 * page.
 *
 *     const results = await timeTransaction("search", () => api.search(query));
 */
export function timeTransaction<T>(transactionName: string, fn: () => T): T {
  const startedAt = now();
  const record = (): void => recordPerformance(transactionName, now() - startedAt);

  let result: T;
  try {
    result = fn();
  } catch (error) {
    record();
    throw error;
  }

  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        record();
        return value;
      },
      (error: unknown) => {
        record();
        throw error;
      },
    ) as T;
  }

  record();
  return result;
}

/**
 * Delivers whatever has been tallied so far right now, instead of waiting for the next interval.
 * The buffered tallies are also flushed automatically when the page is hidden or closing, so this
 * is only for when you want them sent sooner than that.
 */
export function flushPerformance(): Promise<void> {
  return getPerformanceFlusher().flush();
}

/**
 * Covers the two cases that would otherwise vanish silently in a browser with no further wiring
 * needed: a synchronous exception that escaped every try/catch on the page, and a rejected
 * promise nobody attached a .catch() to. This is the browser equivalent of Node's
 * uncaughtExceptionMonitor/unhandledRejection pair (see sdks/node/src/index.js): window.onerror
 * and the "error"/"unhandledrejection" window events are the standard DOM mechanisms for exactly
 * this, verified directly against a real thrown error and a real rejected promise in a browser
 * environment before relying on them, not assumed from documentation alone.
 *
 * React and Next.js integrations (see integrations/react.tsx and integrations/nextjs.ts) catch
 * errors earlier and with more context (a component stack, a request) before they'd ever reach
 * these page-level fallbacks; this is the last-resort safety net underneath both, not a
 * replacement for either.
 */
function installGlobalErrorHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  errorListener = (event: ErrorEvent) => {
    const error = event.error instanceof Error ? event.error : new Error(event.message);
    captureException(error, { source: event.filename, line: event.lineno, column: event.colno });
  };
  rejectionListener = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    captureException(error);
  };

  window.addEventListener("error", errorListener);
  window.addEventListener("unhandledrejection", rejectionListener);
}

/** @internal not part of the public API: resets module state between test cases */
export function _resetForTesting(): void {
  if (typeof window !== "undefined") {
    if (errorListener) {
      window.removeEventListener("error", errorListener);
    }
    if (rejectionListener) {
      window.removeEventListener("unhandledrejection", rejectionListener);
    }
  }
  uninstallBreadcrumbs();
  uninstallWebVitals();
  uninstallSessionReplay();
  stopPerformance?.();
  stopPerformance = null;
  stopHttpTracing?.();
  stopHttpTracing = null;
  spanQueue?.discard();
  spanQueue = null;
  metricBuffers?.custom.discard();
  metricBuffers?.infrastructure.discard();
  metricBuffers = null;
  openTraces.clear();
  performanceFlusher?.discard();
  performanceFlusher = null;
  configuration = null;
  client = null;
  reporter = null;
  breadcrumbBuffer = null;
  handlersInstalled = false;
  currentUser = null;
  errorListener = null;
  rejectionListener = null;
}
