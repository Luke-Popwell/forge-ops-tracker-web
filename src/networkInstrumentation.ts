import { Configuration } from "./configuration.js";

export interface NetworkCompletion {
  kind: "fetch" | "xhr";
  method: string;
  url: string;
  /** The response status, or null when the request never got one (a fetch that rejected: offline, DNS failure, aborted). */
  status: number | null;
  /** fetch: `response.ok` (2xx); xhr: a 2xx or 3xx status. Always false when `status` is null. */
  ok: boolean;
  durationMs: number;
}

/**
 * What a listener's `beforeSend` sees of a request about to go out: enough to decide whether to add
 * a header, and to add it. Header names are compared case-insensitively, as HTTP does.
 */
export interface NetworkOutgoing {
  kind: "fetch" | "xhr";
  method: string;
  url: string;
  /** A header the app set on this request (in fetch's init/Request, or with setRequestHeader()), or undefined if it set none. */
  header(name: string): string | undefined;
  setHeader(name: string, value: string): void;
}

/**
 * Called just before a request (never one of this client's own) is sent. Whatever it returns is
 * handed back to the same listener with that request's completion, so a listener can carry
 * per-request state (tracing's span id) from send to completion without a map of its own.
 */
export type NetworkBeforeSend = (request: NetworkOutgoing) => unknown;

type NetworkListener = (completion: NetworkCompletion, state?: unknown) => void;

interface XhrMeta {
  method: string;
  url: string;
  startedAt: number;
  headers: Map<string, string>;
}

// One patch of window.fetch and XMLHttpRequest shared by every automatic source that needs to see
// network requests (breadcrumbs.ts, performanceFlusher.ts, tracing.ts), not one patch each: wrapping them twice
// would work, but every additional layer is another place a request can be double-counted or a
// restore can put back the wrong function. The patch is installed when the first listener arrives
// and removed again when the last one leaves. Unlike sdks/reactnative's own equivalent, both are
// wrapped: a browser's fetch is native, not built on XMLHttpRequest, so neither sees the other's
// requests.
const listeners = new Map<NetworkListener, { configuration: Configuration; beforeSend: NetworkBeforeSend | undefined }>();
let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXhrSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

// A WeakMap, not a property stashed directly on the XMLHttpRequest instance: avoids adding any
// visible field to an object the host page's own code also holds a reference to and might
// enumerate or serialize, and it lets the entry get garbage-collected once the request itself
// does, with nothing here to explicitly clean up.
const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

/**
 * True for a request to this client's own ForgeOps endpoints (events, web_vitals, session_replays,
 * performance_samples): the DSN's ingestion URL with its trailing "events" dropped, so every sibling
 * endpoint under the same directory counts. Deliberately excluded from every automatic source:
 * otherwise each reported error, and each Web Vitals or performance flush, would itself leave a
 * breadcrumb and a tally behind, and a spike in errors would start drowning the very trail meant to
 * explain them.
 */
export function isOwnRequest(configuration: Configuration, url: string): boolean {
  const ingestionUri = configuration.ingestionUri();
  if (ingestionUri === null) {
    return false;
  }
  const base = ingestionUri.endsWith("/events") ? ingestionUri.slice(0, -"events".length) : ingestionUri;
  return url.startsWith(base);
}

function notify(
  meta: { method: string; url: string },
  kind: "fetch" | "xhr",
  status: number | null,
  ok: boolean,
  startedAt: number,
  states: Map<NetworkListener, unknown>,
): void {
  const completion: NetworkCompletion = { kind, method: meta.method, url: meta.url, status, ok, durationMs: Date.now() - startedAt };
  for (const [listener, { configuration }] of [...listeners]) {
    if (!isOwnRequest(configuration, meta.url)) {
      listener(completion, states.get(listener));
    }
  }
}

// Runs every listener's beforeSend for one outgoing request, skipping this client's own requests
// exactly as notify() does, and collects what each returned. Never lets a listener's failure stop
// the app's own request from going out.
function runBeforeSend(outgoing: NetworkOutgoing): Map<NetworkListener, unknown> {
  const states = new Map<NetworkListener, unknown>();
  for (const [listener, { configuration, beforeSend }] of [...listeners]) {
    if (!beforeSend || isOwnRequest(configuration, outgoing.url)) {
      continue;
    }
    try {
      states.set(listener, beforeSend(outgoing));
    } catch (e) {
      const err = e as Error;
      configuration.log(`[forge-ops-tracker] request instrumentation failed: ${err.name}: ${err.message}`);
    }
  }
  return states;
}

