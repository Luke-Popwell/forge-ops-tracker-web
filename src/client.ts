import { Configuration } from "./configuration.js";
import { EventPayload, StrictEventPayload } from "./eventBuilder.js";
// import type: this and webVitals.ts/sessionReplay.ts import each other (each needs the real
// Client class), so this side has to be a type-only import, fully erased at compile time, to
// avoid an actual runtime circular dependency between the modules.
import type { WebVitalsPayload } from "./webVitals.js";
import type { SessionReplayPayload } from "./sessionReplay.js";
import type { PerformanceSample } from "./performanceFlusher.js";
import type { TracePayload } from "./tracing.js";
import type { ChangePayload } from "./changes.js";

/**
 * What became of one delivery. The three are told apart because the caller owes each a different
 * answer: "delivered" (any 2xx) is done; "rejected" (a 4xx other than 408 and 429) is a payload the
 * server will never take, so sending it again only repeats the refusal; "failed" (a network error,
 * a timeout, a 5xx, a 408 or a 429) may well go through later.
 */
export type DeliveryStatus = "delivered" | "rejected" | "failed";

/**
 * How many flushes in a row may fail before a flusher or buffer gives up on the batch it is holding
 * and starts clean, so an endpoint that stays down can't keep one batch growing for good.
 */
export const MAX_FAILED_FLUSHES = 5;

function statusFor(status: number): DeliveryStatus {
  if (status >= 200 && status < 300) {
    return "delivered";
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return "rejected";
  }
  return "failed";
}

/**
 * Delivers one payload over HTTP, either an error event or a Web Vitals measurement, sharing one
 * post() implementation. Every failure mode: a network error, a timeout, a non-2xx response, is
 * caught here and turned into a "rejected" or "failed" return rather than a thrown exception, since
 * a broken or unreachable tracker must never be able to break the host page. Uses the browser's global
 * fetch(), not a package dependency, the same reasoning as every other SDK in this repo (see
 * sdks/node/src/client.js): this has to work in any host app without adding an HTTP client
 * dependency of its own.
 */
export class Client {
  private configuration: Configuration;

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  deliver(payload: EventPayload | StrictEventPayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.ingestionUri(), payload);
  }

  deliverWebVitals(payload: WebVitalsPayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.webVitalsUri(), payload);
  }

  deliverSessionReplay(payload: SessionReplayPayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.sessionReplaysUri(), payload);
  }

  /**
   * Same delivery contract as deliver(), against the DSN's performance_samples endpoint (see
   * Configuration#performanceSamplesUri). `samples` is wrapped as {"samples": [...]}, the shape
   * Api::V1::PerformanceSamplesController expects.
   */
  deliverPerformanceSamples(samples: PerformanceSample[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.performanceSamplesUri(), { samples });
  }

  /**
   * Same delivery contract again, against the DSN's custom metrics and infrastructure metrics endpoints.
   * `entries` is wrapped as {"metrics": [...]}.
   */
  deliverMetrics(entries: Record<string, unknown>[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.customMetricsUri(), { metrics: entries });
  }

  deliverInfrastructureMetrics(entries: Record<string, unknown>[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.infrastructureMetricsUri(), { metrics: entries });
  }

  /**
   * Same delivery contract again, against the DSN's spans endpoint (see Configuration#spansUri).
   * `trace` is sent as-is: {"trace_id": ..., "spans": [...]}, the shape Api::V1::SpansController
   * expects.
   */
  deliverSpans(trace: TracePayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.spansUri(), trace);
  }

  /**
   * Same delivery contract again, against the DSN's changes endpoint (see Configuration#changesUri).
   * A 403 (a plan without change tracking) is just a "rejected" like any other 4xx, never logged here.
   */
  deliverChange(change: ChangePayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.changesUri(), change);
  }

  private async post(uri: string | null, payload: unknown): Promise<DeliveryStatus> {
    const apiKey = this.configuration.apiKey();
    if (!uri || !apiKey) {
      return "failed";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);

    // A keepalive request body is capped at about 64KB by the browser, and a fetch over that limit
    // rejects outright instead of sending: a big trace (up to 500 spans) is sent without keepalive.
    const body = JSON.stringify(payload);

    try {
      const response = await fetch(uri, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
        // A page unloading shouldn't have its own delivery cancelled by the browser's usual
        // navigation-abort behavior: keepalive lets this request outlive the page that started
        // it, within the browser's own body-size limit for keepalive requests (~64KB, well above
        // a single event or Web Vitals payload).
        keepalive: body.length < 60_000,
      });

      return statusFor(response.status);
    } catch (e) {
      const err = e as Error;
      this.configuration.log(`[forge-ops-tracker] delivery failed: ${err.name}: ${err.message}`);
      return "failed";
    } finally {
      clearTimeout(timeout);
    }
  }

  // Deliberately no navigator.sendBeacon fallback for the page-unload case: sendBeacon has no
  // way to set a request header, and the ingestion API only ever authenticates via the
  // Authorization header (see app/controllers/api/base_controller.rb); there's no query-param
  // or body-based auth path on the server to send the api_key through instead. A beacon request
  // would arrive unauthenticated and get rejected, so it isn't worth the false sense of reliability.
  // post()'s `keepalive: true` above is the real mechanism for surviving page teardown; it's
  // an actual fetch, so the Authorization header still applies normally.
}
