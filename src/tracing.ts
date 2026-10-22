import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { addNetworkListener, isOwnRequest, NetworkOutgoing } from "./networkInstrumentation.js";
import { mask } from "./sqlStatement.js";
import { spanData as strictSpanData, spanName as strictSpanName } from "./strictPrivacy.js";

/** The closed set of span kinds the ingestion API accepts; anything else is sent as "other". */
export type SpanKind = "controller" | "service" | "database" | "redis" | "http" | "job" | "other";

const KINDS: ReadonlySet<string> = new Set(["controller", "service", "database", "redis", "http", "job", "other"]);
const MAX_SPANS = 500;
const QUEUE_LIMIT = 100;

/** The W3C Trace Context header (https://www.w3.org/TR/trace-context/), the same one gems/forge_ops_tracker reads and writes. */
export const TRACEPARENT_HEADER = "traceparent";

export interface SpanOptions {
  /** One of controller, service, database, redis, http, job, other (default "service"). Anything else is sent as "other": the server rejects a whole trace over one unknown kind. */
  kind?: SpanKind | (string & {});
  data?: Record<string, unknown>;
  /**
   * For a "database" span only: the SQL it ran (a local SQLite query, say). Sent as `db.statement`
   * with every string and number literal replaced by "?" first, so values never leave the process;
   * ignored on any other kind.
   */
  statement?: string;
  /** For a "database" span only: which database it was, sent lowercased as `db.system` ("sqlite", "postgresql", ...). */
  dbSystem?: string;
}

export interface RecordSpanOptions extends SpanOptions {
  /** When the work started: a Date or epoch milliseconds. */
  startedAt: Date | number;
  durationMs: number;
}

export interface SpanPayload {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: string;
  duration_ms: number;
  environment: string;
  release: string | null;
  data: Record<string, unknown>;
}

export interface TracePayload {
  trace_id: string;
  spans: SpanPayload[];
}

/**
 * Something spans can be recorded under: a whole [Trace] (spans then parent under its root) or the
 * scope a [span] callback receives (spans then parent under that span). Browser JS has no
 * async-context storage (unlike sdks/node's AsyncLocalStorage), so nesting is explicit: a span's
 * callback is handed the scope to nest children under, which stays correct across `await`s and
 * for children started in parallel.
 */
export interface TraceScope {
  /**
   * Times `fn` as a span under this scope and returns whatever `fn` returned. If `fn` returns a
   * promise, times until it settles and returns a promise settling the same way. Recorded even if
   * `fn` throws or rejects (the error propagates unchanged). `fn` receives the scope to nest
   * children under.
   */
  span<T>(name: string, fn: (scope: TraceScope) => T, options?: SpanOptions): T;

  /** Records a span you timed yourself under this scope. */
  recordSpan(name: string, options: RecordSpanOptions): void;

  /**
   * Starts an "http" span under this scope for one request you make yourself, with any HTTP
   * client, and returns the `traceparent` header to send with it: its parent id is this span's
   * own id, so a backend that continues the trace nests its spans under this call. Call `end()`
   * when the response arrives (or the request fails).
   */
  httpSpan(method: string, url: string): HttpSpan;

  /**
   * Calls `fetch` with the `traceparent` header added (a `traceparent` already in `init.headers`,
   * or on a Request, is left alone), recording the call as an "http" span under this scope.
   * Resolves or rejects exactly as `fetch` does.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** One outgoing request's "http" span: see [TraceScope.httpSpan]. */
export interface HttpSpan {
  /**
   * `{ traceparent: "00-<trace id>-<span id>-01" }` to add to the request, or empty when the
   * header shouldn't go to this host (see Configuration#propagateTraces/tracePropagationTargets),
   * the URL is this client's own ForgeOps endpoint, or the trace is disabled or already finished.
   */
  readonly headers: Readonly<Record<string, string>>;