/**
 * Registers `listener` to be told about every completed request that isn't this client's own, and
 * `beforeSend` (if given) about each one just before it goes out. Returns a function that
 * unregisters both. A no-op outside a browser.
 */
export function addNetworkListener(configuration: Configuration, listener: NetworkListener, beforeSend?: NetworkBeforeSend): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  listeners.set(listener, { configuration, beforeSend });
  patch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unpatch();
    }
  };
}

function patch(): void {
  if (originalFetch !== null) {
    return;
  }

  const capturedFetch = window.fetch.bind(window);
  originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = request ? request.url : input.toString();

    // Runs synchronously, before this function's first await, so a caller that marks "this fetch
    // is mine" around its own synchronous fetch() call (tracing.ts's explicit t.fetch()) is still
    // marked while this runs.
    let finalInit = init;
    const states = runBeforeSend({
      kind: "fetch",
      method,
      url,
      header: (name) => fetchHeaders(finalInit, request)?.get(name) ?? undefined,
      setHeader: (name, value) => {
        // Built from the Request's own headers when init has none: passing init.headers replaces a
        // Request's headers entirely, so they have to be carried over or they'd be lost.
        const headers = fetchHeaders(finalInit, request) ?? new Headers();
        headers.set(name, value);
        finalInit = { ...finalInit, headers };
      },
    });

    const startedAt = Date.now();
    try {
      const response = await capturedFetch(input, finalInit);
      notify({ method, url }, "fetch", response.status, response.ok, startedAt, states);
      return response;
    } catch (e) {
      notify({ method, url }, "fetch", null, false, startedAt, states);
      throw e;
    }
  };

  const capturedOpen = XMLHttpRequest.prototype.open;
  originalXhrOpen = capturedOpen;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    xhrMeta.set(this, { method: method.toUpperCase(), url: url.toString(), startedAt: 0, headers: new Map() });
    // async ?? true: XMLHttpRequest.open()'s own spec default when the caller omits async
    // entirely, always passed through explicitly here since TS resolves a .call() against the
    // overload requiring it, not the shorter two-arg one.
    capturedOpen.call(this, method, url, async ?? true, username, password);
  };

  // Wrapped only to remember which headers the app set: XMLHttpRequest has no way to read a request
  // header back, and a beforeSend must be able to leave one the app chose alone (a traceparent it
  // set itself).
  const capturedSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  originalXhrSetRequestHeader = capturedSetRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
    xhrMeta.get(this)?.headers.set(name.toLowerCase(), value);
    capturedSetRequestHeader.call(this, name, value);
  };

  const capturedSend = XMLHttpRequest.prototype.send;
  originalXhrSend = capturedSend;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const meta = xhrMeta.get(this);
    if (meta) {
      const states = runBeforeSend({
        kind: "xhr",
        method: meta.method,
        url: meta.url,
        header: (name) => meta.headers.get(name.toLowerCase()),
        setHeader: (name, value) => {
          capturedSetRequestHeader.call(this, name, value);
          meta.headers.set(name.toLowerCase(), value);
        },
      });
      meta.startedAt = Date.now();
      this.addEventListener("loadend", () => {
        notify(meta, "xhr", this.status, this.status >= 200 && this.status < 400, meta.startedAt, states);
      });
    }
    capturedSend.call(this, body);
  };
}

/** The headers a fetch() call is about to send (init's, or else the Request's own), or null where the Headers class doesn't exist. */
function fetchHeaders(init: RequestInit | undefined, request: Request | null): Headers | null {
  if (typeof Headers === "undefined") {
    return null;
  }
  return new Headers(init?.headers ?? request?.headers);
}

function unpatch(): void {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  if (originalXhrOpen) {
    XMLHttpRequest.prototype.open = originalXhrOpen;
    originalXhrOpen = null;
  }
  if (originalXhrSend) {
    XMLHttpRequest.prototype.send = originalXhrSend;
    originalXhrSend = null;
  }
  if (originalXhrSetRequestHeader) {
    XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
    originalXhrSetRequestHeader = null;
  }
}
