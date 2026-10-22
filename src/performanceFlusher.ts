import { Client, MAX_FAILED_FLUSHES } from "./client.js";
import { Configuration } from "./configuration.js";
import { bucketFor } from "./histogramBucketer.js";
import { spanName } from "./strictPrivacy.js";
import { addNetworkListener } from "./networkInstrumentation.js";

interface Bucket {
  count: number;
  durationSumMs: number;
  maxDurationMs: number;
  histogram: Record<string, number>;
}

export interface PerformanceSample {
  transaction_name: string;
  environment: string;
  release: string | null;
  period_started_at: string;
  period_ended_at: string;
  request_count: number;
  duration_sum_ms: number;
  max_duration_ms: number;
  histogram: Record<string, number>;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Times work in-process, bucketed by transaction name (see recordPerformance/timeTransaction in
 * index.ts), and periodically flushes each distinct bucket as one small aggregate report, rather
 * than one network call per timed call. Ported from sdks/reactnative's own flusher (the same
 * TypeScript, one shared design), itself ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/performance_flusher.rb and sdks/go's port of it,
 * including the one thing those learned the hard way: see flush()'s own comment on why it subtracts
 * what it delivered instead of clearing the buckets.
 *
 * This is separate from Web Vitals (webVitals.ts), which measures how one page load felt (LCP, CLS,
 * INP, ...) and is sent once per page: this measures how long named work took, aggregated, on the
 * Performance page's per-transaction table.
 *
 * JavaScript is single-threaded, so there is no locking, but flush() awaits the network in the
 * middle, so record() calls do interleave with it: exactly the race the subtraction exists for.
 * A chain of setTimeout calls started on the first recorded duration and re-armed only while
 * something is left to send, so it never idles.
 */
export class PerformanceFlusher {
  private configuration: Configuration;
  private client: Client;
  private buckets = new Map<string, Bucket>();
  private periodStartedAt = new Date();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private discarded = false;
  private failedFlushes = 0;

  constructor(configuration: Configuration, client: Client) {
    this.configuration = configuration;
    this.client = client;
  }

  /** Does nothing (and starts no timer) when trackPerformance is off or reporting isn't enabled for this environment. */
  record(transactionName: string, durationMs: number): void {
    if (!this.configuration.trackPerformance || !this.configuration.isEnabled() || this.discarded) {
      return;
    }
    // Strict privacy: a raw path loses its ids, a route is kept (see strictPrivacy.ts).
    const name = this.configuration.strictPrivacy ? spanName(transactionName) : transactionName;

    const bucket = this.buckets.get(name) ?? { count: 0, durationSumMs: 0, maxDurationMs: 0, histogram: {} };
    bucket.count += 1;
    bucket.durationSumMs += durationMs;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
    // The distribution count/sum/max can't reconstruct: see histogramBucketer.ts for why the server
    // approximates a percentile from these bucket counts.
    const label = bucketFor(durationMs);
    bucket.histogram[label] = (bucket.histogram[label] ?? 0) + 1;
    this.buckets.set(name, bucket);

    this.ensureTimer();
  }

