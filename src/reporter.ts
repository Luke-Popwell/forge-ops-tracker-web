import { BreadcrumbBuffer } from "./breadcrumbs.js";
import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { DeliveryQueue } from "./deliveryQueue.js";
import { EventBuilder } from "./eventBuilder.js";
import { flushSessionReplay } from "./sessionReplay.js";

/**
 * Ties Configuration, EventBuilder, DeliveryQueue, BreadcrumbBuffer, and (when enabled) session
 * replay together into the one thing callers actually need: report an exception. Mirrors
 * sdks/node/src/reporter.js; never throws. An error reporter that itself throws while reporting
 * an error is the worst possible failure mode, so every path here is wrapped to guarantee this
 * never propagates back into the host page.
 */
export class Reporter {
  private configuration: Configuration;
  private eventBuilder: EventBuilder;
  private deliveryQueue: DeliveryQueue;
  private breadcrumbs: BreadcrumbBuffer;
  private client: Client;

  constructor(configuration: Configuration, eventBuilder: EventBuilder, deliveryQueue: DeliveryQueue, breadcrumbs: BreadcrumbBuffer, client: Client) {
    this.configuration = configuration;
    this.eventBuilder = eventBuilder;
    this.deliveryQueue = deliveryQueue;
    this.breadcrumbs = breadcrumbs;
    this.client = client;
  }

  report(error: Error, context: Record<string, unknown> = {}, user: Record<string, unknown> | null = null, traceId: string | null = null): void {
    try {
      if (!this.configuration.isEnabled()) {
        return;
      }

      // flushSessionReplay is itself a no-op returning null when sessionReplay was never
      // installed in the first place (see index.ts's own init()), so this is always safe to
      // call regardless of configuration; it kicks off the actual upload asynchronously and
      // returns the id to correlate against immediately, never making report() itself wait on it.
      if (this.configuration.strictPrivacy) {
        // No replay is uploaded or referenced, and no breadcrumbs go out (see strictPrivacy.ts).
        this.deliveryQueue.push(this.eventBuilder.buildStrict(error, context, user, traceId));
        return;
      }

      const replayId = flushSessionReplay(this.configuration, this.client);
      const payload = this.eventBuilder.build(error, context, this.breadcrumbs.all(), replayId, user, traceId);
      this.deliveryQueue.push(payload);
    } catch (e) {
      const err = e as Error;
      this.configuration.log(`[forge-ops-tracker] report failed: ${err.name}: ${err.message}`);
    }
  }
}
