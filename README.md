# @forge-ops/tracker-web

Browser/frontend error reporting client for [ForgeOps](https://getforgeops.net), written in
TypeScript. It runs in whatever executes in the browser (a React SPA, a Next.js app's
client-side rendering, or a plain page with no framework at all), capturing uncaught
errors, unhandled promise rejections, and explicitly reported exceptions, then delivers events to
ForgeOps over HTTP.

> For health or personal data, turn on [strict privacy](#strict-privacy): the SDK then sends only structured facts about each error (its type, stack trace, release and route), never the message, a raw path, breadcrumbs, or context you haven't allowed.

## Installation

```bash
npm install @forge-ops/tracker-web
```

## Configuration

Set a DSN (from a project's settings page in ForgeOps) explicitly at startup:

```ts
import * as forgeOpsTracker from "@forge-ops/tracker-web";

forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events",
  release: "...",
  environment: "production",
});
```

There's no environment-variable auto-detection here (`FORGE_OPS_DSN`): a browser bundle has no
single, bundler-agnostic way to read an environment variable at runtime (Vite's `import.meta.env`,
webpack's `DefinePlugin`, and a plain `<script>` tag all differ), so the DSN always has to be
passed to `init()` explicitly, typically already resolved by whatever your own build tooling does
for other public config values.

Call `init()` once, as early as possible in the page's lifecycle (ideally before any of your own
application code runs, so a crash during your own startup is still caught).

### Plain pages (no framework)

`init()` installs `window` listeners by default (`installGlobalHandlers: false` to opt out)
covering the two cases that would otherwise vanish silently:

- **`error`**: a synchronous exception that escaped every try/catch on the page.
- **`unhandledrejection`**: a rejected promise nobody attached a `.catch()` to.

```ts
forgeOpsTracker.init({ dsn: "..." }); // that's it: both are now covered
```

### React

```tsx
import { ForgeOpsErrorBoundary } from "@forge-ops/tracker-web/integrations/react";

<ForgeOpsErrorBoundary fallback={<p>Something went wrong.</p>}>
  <App />
</ForgeOpsErrorBoundary>;
```

Reports via `componentDidCatch`, after React has already committed the error boundary's fallback
state: a slow or failed report can never affect how fast the fallback UI appears.
`fallback` can also be a function receiving the caught `Error`, for a fallback that shows something
about what broke. Requires React 18+ (a peer dependency, not bundled).

**React error boundaries only catch errors thrown during rendering**, in lifecycle methods, and in
constructors of the tree below them: never in event handlers or async callbacks. An exception
your own `onClick` handler or a `fetch().catch()` callback catches (or doesn't) never reaches a
boundary at all; report those explicitly with `captureException()` at the catch site instead.

### Next.js

```ts
// instrumentation.ts
export { forgeOpsOnRequestError as onRequestError } from "@forge-ops/tracker-web/integrations/nextjs";
```

Next.js (App Router and Pages Router both, stable since Next.js 15) calls its own `onRequestError`
instrumentation hook for any error that reaches its top-level server-side handling: across
render, route handlers, server actions, and middleware. This covers all of those automatically,
with no further wiring needed once the instrumentation file is in place.

This only covers server-side Next.js errors. A client-side rendering error still needs
`ForgeOpsErrorBoundary` above, and Next.js's own `app/error.tsx`/`app/global-error.tsx`
conventions should call `captureException()` directly, for the same reason no framework
integration here can see an exception that never propagates as far as its own hook.

## Delivery: an async loop, plus `keepalive` for page teardown

`DeliveryQueue` here is an async processing loop, not a background thread: `push()` returns
immediately, and delivery happens over non-blocking `fetch()` calls without ever blocking the code
that raised the error. One browser-specific addition: every delivery request sets `fetch`'s
`keepalive: true`, so a request started right before the page navigates away or closes is still
given a chance to complete rather than being cancelled outright by browser navigation.
`navigator.sendBeacon` was deliberately **not** used for this instead: it has no way
to set a request header, and the ingestion API only ever authenticates via the `Authorization`
header (see `app/controllers/api/base_controller.rb`), so a beacon request would simply arrive
unauthenticated and get rejected. `keepalive: true` on a real `fetch()` call is the actual
mechanism that both survives teardown and still authenticates correctly.

## Identifying users

```ts
forgeOpsTracker.captureException(error, {}, { id: user.id, email: user.email });
```

Or `setUser()` to attach it to every subsequently reported error until changed or cleared,
rather than passing it to every `captureException()` call by hand:

```ts
forgeOpsTracker.setUser({ id: user.id, email: user.email });
// on logout:
forgeOpsTracker.setUser();
```

A plain module-level variable, not the thread-local/`AsyncLocalStorage` mechanisms the server-side
clients in this repo need: a browser tab is inherently single-user, so there's no concurrent-
request isolation problem here for a simple mutable variable to cause. `id`/`email`/`username` are
all independently optional. Shows up on an issue's own detail page, and as its own affected-users
count alongside the regular event count.

## `in_app` backtrace frames

Compared against `Configuration#appOrigin` (defaults to `window.location.origin`): a frame whose
URL doesn't start with `appOrigin`, or that includes a `/node_modules/` path segment even if it
does (a bundled dependency's source map can still carry that segment), is never marked `in_app`.

Backtrace parsing tries two known stack-trace shapes per line: V8's (`at name (url:line:col)`,
used by Chrome/Edge) and SpiderMonkey/JavaScriptCore's (`name@url:line:col`, used by Firefox/
Safari): both verified directly against real captured stack traces in real browsers before
relying on them, not assumed from documentation. A line matching neither is simply skipped rather
than raising or dropping the whole backtrace.

## PII scrubbing

By default, the message, backtrace, and any
context/tags you attach are scanned for likely personal data (email addresses, formatted
SSNs/credit cards, known API key/token formats, and anything under a suspiciously-named key) and
redacted before the payload ever leaves the browser. ForgeOps itself scrubs again on arrival
regardless, so this is a second, earlier layer, not the only one. The user attached via
`captureException`'s third argument or `setUser()` above is a deliberate exception: it's never
scrubbed, since redacting it would defeat the whole point of identifying users in the first place.

To disable it:

```ts
forgeOpsTracker.init({ dsn: "...", scrubPii: false });
```

## Strict privacy

For apps that can't let personal or health data (PII, PHI) leave the browser. With strict privacy
on, this client sends only structured facts about an error, never free text that could carry a
name, an email or a diagnosis:

```ts
forgeOpsTracker.init({
  dsn: "...",
  strictPrivacy: true,
  privacyAllowedFields: ["error_code", "feature"],
});
```

- An error event goes out without its message. It carries a `message_fingerprint` instead: a
  one-way hash of the message with its numbers, ids, emails and quoted values taken out, computed in the page, so errors
  still group the same way.
- No breadcrumbs (none are recorded, automatic or `addBreadcrumb()`), no SQL statement (even with
  `captureSqlStatement` on; the table and procedure names are still sent), and no `replay_id`.
- Session Replay is off, whatever `sessionReplay` says: nothing is recorded or uploaded.
- The user is sent as its `id` only, never `email` or `username`.
- Context and tags keep only the top-level keys listed in `privacyAllowedFields`, and only when the
  value is a string, number or boolean. With none listed, neither is sent.
- Traces: a network span is named by its method and host (`GET api.example.com`), a span named
  after a path follows the path rule below, and span data keeps only `db.statement` (already
  masked) and `db.system`.
- Web Vitals: the page URL is its scheme, its host (no credentials or port) and its path by the
  path rule below (`https://app.example.com/patients/:path`), never its query or fragment.
- A performance sample's transaction name that's a path follows the path rule below; any other name
  is kept.
- Paths: a route template (`/patients/:id/notes`, `/patients/{id}`, `/files/*path`) is kept as it
  is. A raw path keeps only its first segment, the rest becomes `:path`
  (`/patients/jane-doe/12` is `/patients/:path`), and a first segment holding a digit becomes `:id`.

The exception class, backtrace frames (file, line, function), release, environment and trace id are
unchanged, as are performance aggregates, metrics and recorded changes. Both options are set in
`init()` only: a browser bundle has no environment to read them from.

ForgeOps applies the same rules again on arrival when the project's own Strict privacy setting is
on, so a page running an older client, or one configured without this, still can't get text stored
for that project.

## Breadcrumbs

By default, `init()` also installs a bounded, in-order trail of whatever just happened in the
page: console output, navigation (including a client-side router's own `pushState`/`replaceState`
calls), clicks, and outgoing `fetch`/XHR requests, all captured automatically. Whatever's currently
in the trail is attached to the next reported error, with no wiring needed.

```ts
forgeOpsTracker.init({
  dsn: "...",
  breadcrumbs: false, // opt out of the automatic sources entirely
  maxBreadcrumbs: 50, // default 30
});
```

Add your own alongside the automatic ones, for anything specific to the app that none of them
would know to record:

```ts
forgeOpsTracker.addBreadcrumb({ category: "auth", message: "user logged in", level: "info" });
```

A ring buffer, not an unbounded log: the oldest entry is dropped once `maxBreadcrumbs` is
reached, so a long-lived single-page app session never grows this without bound. This client's own
delivery requests are never breadcrumbed, so a reported error never ends up leaving a breadcrumb
about itself.

## Performance monitoring

Times work and reports one small aggregate per transaction (how many times it ran, total and maximum
duration) every `performanceFlushIntervalMs` (60s by default), for the Performance page's
per-transaction table. Not one network call per timed call. **Separate from Web Vitals** (below),
which measures how one page load felt and is sent once per page; this measures how long named work
took. On by default; turn it all off with `trackPerformance: false`. Two sources:

Each aggregate also carries a small latency histogram (a count per fixed latency bucket: 50, 100,
250, 500, 1000, 2500, 5000 and 10000ms, plus an overflow bucket), so ForgeOps can show an
approximate p50/p95/p99 per transaction, not just an average. Percentiles are accurate to the width
of whichever bucket a duration falls into; the SDK never stores the individual durations.

- **Every `fetch` and `XMLHttpRequest`, automatically**, timed under `METHOD host` (e.g.
  `GET api.example.com`), never the full URL: a path with an id in it would give every distinct id
  its own row, and a host is the granularity that is always low-cardinality. A request that rejects
  (offline, DNS failure) is timed too: how long it took to fail is still a real duration. This
  client's own delivery requests (events, web vitals, session replays, performance samples) are
  never timed, and it shares one patch of `fetch`/`XMLHttpRequest` with the breadcrumb network source
  rather than wrapping them twice.
- **Your own**, for anything else you want on the Performance page, e.g. a route change or a heavy
  render. Keep names low-cardinality (`"route:/checkout"`, not one per item id):

```ts
const results = await forgeOpsTracker.timeTransaction("search", () => api.search(query));
forgeOpsTracker.recordPerformance("render:dashboard", elapsedMs); // or a duration you measured yourself
```

`timeTransaction` returns whatever the function returned; if that is a promise it times until the
promise settles (fulfilled or rejected). It records even if the function throws, and the error
propagates unchanged.

The timer is a `setTimeout` chain, started on the first recorded duration and re-armed only while
there is something left to send, so it never idles. A tab that is hidden or closing may never get
another chance, so the buffered tallies are also flushed when the page is hidden (`visibilitychange`,
with `pagehide` as the fallback Web Vitals also uses), and the client's `keepalive` fetch lets that
delivery survive the page going away. `forgeOpsTracker.flushPerformance()` sends them right now.

A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) keeps every
tally, so the next flush's window just grows; after 5 flushes in a row have failed, the batch is
dropped and the tallies start clean. A batch the server rejects (any other 4xx) is dropped at once
and never sent again. What a flush delivered
is *subtracted* from the tallies afterward, never the whole map cleared: a record that lands while
the network call is in flight would otherwise be silently discarded, a real bug `sdks/go` had and
fixed and that `gems/forge_ops_tracker`'s reference implementation still has. A deterministic test
pins this.

## Distributed tracing

One flow's own call tree (a checkout, a page's data fetching, a click handler and what it
triggered), shown as a span tree on ForgeOps. A trace is sent only when the whole flow took at least
`traceCaptureThresholdMs` (1000 by default), so fast flows cost nothing on the wire. On by default;
turn it off with `trackTracing: false`. A trace can continue into your backend: see "Following a
request into your backend" below.

```ts
import { trace, startTrace, flushSpans } from "@forge-ops/tracker-web";

const order = await trace("checkout", async (t) => {
  const cart = await t.span("load cart", () => api.cart(), { kind: "http" });
  return t.span("charge", () => api.charge(cart), { data: { items: cart.length } });
});

// Or hold the trace across the flow and finish it when it ends:
const t = startTrace("checkout");
t.recordSpan("render", { kind: "service", startedAt: started, durationMs: elapsed });
t.finish();
```

**Automatic:** every `fetch` and `XMLHttpRequest` made while exactly one trace is open is recorded
into it as an `http` span named `METHOD host` (never the path or query), through the same network
patch breadcrumbs and performance timing share. With two or more traces open at once there is no way
to know which one a request belongs to, so it is left out rather than guessed; this client's own
requests are never recorded. The request is attributed to a trace when it is sent. Everything else
is a span you add by hand.

A browser has no async-context storage (unlike `sdks/node`'s `AsyncLocalStorage`), so **nesting is
explicit**: a span's callback receives the scope to nest children under, which stays correct across
`await`s and for children started in parallel. `span` returns what its callback returned (a promise
if it returned one), records even when the callback throws or rejects, and `trace` finishes the same
way. `kind` is one of `controller`, `service`, `database`, `redis`, `http`, `job`, `other` (anything
else is sent as `other`, since the server rejects a whole trace over one unknown kind). A trace holds
at most 500 spans. When tracing is off or reporting isn't enabled, `startTrace` returns a disabled
trace on which everything is a no-op (the callback still runs), so callers never check. A trace you
start yourself must be finished, or it stays open and makes automatic attribution ambiguous.

Delivery is async and in-memory, like the error queue; a request over the browser's ~64KB `keepalive`
limit (a large trace) is sent without `keepalive` rather than rejected, so it will not survive the
page unloading. `await flushSpans()` before a flow that ends on unload.

### Database spans with their SQL

A `database` span can carry the SQL it ran (an in-browser SQLite query, say) and which database it
was. Every string and number literal is replaced by `?` before it leaves your process (so
`WHERE email = 'a@b.co'` is sent as `WHERE email = ?`), the statement is cut at 4000 characters, and
ForgeOps masks it again on arrival. It is sent in the span's data as `db.statement` and `db.system`,
and ForgeOps shows it on the span. Both options are ignored on any other kind.

Masking covers strings with `''` or backslash-escaped quotes (`'o\'brien'`), prefixed strings
(`E'...'`, `X'DEADBEEF'`, `N'...'`, `B'...'`, `U&'...'`), `$tag$` dollar-quoted bodies, and hex,
binary, exponent and leading-dot numbers (`0x1F`, `0b101`, `1.5E-3`, `.5`), but never the digits in
a name like `orders2` or a `$1` placeholder. With `dbSystem` set to `"mysql"` or `"mariadb"`,
`"double quoted"` values are masked too; for any other database they're names, and are left as
written.

```ts
const sql = "SELECT * FROM orders WHERE customer_id = 42 AND status = 'open'";
const orders = await t.span("Load orders", () => db.exec(sql), {
  kind: "database",
  statement: sql,
  dbSystem: "sqlite",
});
// Sent as db.statement "SELECT * FROM orders WHERE customer_id = ? AND status = ?", db.system "sqlite".
```

`recordSpan` takes the same `statement` and `dbSystem` options for a query you timed yourself.

### Following a request into your backend

Traces use the [W3C Trace Context](https://www.w3.org/TR/trace-context/) standard (ids are 32 and 16
lowercase hex characters), so a failed request in the page can be linked to the backend request it
caused:

- **Automatic:** every `fetch` and `XMLHttpRequest` made while exactly one trace is open gets a
  `traceparent: 00-<trace id>-<span id>-01` header whose span id is that request's own `http` span,
  so the backend's spans nest under it. By default only same-origin requests get it (see "Which
  requests get the header" below). A `traceparent` you set yourself is never replaced, and this
  client's own requests to ForgeOps never get one.
- **Explicit:** `t.fetch(input, init)` calls `fetch` with the header added and records the call as
  an `http` span; `t.httpSpan(method, url)` returns `{ headers, end(status?) }` for any other HTTP
  client. Both also work on the scope a `span` callback receives, nesting the call under that span.
- **Errors:** an error captured while exactly one trace is open (with `captureException`, or by the
  page-level `error`/`unhandledrejection` handlers) is sent with that trace's id (`t.traceId`),
  which is what connects it to the backend's error for the same request. An error captured outside
  a trace is sent exactly as before.

#### Which requests get the header

**By default, only same-origin requests**: same protocol, host, and port as the page, including
relative URLs like `/api/orders`. `traceparent` isn't one of the headers a browser sends cross-origin
without asking, so a cross-origin request carrying it is preflighted, and the browser blocks it
outright if that server's CORS configuration doesn't allow the header. Sending it everywhere would
break calls to any third-party API that doesn't, so a cross-origin request only gets the header when
you name its host. Cross-origin requests are still recorded as `http` spans either way.

If your API is on another origin (`https://api.example.com` behind a page on
`https://www.example.com`), list it in `tracePropagationTargets`. A request then gets the header
when it is same-origin **or** its host matches the list:

```ts
forgeOpsTracker.init({
  dsn: "...",
  tracePropagationTargets: ["api.example.com"],
});
```

Each host you list must allow the header in its CORS configuration, by adding `traceparent` to the
`Access-Control-Allow-Headers` it returns for the preflight (alongside whatever headers it already
allows), for example `Access-Control-Allow-Headers: Content-Type, Authorization, traceparent`.
Otherwise the browser blocks those requests.

```ts
import { startTrace, captureException } from "@forge-ops/tracker-web";

async function placeOrder(cart: Cart): Promise<void> {
  const t = startTrace("Checkout");
  try {
    const response = await t.fetch("https://api.example.com/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cart),
    });
    if (!response.ok) {
      throw new Error(`Checkout failed with ${response.status}`);
    }
  } catch (error) {
    captureException(error as Error, { cartId: cart.id }); // sent with t.traceId
    throw error;
  } finally {
    t.finish();
  }
}
```

The backend must also report to ForgeOps (the Ruby, Python, and Node SDKs continue the trace
automatically), and the two projects must be linked in ForgeOps to see the page's error and the
backend's error connected.

Both options together:

```ts
forgeOpsTracker.init({
  dsn: "...",
  propagateTraces: false, // never send traceparent, not even same-origin (default true)

  // Default undefined: same-origin requests only. Listed hosts get it too: a string matches that
  // host and its subdomains on a dot boundary ("example.com" matches "api.example.com", not
  // "badexample.com"); a RegExp is tested against the host, without the port.
  tracePropagationTargets: ["api.example.com", /^api-[a-z]+\.example\.net$/],
});
```

Both apply to the explicit `t.fetch`/`t.httpSpan` as well; the `http` span is still recorded when no
header is sent. With `trackTracing: false`, or reporting not enabled, no header is sent and no error
carries a trace id, since `startTrace` returns a disabled trace.

## Custom metrics and infrastructure monitoring

Two explicit calls (nothing is automatic, so there is no `trackMetrics` flag): a business event you
name yourself, and a reading from one of your own hosts.

```ts
import { captureMetric, captureInfrastructureMetric, flushMetrics } from "@forge-ops/tracker-web";

captureMetric("signup"); // value defaults to 1: a bare counter
captureMetric("payment", 49); // a real magnitude; it may be negative (a refund)

captureInfrastructureMetric("queue_depth", 12, { hostname: "worker-1" });
await flushMetrics(); // send right now
```

Each capture is buffered and flushed as one batch every `metricFlushIntervalMs` /
`infrastructureMetricFlushIntervalMs` (60,000 by default) on a `setTimeout` chain. A page can be torn
down at any moment, so a flow that ends on unload should `await flushMetrics()` first. Every entry is
stored as it was captured (a signup is a row, not a running total), so a count or sum you compute later
is exact. Both are a no-op when reporting isn't enabled for the environment.

**Infrastructure readings need a hostname**, and a browser has none: pass `{ hostname }` or set
`serverName` in `init` (it is `null` by default, and a reading without one is dropped with a log line rather than sent).

A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) keeps every entry
for the next flush, and an entry captured while a delivery is in flight is kept too (the Ruby gem's own
buffer loses it; a test pins this with a gated delivery: a flush awaits the network, so captures really
do interleave with it). After 5 flushes in a row have failed, the batch is dropped and the buffer starts
clean. A batch the server rejects (any other 4xx, such as the 403 a plan without the feature answers) is
dropped at once and never sent again. Each buffer holds at most 1000 entries and drops further ones
until a flush empties it. A NaN or infinite value is dropped at capture:
`JSON.stringify` turns it into `null`. Requires a ForgeOps plan that includes custom metrics /
infrastructure monitoring.

## Recording changes

When a feature flag flips or a remote config value changes, tell ForgeOps, and it shows the change on
the timeline next to the errors around it, so "errors started right after `new_checkout` turned on"
is one glance instead of an investigation. Call `recordChange` from your flag or config client's
change callback:

```ts
import { init, recordChange } from "@forge-ops/tracker-web";

init({ dsn: "https://YOUR_API_KEY@getforgeops.net/api/v1/events" });

// Your flag client's change listener: whatever it calls with the key and the old and new values.
flagClient.on("change", (key: string, value: boolean, previous: boolean) => {
  recordChange("feature_flag", `${key} turned ${value ? "on" : "off"}`, {
    details: { key, from: previous, to: value },
    actor: "flag-service",
  });
});
```

`kind` is one of `"feature_flag"`, `"config"`, `"migration"`, `"dependency"`, `"infrastructure"`, or
`"other"` (exported as `CHANGE_KINDS`); anything else is sent as `"other"`. The title is required and
cut to 200 characters. Optional: `details` (a small JSON object), `environment` (defaults to the
configured one), `service`, `actor`, `url` (http or https), `id` (an idempotency key, so recording
the same change twice keeps one), and `occurredAt` (a `Date` or ISO 8601 string, default now).

The change is sent right away in the background: `recordChange` returns immediately and never throws,
whether the request fails or your plan doesn't include change tracking (that 403 is silent). Like
every other call, it's a no-op when reporting isn't enabled for the environment.

## Web Vitals

By default, `init()` also captures Core Web Vitals: LCP, CLS, INP, FCP, and TTFB, sent as one
measurement once the page becomes hidden (a tab switch, navigating away, or closing the tab), with
whatever subset of those actually finished measuring by then. No wiring needed beyond `init()`
itself; see it under a project's own Web Vitals page once reported.

```ts
forgeOpsTracker.init({
  dsn: "...",
  webVitals: false, // opt out entirely
});
```

CLS uses the real session-window algorithm (shifts within 1s of each other, and within 5s of the
window's first one, accumulate together; the largest window wins), not a plain running total. INP
is a deliberate simplification: the single worst interaction observed, not the closer-to-98th-
percentile figure the metric is formally defined as, stated plainly rather than pretending to the
full algorithm. Requires a ForgeOps plan that includes Web Vitals tracking; on a plan that doesn't,
measurements are accepted but not recorded, and the response says why.

## Session Replay

Off by default, unlike breadcrumbs/Web Vitals above; turn it on explicitly once your plan includes
it:

```ts
forgeOpsTracker.init({
  dsn: "...",
  sessionReplay: true,
});
```

Once on, this records a snapshot of the page plus every DOM mutation, click, scroll, and resize
after it, always in memory, never uploaded on its own. A recording is only ever uploaded the
moment an error is actually reported, attached to that specific error; a session that never
errors never uploads a single byte.

What's masked before it's ever recorded, always, with no way to turn it off globally:

- Every text node: each character that isn't whitespace becomes `•`, so length and layout survive.
- Every input and textarea's value, typed or filled in, as a fixed `••••••••` whatever its length
  (password fields included).
- Checkbox and radio state (every box is recorded as unchecked) and a `<select>`'s chosen option
  (recorded as `••••••••`, with no option marked `selected`).
- Text-bearing attributes, masked the same way as text: `placeholder`, `title`, `alt`, `label`,
  `aria-label`, `aria-description`, `aria-placeholder`, `aria-valuetext`, the `value` attribute of
  buttons, checkboxes, radios and options, a `<meta>` tag's `content`, and every `data-*` attribute
  except this SDK's own `data-forgeops-*` ones.

Every address keeps only its scheme, host, port and path, whether unmasked or not: the page's
address sent with the recording, and every `href`, `src`, `srcset`, `action`, `formaction`,
`poster` and `cite` in it. The query string, the fragment and any `user:password@` are never
recorded, so `https://app.example.com/patients/42?email=jane@example.com#notes` is recorded as
`https://app.example.com/patients/42`. A relative address keeps its path (`/search?q=jane` is
`/search`), and a `mailto:`, `tel:`, `sms:` or `javascript:` one keeps only its scheme. The path
itself is kept in full, so an id or name in a path (`/patients/jane-doe`) is recorded.

Recorded as they are: tag names, `id`, `class`, `style`, `name`, `type`, `role` and other
attributes not listed above, the page's layout, and mouse movement, clicks, scrolling and window
size. `<script>`, `<style>` and `<noscript>` elements, and comments, aren't recorded at all.

A static, genuinely safe element can opt out one at a time with `data-forgeops-unmask="true"` on
it, never a project-wide switch. It unmasks everything inside it too: its text, its text-bearing
attributes, and every form field in it, password fields included. Inside an unmasked element a
field's `value` attribute is recorded as it is, and checkbox, radio and select state is recorded.
Some frameworks (React among them) keep a field's `value` attribute in step with what's typed, so
in those apps what someone types into a field inside an unmasked element can be recorded. Put
`data-forgeops-unmask` on static content, never around a form that takes personal data.

Requires a ForgeOps plan that includes session replay
(Enterprise); on a plan that doesn't, recordings are accepted but not recorded, and the response says why.

## Database errors

Browsers rarely run SQL, but an error from server-rendered code or an in-browser SQLite build can carry the statement as a `.sql` or `.query` string, which is read automatically (including through `cause`). Where it doesn't, attach it where you ran the query with `withSql`, and the event includes the names of the tables and views that SQL touched, so the issue tells you where to start looking. Names are identifiers, never values; the raw statement never leaves the process.

To also send the SQL statement itself, opt in. Every string and number is replaced by `?` before it
leaves your process (`WHERE email = 'a@b.co' AND id = 42` is sent as `WHERE email = ? AND id = ?`),
and ForgeOps masks it again on arrival:

```ts
import { withSql } from "@forge-ops/tracker-web";

try {
  db.exec(sql);
} catch (error) {
  throw withSql(error as Error, sql);
}

// Opt in to also sending the masked statement (default false).
forgeOpsTracker.init({ dsn: "...", captureSqlStatement: true });
```

Each ForgeOps project also has its own "Capture the SQL behind database errors" setting. Turn it off
there and the statement is never stored for that project, whatever this flag says; the names are
still kept. A view and a table are written the same way in SQL, so both show as tables/views; the
database's own error message usually settles which it was.

## Running the tests

```bash
cd sdks/typescript
npm install
npm run build
npm test
npm run lint
```
