import { DeliveryStatus, MAX_FAILED_FLUSHES } from "./client.js";
import { Configuration } from "./configuration.js";

export const MAX_METRIC_ENTRIES = 1000;

/**
 * Collects individual captureMetric()/captureInfrastructureMetric() calls in-process and periodically
 * flushes them as one batch, rather than one network call per capture. Unlike PerformanceFlusher this
 * keeps a list of individually meaningful entries instead of summing them into buckets: a customer's
 * own purchase or signup is exactly the kind of thing they will want a genuinely accurate count/sum of
 * later, so the server stores one row per entry as-is. Ported from gems/forge_ops_tracker's
 * metric_buffer.rb and infrastructure_metric_buffer.rb, which are the same class twice; here it is one
 * class instantiated twice, told which delivery function and flush interval to use.
 *
 * Three deliberate differences from the Ruby buffers:
 *
 * - A flush snapshots the first N entries and, on success, removes exactly those N, instead of
 *   resetting the whole list. JavaScript is single-threaded, but flush() awaits the network in the
 *   middle, so record() calls really do interleave with it; an entry recorded then is kept for the next
 *   flush rather than lost.
 * - The buffer is capped at MAX_METRIC_ENTRIES, and once full further entries are dropped until a
 *   flush empties it: an endpoint that is down fails every flush, and an uncapped buffer would keep
 *   growing until the batch is given up on. Dropping the newest rather than the oldest keeps the entries
 *   a flush is delivering at the front of the array, which is what makes removing exactly them
 *   afterward exact.
 * - A NaN or infinite value is dropped at record time: JSON.stringify turns it into `null`, which the
 *   server would reject, taking the whole batch with it.
 *
 * The same chain of setTimeout calls as PerformanceFlusher, armed on the first capture and re-armed
 * after every flush (so a changed interval takes effect), and unref()'d where the runtime has such a
 * thing. A page can be torn down at any moment, so a flow that ends on unload should `await flushMetrics()`
 * first (see README.md).
 */
export class MetricBuffer {
  private entries: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private discarded = false;
  private failedFlushes = 0;

  constructor(
    private readonly configuration: Configuration,
    private readonly deliver: (entries: Record<string, unknown>[]) => Promise<DeliveryStatus>,
    private readonly intervalMs: () => number,
  ) {}

  /** Adds one entry (everything but recorded_at, which is stamped here); returns whether it was kept. */
  record(entry: Record<string, unknown>): boolean {
    const value = entry.value;
    if (this.discarded || typeof value !== "number" || !Number.isFinite(value)) {
      this.configuration.log("[forge-ops-tracker] dropped a metric with a non-numeric or non-finite value");
      return false;
    }
    if (this.entries.length >= MAX_METRIC_ENTRIES) {
      this.configuration.log("[forge-ops-tracker] metric buffer full, dropping a metric");
      return false;
    }

    this.entries.push({ ...entry, recorded_at: `${new Date().toISOString().slice(0, 19)}Z` });
    this.ensureTimer();
    return true;
  }

  /**
   * Delivers everything buffered so far as one batch. A failed delivery keeps every entry, until
   * MAX_FAILED_FLUSHES flushes in a row have failed: that one drops the batch. A batch the server
   * rejects (a plan without the feature answers 403) is dropped at once, since it would be refused
   * again every time. At most one flush runs at a time.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.entries.length === 0) {
      return;
    }
    this.flushing = true;
    try {
      const snapshot = this.entries.slice();
      const status = await this.deliver(snapshot);
      if (status === "failed") {
        this.failedFlushes += 1;
        if (this.failedFlushes < MAX_FAILED_FLUSHES) {
          return;
        }
      }
      this.failedFlushes = 0;
      if (status !== "delivered") {
        const reason = status === "failed" ? `${MAX_FAILED_FLUSHES} flushes in a row failed` : "the server rejected them";
        this.configuration.log(`[forge-ops-tracker] dropping ${snapshot.length} metric(s): ${reason}`);
      }
      // Exactly the entries just delivered or dropped: anything recorded while the request was in
      // flight sits after them and stays for the next flush.
      this.entries.splice(0, snapshot.length);
    } finally {
      this.flushing = false;
    }
  }

  /** Stops the timer and drops every entry without delivering anything. */
  discard(): void {
    this.discarded = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.entries = [];
    this.failedFlushes = 0;
  }

  /** @internal not part of the public API: how many entries are currently buffered. */
  get size(): number {
    return this.entries.length;
  }

  private ensureTimer(): void {
    if (this.timer !== null) {
      return;
    }
    const timer = setTimeout(() => {
      void this.flush().finally(() => {
        if (this.discarded) {
          return;
        }
        this.timer = null;
        if (this.entries.length > 0) {
          this.ensureTimer();
        }
      });
    }, Math.max(1, this.intervalMs()));
    // Node's Timeout has unref(); a browser's timer id is a plain number with no such thing, and
    // doesn't need one (there's no process to keep alive).
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }
}