  /**
   * Snapshots the buffered buckets and delivers them as one batch. A failed delivery keeps every
   * bucket where it is, so the next flush's batch just grows instead of losing what was already
   * tallied: there's no other copy of this data anywhere. That holds for MAX_FAILED_FLUSHES flushes
   * in a row; the last of them drops the batch instead. A batch the server rejects (see client.ts)
   * is dropped at once: it would be refused again every time.
   *
   * Only exactly what this snapshot delivered (or dropped) is removed afterward, subtracted from
   * whatever is in each bucket by then, never the whole map cleared outright. record() keeps running while this
   * awaits the network, so a record() call for a transaction already in the snapshot, or a
   * brand-new one, can land in the exact window between the snapshot and delivery succeeding.
   * Clearing afterward, as if delivery had covered everything now in the map, would silently
   * discard that data forever. This is a real bug sdks/go had and fixed, and that
   * gems/forge_ops_tracker's reference implementation still has; see this package's own test for a
   * deterministic reproduction.
   *
   * A second call while one is already in flight does nothing, rather than delivering the same
   * snapshot twice.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buckets.size === 0) {
      return;
    }
    this.flushing = true;
    try {
      const periodEnd = new Date();
      const snapshot = new Map<string, Bucket>();
      for (const [name, bucket] of this.buckets) {
        snapshot.set(name, { ...bucket, histogram: { ...bucket.histogram } });
      }
      const samples: PerformanceSample[] = [...snapshot].map(([name, bucket]) => ({
        transaction_name: name,
        environment: this.configuration.environment,
        release: this.configuration.release,
        period_started_at: timestamp(this.periodStartedAt),
        period_ended_at: timestamp(periodEnd),
        request_count: bucket.count,
        duration_sum_ms: bucket.durationSumMs,
        max_duration_ms: bucket.maxDurationMs,
        histogram: bucket.histogram,
      }));

      const status = await this.client.deliverPerformanceSamples(samples);
      if (status === "failed") {
        this.failedFlushes += 1;
        if (this.failedFlushes < MAX_FAILED_FLUSHES) {
          return;
        }
      }
      this.failedFlushes = 0;
      if (status !== "delivered") {
        const reason = status === "failed" ? `${MAX_FAILED_FLUSHES} flushes in a row failed` : "the server rejected them";
        this.configuration.log(`[forge-ops-tracker] dropping ${samples.length} performance sample(s): ${reason}`);
      }

      for (const [name, sent] of snapshot) {
        const current = this.buckets.get(name);
        if (!current) {
          continue;
        }
        current.count = Math.max(0, current.count - sent.count);
        current.durationSumMs = Math.max(0, current.durationSumMs - sent.durationSumMs);
        for (const [label, count] of Object.entries(sent.histogram)) {
          const remaining = (current.histogram[label] ?? 0) - count;
          if (remaining > 0) {
            current.histogram[label] = remaining;
          } else {
            delete current.histogram[label];
          }
        }
        // maxDurationMs is deliberately left as whatever is currently on the bucket, sent or not:
        // unlike count/durationSumMs, a max can't be correctly "subtracted" back out (the true max
        // of what's left is anything at or below it, not knowable from the two numbers alone), and
        // leaving it never overstates the next period's own max, only potentially understates how
        // far back it was actually set.
        if (current.count === 0) {
          this.buckets.delete(name);
        }
      }
      this.periodStartedAt = periodEnd;
    } catch (e) {
      const err = e as Error;
      this.configuration.log(`[forge-ops-tracker] performance flush failed: ${err.name}: ${err.message}`);
    } finally {
      this.flushing = false;
    }
  }

  /** Stops the timer and drops every bucket without delivering anything. */
  discard(): void {
    this.discarded = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buckets.clear();
    this.failedFlushes = 0;
  }

  /** @internal not part of the public API: [count, durationSumMs, maxDurationMs] per transaction. */
  tallies(): Map<string, [number, number, number]> {
    return new Map([...this.buckets].map(([name, b]) => [name, [b.count, b.durationSumMs, b.maxDurationMs]]));
  }

  private ensureTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.flush().finally(() => {
        if (this.discarded) {
          return;
        }
        this.timer = null;
        if (this.buckets.size > 0) {
          this.ensureTimer();
        }
      });
    }, Math.max(1, this.configuration.performanceFlushIntervalMs));
  }
}

/**
 * The automatic sources: each completed fetch or XMLHttpRequest (see networkInstrumentation.ts) is
 * timed under "METHOD host", e.g. "GET api.example.com", not the full URL: a path with an id in it
 * would give every distinct id its own row, and a host is the granularity that is always
 * low-cardinality. This client's own delivery requests are excluded. And, since a tab that is
 * hidden or closing may never get another chance, the buffered tallies are flushed when the page
 * is hidden (visibilitychange, with pagehide as the fallback webVitals.ts also uses); the client's
 * fetch uses keepalive, so that delivery survives the page going away. Returns a function that
 * stops all of it.
 */
export function installPerformance(configuration: Configuration, flusher: PerformanceFlusher): () => void {
  const removeNetworkListener = addNetworkListener(configuration, ({ method, url, durationMs }) => {
    const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1];
    if (host) {
      flusher.record(`${method} ${host}`, durationMs);
    }
  });

  if (typeof document === "undefined" || typeof window === "undefined") {
    return removeNetworkListener;
  }

  const flushWhenHidden = (): void => {
    if (document.visibilityState === "hidden") {
      void flusher.flush();
    }
  };
  const flushOnPageHide = (): void => {
    void flusher.flush();
  };
  document.addEventListener("visibilitychange", flushWhenHidden);
  window.addEventListener("pagehide", flushOnPageHide);

  return () => {
    removeNetworkListener();
    document.removeEventListener("visibilitychange", flushWhenHidden);
    window.removeEventListener("pagehide", flushOnPageHide);
  };
}
