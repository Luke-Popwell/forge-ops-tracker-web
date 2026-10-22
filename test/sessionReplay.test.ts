import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";
import { flushSessionReplay, installSessionReplay, SessionReplayPayload, uninstallSessionReplay } from "../src/sessionReplay.js";

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  return config;
}

// The inverse of sessionReplay.ts's own arrayBufferToBase64 + CompressionStream("gzip"), so a
// test can inspect what actually got uploaded rather than treating the encoded string as opaque.
async function decodeRecording(payload: SessionReplayPayload): Promise<unknown> {
  const binary = atob(payload.recording);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // A ReadableStream built directly from the bytes, not Blob([bytes]).stream(); see
  // sessionReplay.ts's own gzipAndEncode for why this app avoids Blob#stream() at all.
  // Uint8Array<ArrayBuffer>, not the bare generic: see gzipAndEncode's own comment on why
  // TypeScript's DOM lib types need the more specific form here.
  const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = readable.pipeThrough(new DecompressionStream("gzip"));
  const json = await new Response(stream).text();
  return JSON.parse(json);
}

// Waits for whatever async chain flushSessionReplay's own fire-and-forget upload is running
// (CompressionStream is a real stream, not a same-tick microtask, so this polls rather than
// assuming a fixed number of ticks is always enough) to actually happen before a test inspects
// the result; flushSessionReplay itself only ever returns the id synchronously. Takes a plain
// predicate rather than the spy itself, sidestepping vitest's own MockInstance generic variance
// (a spy typed against this one specific method doesn't structurally satisfy a helper typed to
// accept any mock function) for a test-only helper that has no real need to be that generic.
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  uninstallSessionReplay();
  document.body.innerHTML = "";
});

describe("installSessionReplay/uninstallSessionReplay", () => {
  it("is idempotent: installing twice doesn't double-register observers", () => {
    expect(() => {
      installSessionReplay();
      installSessionReplay();
    }).not.toThrow();
  });

  it("uninstalling when never installed is a no-op, not an error", () => {
    expect(() => uninstallSessionReplay()).not.toThrow();
  });
});