  /** Records the span with how long it has been since `httpSpan()`, and `status` if the request got a response. Idempotent. */
  end(status?: number): void;
}

const NOOP_HTTP_SPAN: HttpSpan = Object.freeze({ headers: Object.freeze({}), end: () => {} });

// Requests the explicit API (httpSpan/fetch above) is already recording, so the automatic fetch/XHR
// recording below leaves them out instead of recording each twice: by the exact traceparent value
// httpSpan() handed out, and, for fetch(), by the call itself being in progress. The patched
// window.fetch (networkInstrumentation.ts) runs its beforeSend synchronously inside the fetch()
// call, so a depth counter around that one synchronous call identifies it even when no header was
// added.
const explicitTraceparents = new Set<string>();
let explicitFetchDepth = 0;

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(values);
  } else {
    // An environment without crypto.getRandomValues: an id only has to be unique within one
    // project's traces, not unpredictable, so Math.random is enough.
    for (let i = 0; i < bytes; i++) {
      values[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
}

// A W3C id must not be all zeros (the spec reserves that as invalid, and a receiver drops the whole
// header over it): vanishingly unlikely from 8 or 16 random bytes, but free to rule out.
function randomId(bytes: number): string {
  let id = randomHex(bytes);
  while (/^0+$/.test(id)) {
    id = randomHex(bytes);
  }
  return id;
}

interface RequestTarget {
  /** "api.example.com:8443": what a span is named after ("METHOD authority"). */
  authority: string;
  /** "api.example.com": what tracePropagationTargets is matched against. */
  host: string;
  /** Same protocol, host, and port as the page: such a request always gets the header (see Configuration#tracePropagationTargets). */
  sameOrigin: boolean;
}

/**
 * Where a request is going, resolving a relative URL ("/api/orders") against the page's own address
 * the way the browser itself does, since a same-origin call to the app's own backend is the one most
 * worth following. null for anything that isn't http(s) (a data: or blob: URL), or unparseable.
 */
function targetOf(url: string): RequestTarget | null {
  try {
    const location = (globalThis as { location?: { href?: string; origin?: string } }).location;
    const base = location?.href;
    const parsed = base ? new URL(url, base) : new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // URL#origin normalizes a default port away ("https://a.com:443" is "https://a.com"), the same
    // form location.origin takes, so comparing the two strings compares protocol, host, and port.
    const sameOrigin = typeof location?.origin === "string" && location.origin !== "null" && parsed.origin === location.origin;
    return { authority: parsed.host, host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"), sameOrigin };
  } catch {
    return null;
  }
}

/** The one open trace, or null when none or several are open: with several, nothing can tell which one the current work belongs to. */
export function soleOpenTrace(openTraces: ReadonlySet<Trace>): Trace | null {
  if (openTraces.size !== 1) {
    return null;
  }
  const [trace] = openTraces;
  return trace ?? null;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * A span's data, with a "database" span's SQL added as `db.statement` (masked) and `db.system`. A
 * `db.statement` passed in `data` directly is masked too, so raw SQL can never go out on a span.
 */
function spanData(options: SpanOptions): Record<string, unknown> | undefined {
  if (options.kind !== "database") {
    return options.data;
  }
  const data: Record<string, unknown> = { ...options.data };
  const system = options.dbSystem ?? data["db.system"];
  delete data["db.system"];
  const dbSystem = typeof system === "string" && system.trim() !== "" ? system.trim().toLowerCase() : undefined;
  if (dbSystem !== undefined) {
    data["db.system"] = dbSystem;
  }
  const raw = options.statement ?? data["db.statement"];
  delete data["db.statement"];
  const masked = typeof raw === "string" ? mask(raw, dbSystem) : null;
  if (masked !== null) {
    data["db.statement"] = masked;
  }
  return data;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function";
}

/**
 * One trace: a tree of timed spans (a screen load, a sign-in, a network round trip and what it
 * triggered) that is sent to ForgeOps only when the whole thing took at least
 * `traceCaptureThresholdMs` (1s), so fast flows cost nothing on the wire. Start one with
 * `startTrace()` or `trace()` in index.ts, never directly.
 *
 * Every fetch or XMLHttpRequest made while exactly one trace is open is also recorded into it as an
 * "http" span named "METHOD host" (never the path or query), through the same network patch
 * breadcrumbs and performance timing share: with two or more traces open at once there is no way to
 * know which one a request belongs to, so it is left out rather than guessed. That request also
 * carries a W3C `traceparent` header naming its span as the parent, so a backend reporting to
 * ForgeOps continues this trace; this client's own requests to ForgeOps never get one. When tracing
 * is off, or reporting isn't enabled, `startTrace()` returns a disabled trace on which everything is
 * a no-op.
 *
 * Ids are W3C Trace Context ids: 32 lowercase hex characters for the trace, 16 for each span.
 */
export class Trace implements TraceScope {
  /** This trace's W3C trace id: the one its `traceparent` headers carry and errors captured during it are sent with. */
  readonly traceId = randomId(16);
  private readonly rootSpanId = randomId(8);
  private readonly startedAtMs = Date.now();
  private readonly timerStart = now();
  private readonly spans: SpanPayload[] = [];
  private finished = false;

  constructor(
    private readonly name: string,
    private readonly configuration: Configuration,
    private readonly deliver: ((trace: TracePayload) => void) | null,
    private readonly onFinish: (trace: Trace) => void = () => {},
  ) {}

  get enabled(): boolean {
    return this.deliver !== null;
  }

  span<T>(name: string, fn: (scope: TraceScope) => T, options: SpanOptions = {}): T {
    return this.spanUnder(this.rootSpanId, name, fn, options);
  }

  recordSpan(name: string, options: RecordSpanOptions): void {
    this.recordUnder(this.rootSpanId, name, options);
  }

  httpSpan(method: string, url: string): HttpSpan {
    return this.httpSpanUnder(this.rootSpanId, method, url);
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.fetchUnder(this.rootSpanId, input, init);
  }

  /**
   * @internal Used by installHttpTracing below, just before an automatically recorded request goes
   * out: picks the span id the request is recorded under later, and adds the `traceparent` header
   * naming it, unless the app set its own (whoever set it explicitly knows better which trace the
   * call belongs to) or this host isn't a propagation target.
   */
  beginAutomaticHttp(request: NetworkOutgoing, host: string, sameOrigin = false): string {
    const spanId = randomId(8);
    if (request.header(TRACEPARENT_HEADER) === undefined && this.configuration.propagatesTraceTo(host, sameOrigin)) {
      request.setHeader(TRACEPARENT_HEADER, this.traceparent(spanId));
    }
    return spanId;
  }

  /** @internal Used by installHttpTracing below, once the request begun with beginAutomaticHttp() completes. */
  recordHttpSpan(spanId: string, name: string, startedAtMs: number, durationMs: number, data: Record<string, unknown>): void {
    if (this.deliver === null) {
      return;
    }
    this.store(this.build(spanId, this.rootSpanId, name, "http", startedAtMs, durationMs, data));
  }

  /**
   * Ends the trace and sends it if the root took long enough. Idempotent: a second call does
   * nothing, and spans recorded after it are dropped.
   */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.onFinish(this);
    if (this.deliver === null) {
      return;
    }

    const durationMs = now() - this.timerStart;
    if (durationMs < this.configuration.traceCaptureThresholdMs) {
      return;
    }
    this.deliver({
      trace_id: this.traceId,
      spans: [this.build(this.rootSpanId, null, this.name, "controller", this.startedAtMs, durationMs, undefined), ...this.spans],
    });
  }

  private spanUnder<T>(parentId: string, name: string, fn: (scope: TraceScope) => T, options: SpanOptions): T {
    if (this.deliver === null) {
      return fn(this);
    }

    const spanId = randomId(8);
    const startedAtMs = Date.now();
    const timerStart = now();
    const scope: TraceScope = {
      span: (childName, childFn, childOptions = {}) => this.spanUnder(spanId, childName, childFn, childOptions),
      recordSpan: (childName, childOptions) => this.recordUnder(spanId, childName, childOptions),
      httpSpan: (method, url) => this.httpSpanUnder(spanId, method, url),
      fetch: (input, init) => this.fetchUnder(spanId, input, init),
    };
    const record = (): void =>
      this.store(this.build(spanId, parentId, name, options.kind ?? "service", startedAtMs, now() - timerStart, spanData(options)));

    let result: T;
    try {
      result = fn(scope);
    } catch (error) {
      record();
      throw error;
    }

    if (isThenable(result)) {
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

  private recordUnder(parentId: string, name: string, options: RecordSpanOptions): void {
    if (this.deliver === null) {
      return;
    }
    const startedAtMs = options.startedAt instanceof Date ? options.startedAt.getTime() : options.startedAt;
    this.store(this.build(randomId(8), parentId, name, options.kind ?? "service", startedAtMs, options.durationMs, spanData(options)));
  }

  private httpSpanUnder(parentId: string, method: string, url: string): HttpSpan {
    if (this.deliver === null || this.finished) {
      return NOOP_HTTP_SPAN;
    }

    const spanId = randomId(8);
    const startedAtMs = Date.now();
    const timerStart = now();
    const target = targetOf(url);
    const upperMethod = method.toUpperCase();
    // "METHOD host", never the path or query, the same name the automatic recording gives a request.
    const name = target === null ? upperMethod : `${upperMethod} ${target.authority}`;
    const headers: Record<string, string> = {};
    if (target !== null && !isOwnRequest(this.configuration, url) && this.configuration.propagatesTraceTo(target.host, target.sameOrigin)) {
      headers[TRACEPARENT_HEADER] = this.traceparent(spanId);
      explicitTraceparents.add(headers[TRACEPARENT_HEADER]);
    }

    let ended = false;
    return {
      headers,
      end: (status?: number): void => {
        if (ended) {
          return;
        }
        ended = true;
        if (headers[TRACEPARENT_HEADER] !== undefined) {
          explicitTraceparents.delete(headers[TRACEPARENT_HEADER]);
        }
        this.store(this.build(spanId, parentId, name, "http", startedAtMs, now() - timerStart, status === undefined ? {} : { status }));
      },
    };
  }

  private fetchUnder(parentId: string, input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
    if (this.deliver === null || this.finished) {
      return fetch(input, init);
    }

    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const httpSpan = this.httpSpanUnder(parentId, init?.method ?? request?.method ?? "GET", url);
    const traceparent = httpSpan.headers[TRACEPARENT_HEADER];

    let finalInit = init;
    if (traceparent !== undefined && typeof Headers !== "undefined") {
      // Built from the Request's own headers when init has none: passing init.headers replaces a
      // Request's headers entirely, so they have to be carried over or they'd be lost.
      const headers = new Headers(init?.headers ?? request?.headers);
      if (!headers.has(TRACEPARENT_HEADER)) {
        headers.set(TRACEPARENT_HEADER, traceparent);
      }
      finalInit = { ...init, headers };
    }

    let pending: Promise<Response>;
    explicitFetchDepth++;
    try {
      pending = fetch(input, finalInit);
    } catch (error) {
      httpSpan.end();
      throw error;
    } finally {
      explicitFetchDepth--;
    }

    return pending.then(
      (response) => {
        httpSpan.end(response.status);
        return response;
      },
      (error: unknown) => {
        httpSpan.end();
        throw error;
      },
    );
  }

  /** Always "01" (sampled): whether this trace is sent is only decided when it finishes, long after the header has gone out. */
  private traceparent(spanId: string): string {
    return `00-${this.traceId}-${spanId}-01`;
  }

  private store(span: SpanPayload): void {
    if (!this.finished && this.spans.length < MAX_SPANS - 1) {
      this.spans.push(span); // leave room for the root
    }
  }

  private build(
    spanId: string,
    parentSpanId: string | null,
    name: string,
    kind: string,
    startedAtMs: number,
    durationMs: number,
    data: Record<string, unknown> | undefined,
  ): SpanPayload {
    return {
      span_id: spanId,
      parent_span_id: parentSpanId,
      name,
      kind: KINDS.has(kind) ? kind : "other",
      started_at: new Date(startedAtMs).toISOString(),
      duration_ms: Math.round(durationMs * 100) / 100,
      environment: this.configuration.environment,
      release: this.configuration.release ?? null,
      data: data ?? {},
    };
  }
}

/** A finished trace with strict privacy's rules applied to every span (see strictPrivacy.ts). */
export function strictTrace(trace: TracePayload): TracePayload {
  return { ...trace, spans: trace.spans.map((span) => ({ ...span, name: strictSpanName(span.name), data: strictSpanData(span.data) })) };
}

/**
 * Delivers finished traces to the spans endpoint, one at a time on an async loop, so finishing a
 * slow trace never blocks the caller on the network. Bounded: once QUEUE_LIMIT traces are waiting a
 * new one is dropped, since a flow slow enough to be traced must not also grow this app's memory.
 * In-memory only, like the error queue: a trace queued as the page is torn down can be lost, so a
 * page that ends a flow on unload should call flushSpans() first.
 */
export class SpanQueue {
  private queue: TracePayload[] = [];
  private processing: Promise<void> | null = null;

  constructor(
    private readonly configuration: Configuration,
    private readonly client: Client,
  ) {}

  push(trace: TracePayload): boolean {
    if (this.queue.length >= QUEUE_LIMIT) {
      this.configuration.log("[forge-ops-tracker] span queue full, dropping trace");
      return false;
    }
    // Strict privacy: network spans named by method and host only, data kept to the masked
    // statement and database system (see strictPrivacy.ts).
    this.queue.push(this.configuration.strictPrivacy ? strictTrace(trace) : trace);
    if (this.processing === null) {
      this.processing = this.drain();
    }
    return true;
  }

  /** Resolves once everything queued so far has been delivered (or has failed). */
  async flush(): Promise<void> {
    while (this.processing !== null) {
      await this.processing;
    }
  }

  discard(): void {
    this.queue = [];
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const trace = this.queue.shift()!;
      try {
        // One attempt each, whatever the outcome: a trace the server refuses is never sent again.
        if ((await this.client.deliverSpans(trace)) === "rejected") {
          this.configuration.log("[forge-ops-tracker] the server rejected the trace, dropping it");
        }
      } catch (e) {
        const err = e as Error;
        this.configuration.log(`[forge-ops-tracker] span worker error: ${err.name}: ${err.message}`);
      }
    }
    this.processing = null;
  }
}

interface AutomaticHttp {
  trace: Trace;
  spanId: string;
  authority: string;
}

/**
 * Records every fetch or XMLHttpRequest made while exactly one trace is open into that trace as an
 * "http" span, and adds its `traceparent` header: see [Trace]. The trace is chosen when the request
 * is sent, not when it completes, since that's when the header has to go out. This client's own
 * requests to ForgeOps never get either (networkInstrumentation.ts leaves them out of every
 * listener). Returns a function that stops it.
 */
export function installHttpTracing(configuration: Configuration, openTraces: ReadonlySet<Trace>): () => void {
  return addNetworkListener(
    configuration,
    ({ method, status, durationMs }, state) => {
      const pending = state as AutomaticHttp | undefined;
      if (pending === undefined) {
        return;
      }
      pending.trace.recordHttpSpan(pending.spanId, `${method} ${pending.authority}`, Date.now() - durationMs, durationMs, { status });
    },
    (request): AutomaticHttp | undefined => {
      if (explicitFetchDepth > 0) {
        return undefined;
      }
      const existing = request.header(TRACEPARENT_HEADER);
      if (existing !== undefined && explicitTraceparents.has(existing)) {
        return undefined;
      }
      const trace = soleOpenTrace(openTraces);
      const target = targetOf(request.url);
      if (trace === null || target === null) {
        return undefined;
      }
      return { trace, spanId: trace.beginAutomaticHttp(request, target.host, target.sameOrigin), authority: target.authority };
    },
  );
}
