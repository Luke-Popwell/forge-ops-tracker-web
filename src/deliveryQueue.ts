import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { EventPayload, StrictEventPayload } from "./eventBuilder.js";

/**
 * A small in-memory bounded queue drained by an async processing loop, so delivery never blocks
 * the caller that raised the error. Same approach as sdks/node/src/deliveryQueue.js and for the
 * same reason: a browser tab has no threads to hand this off to, but it is a long-running process
 * across many events (unlike PHP-FPM's one-request-then-gone lifetime), so async scheduling via
 * fetch's non-blocking I/O is the natural substitute. push() returns synchronously; delivery
 * happens over however many microtask/event-loop turns it takes.
 *
 * There's no fork-hazard equivalent to worry about here (no browser equivalent of Node's cluster
 * module or Puma/Gunicorn forking workers after the module is loaded), so unlike the Node client
 * this starts processing immediately on construction rather than lazily on first push: there's
 * no reason to defer it.
 */
export class DeliveryQueue {
  private configuration: Configuration;
  private client: Client;
  private queue: (EventPayload | StrictEventPayload)[] = [];
  private processing = false;

  constructor(configuration: Configuration, client: Client) {
    this.configuration = configuration;
    this.client = client;
  }

  push(payload: EventPayload | StrictEventPayload): boolean {
    const maxSize = Math.max(1, this.configuration.queueSize);
    if (this.queue.length >= maxSize) {
      this.configuration.log("[forge-ops-tracker] delivery queue full, dropping event");
      return false;
    }

    this.queue.push(payload);
    this.ensureProcessing();
    return true;
  }

  private ensureProcessing(): void {
    if (this.processing) {
      return;
    }
    this.processing = true;
    // Deliberately not awaited: this is the background loop itself; push() must return
    // synchronously regardless of how long delivery takes.
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const payload = this.queue.shift();
      if (!payload) {
        break;
      }
      try {
        // One attempt each, whatever the outcome: nothing is ever put back on the queue, so an
        // event the server refuses is dropped here and never sent again.
        if ((await this.client.deliver(payload)) === "rejected") {
          this.configuration.log("[forge-ops-tracker] the server rejected the event, dropping it");
        }
      } catch (e) {
        // Per-item, not wrapping the whole loop: one bad delivery must not stop every event
        // queued after it.
        const err = e as Error;
        this.configuration.log(`[forge-ops-tracker] delivery worker error: ${err.name}: ${err.message}`);
      }
    }
    this.processing = false;
  }
}