describe("flushSessionReplay", () => {
  it("returns null when session replay was never installed", () => {
    const client = new Client(newConfiguration());
    expect(flushSessionReplay(newConfiguration(), client)).toBeNull();
  });

  it("returns a replay id once installed, and uploads a snapshot of the current document", async () => {
    document.body.innerHTML = "<p>hello world</p>";
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    const replayId = flushSessionReplay(newConfiguration(), client);

    expect(replayId).toEqual(expect.any(String));
    await waitUntil(() => deliverSpy.mock.calls.length > 0);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const payload = deliverSpy.mock.calls[0]![0];
    expect(payload.replay_id).toBe(replayId);
    expect(payload.page_url).toEqual(expect.any(String));

    const recording = (await decodeRecording(payload)) as { snapshot: { tag: string } };
    expect(recording.snapshot.tag).toBe("html");
  });

  it("a recording the server rejects is dropped, logged once, and never sent again", async () => {
    installSessionReplay();
    const logs: string[] = [];
    const configuration = newConfiguration();
    configuration.logger = (message) => logs.push(message);
    const client = new Client(configuration);
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("rejected");

    flushSessionReplay(configuration, client);

    await waitUntil(() => logs.length > 0);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["[forge-ops-tracker] the server rejected the session replay, dropping it"]);
  });

  it("masks every text node's content, preserving its length", async () => {
    document.body.innerHTML = "<p>secret data</p>";
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as { snapshot: unknown };
    expect(JSON.stringify(recording)).not.toContain("secret data");
    expect(JSON.stringify(recording)).toContain("••••••" /* "secret" -> 6 masked chars, at least */);
  });

  it("masks an input's current value as a fixed-length placeholder", async () => {
    document.body.innerHTML = '<input type="text" value="hunter2">';
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const json = JSON.stringify(await decodeRecording(deliverSpy.mock.calls[0]![0]));
    expect(json).not.toContain("hunter2");
    expect(json).toContain("••••••••");
  });

  it("never masks a password field's actual length, unlike free text", async () => {
    document.body.innerHTML = '<input type="password" value="x">';
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const json = JSON.stringify(await decodeRecording(deliverSpy.mock.calls[0]![0]));
    // Always the same fixed mask regardless of the real 1-character value, see
    // MASKED_INPUT_VALUE's own comment for why length itself is treated as sensitive here.
    expect(json).toContain("••••••••");
    expect(json).not.toContain('"x"');
  });

  // Typing changes an input's own live `value` IDL property, never the "value" HTML attribute
  // (which only ever reflects the field's *default* value, set once from markup); the
  // MutationObserver's own attributes:true option only ever fires for a real attribute change,
  // so without a dedicated capture path for this, a real user's keystrokes into a field would be
  // completely invisible to the recorder, not merely unmasked. Confirmed missing entirely before
  // liveFormFieldOverride/the input listener in observeInteractions were added.
  it("captures real typing into a text input as a masked value change, even though no value attribute is ever touched", async () => {
    document.body.innerHTML = '<input type="text">';
    installSessionReplay();
    const input = document.querySelector("input")!;
    input.value = "secret typed value";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");
    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as {
      events: Array<{ type: string; name?: string; value?: string | null }>;
    };
    const valueChange = recording.events.find((event) => event.type === "attributes" && event.name === "value");
    expect(valueChange?.value).toBe("••••••••");
    expect(JSON.stringify(recording)).not.toContain("secret typed value");
  });

  // The same underlying gap as above, but for the *snapshot* itself (taken at install, and again
  // at every later rebaseline; see rebaseline()) rather than a real-time mutation event: a field
  // whose live value was already set before a snapshot is ever taken (a controlled input a
  // framework had already filled in, say) needs that value serialized too, not just a value that
  // happens to change while the recorder is already watching.
  it("reflects a form field's already-current value in the snapshot itself, with no input/change event ever firing", async () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector("input")!;
    input.value = "already filled in before install";

    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");
    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as { snapshot: unknown };
    expect(JSON.stringify(recording.snapshot)).toContain("••••••••");
    expect(JSON.stringify(recording)).not.toContain("already filled in before install");
  });

  it("captures a checkbox's checked state via change, unmasked (not free text the way a value is)", async () => {
    document.body.innerHTML = '<input type="checkbox">';
    installSessionReplay();
    const checkbox = document.querySelector("input")! as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");
    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as {
      events: Array<{ type: string; name?: string; value?: string | null }>;
    };
    const checkedChange = recording.events.find((event) => event.type === "attributes" && event.name === "checked");
    expect(checkedChange?.value).toBe("");
  });

  it("captures a <select>'s chosen option via change, unmasked", async () => {
    document.body.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
    installSessionReplay();
    const select = document.querySelector("select")! as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");
    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as {
      events: Array<{ type: string; name?: string; value?: string | null }>;
    };
    const valueChange = recording.events.find((event) => event.type === "attributes" && event.name === "value");
    expect(valueChange?.value).toBe("b");
  });

  it("leaves an element opted out with data-forgeops-unmask unmasked, text and input value alike", async () => {
    document.body.innerHTML = '<div data-forgeops-unmask="true"><p>visible text</p><input value="visible-value"></div>';
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const json = JSON.stringify(await decodeRecording(deliverSpy.mock.calls[0]![0]));
    expect(json).toContain("visible text");
    expect(json).toContain("visible-value");
  });

  it("captures a DOM mutation made after installation", async () => {
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    const paragraph = document.createElement("p");
    paragraph.textContent = "added later";
    document.body.appendChild(paragraph);
    // MutationObserver callbacks fire on a microtask, not synchronously with the DOM change.
    await Promise.resolve();

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as { events: Array<{ type: string }> };
    expect(recording.events.some((event) => event.type === "childList")).toBe(true);
  });

  it("captures a click, at its reported coordinates", async () => {
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 42, clientY: 7 }));

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as {
      events: Array<{ type: string; x?: number; y?: number }>;
    };
    const click = recording.events.find((event) => event.type === "click");
    expect(click).toMatchObject({ x: 42, y: 7 });
  });

  it("captures a mousemove, at its reported coordinates", async () => {
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30 }));

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as {
      events: Array<{ type: string; x?: number; y?: number }>;
    };
    const move = recording.events.find((event) => event.type === "mousemove");
    expect(move).toMatchObject({ x: 15, y: 30 });
  });

  it("throttles mousemove: a burst of moves in quick succession only records one", async () => {
    installSessionReplay();
    const client = new Client(newConfiguration());
    const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

    for (let i = 0; i < 10; i++) {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: i, clientY: i }));
    }

    flushSessionReplay(newConfiguration(), client);
    await waitUntil(() => deliverSpy.mock.calls.length > 0);

    const recording = (await decodeRecording(deliverSpy.mock.calls[0]![0])) as { events: Array<{ type: string }> };
    expect(recording.events.filter((event) => event.type === "mousemove")).toHaveLength(1);
  });

  it("skips the upload entirely, without throwing, when CompressionStream isn't available", async () => {
    const original = globalThis.CompressionStream;
    // @ts-expect-error: deliberately simulating an older browser with no Compression Streams API
    delete globalThis.CompressionStream;
    try {
      installSessionReplay();
      const client = new Client(newConfiguration());
      const deliverSpy = vi.spyOn(client, "deliverSessionReplay").mockResolvedValue("delivered");

      const replayId = flushSessionReplay(newConfiguration(), client);
      await waitUntil(() => deliverSpy.mock.calls.length > 0);

      expect(replayId).toEqual(expect.any(String));
      expect(deliverSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.CompressionStream = original;
    }
  });
});
