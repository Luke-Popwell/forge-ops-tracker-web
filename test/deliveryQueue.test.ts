import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";
import { DeliveryQueue } from "../src/deliveryQueue.js";
import { EventPayload } from "../src/eventBuilder.js";

function newConfiguration(queueSize = 1): Configuration {
  const config = new Configuration();
  config.queueSize = queueSize;
  return config;
}

function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("DeliveryQueue", () => {
  it("delivers a pushed payload via the client on its background processing loop", async () => {
    const delivered: EventPayload[] = [];
    const client = { deliver: async (payload: EventPayload) => void delivered.push(payload) };

    const queue = new DeliveryQueue(newConfiguration(10), client as never);
    queue.push({ exception_class: "RuntimeError" } as EventPayload);

    await waitUntil(() => delivered.length === 1);
    expect(delivered[0]).toEqual({ exception_class: "RuntimeError" });
  });

  it("drops a payload without blocking when the queue is already full", async () => {
    // A client whose delivery never resolves, so nothing drains the queue and capacity stays
    // exactly at queueSize (1) for a deterministic full-queue test.
    const client = { deliver: () => new Promise<void>(() => {}) };
    const queue = new DeliveryQueue(newConfiguration(1), client as never);

    expect(queue.push({ n: 1 } as never)).toBe(true);

    // The first push may already have been picked up by the processing loop (draining the queue
    // before it observes "full"), so retry briefly rather than asserting on a single racy attempt.
    const deadline = Date.now() + 500;
    let secondPushResult = true;
    while (Date.now() < deadline) {
      secondPushResult = queue.push({ n: 2 } as never);
      if (!secondPushResult) break;
    }

    expect(secondPushResult).toBe(false);
  });

  it("recovers from the client throwing instead of resolving", async () => {
    const delivered: unknown[] = [];
    let callCount = 0;
    const client = {
      deliver: async (payload: EventPayload) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("boom");
        }
        delivered.push(payload);
      },
    };

    const queue = new DeliveryQueue(newConfiguration(10), client as never);
    queue.push({ n: 1 } as never); // rejects inside the processing loop; must not kill it
    queue.push({ n: 2 } as never);

    await waitUntil(() => delivered.length === 1);
    expect(delivered[0]).toEqual({ n: 2 });
  });

  it("an event the server rejects is dropped, logged once, and never sent again", async () => {
    const logs: string[] = [];
    const configuration = newConfiguration(10);
    configuration.logger = (message) => logs.push(message);
    const attempts: unknown[] = [];
    const client = {
      deliver: async (payload: EventPayload) => {
        attempts.push(payload);
        return attempts.length === 1 ? "rejected" : "delivered";
      },
    };

    const queue = new DeliveryQueue(configuration, client as never);
    queue.push({ n: 1 } as never);
    await waitUntil(() => logs.length === 1);
    queue.push({ n: 2 } as never);
    await waitUntil(() => attempts.length === 2);

    expect(attempts).toEqual([{ n: 1 }, { n: 2 }]);
    expect(logs).toEqual(["[forge-ops-tracker] the server rejected the event, dropping it"]);
  });

  it("a failed delivery logs nothing more and does not stop the events queued after it", async () => {
    const logs: string[] = [];
    const configuration = newConfiguration(10);
    configuration.logger = (message) => logs.push(message);
    const attempts: unknown[] = [];
    const client = {
      deliver: async (payload: EventPayload) => {
        attempts.push(payload);
        return attempts.length === 1 ? "failed" : "delivered";
      },
    };

    const queue = new DeliveryQueue(configuration, client as never);
    queue.push({ n: 1 } as never);
    queue.push({ n: 2 } as never);
    await waitUntil(() => attempts.length === 2);

    expect(attempts).toEqual([{ n: 1 }, { n: 2 }]);
    expect(logs).toEqual([]);
  });
});
