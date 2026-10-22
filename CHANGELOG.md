# Changelog

## 0.15.0 (2026-10-20)

- Strict privacy's path rule changed. A route template (`/patients/:id/notes`, `/patients/{id}`,
  `/files/*path`) is now kept exactly as it is, and a raw path keeps only its first segment, with
  the rest sent as `:path` (`/patients/jane-doe/12` is now `/patients/:path`; before, only segments
  holding a digit were replaced, so `jane-doe` went out). This applies to span names, performance
  transaction names and the Web Vitals page URL, which is now read by hand: the scheme in lower
  case, the host without credentials or port, then the path. Nothing changes with strict privacy
  off.

## 0.14.0 (2026-10-20)

- Strict privacy, for apps that can't let personal or health data leave the browser:
  `init({ strictPrivacy: true })`. Error events then go out without their message (a
  `message_fingerprint` instead, so errors still group), breadcrumbs, SQL statement, replay id, or
  the user's email and username, and with only the context and tag keys you list in
  `privacyAllowedFields`. Breadcrumbs and session replays aren't recorded at all, network spans are
  named by method and host only, span data keeps only `db.statement` and `db.system`, and a Web
  Vitals measurement's page URL loses its query, fragment and the ids in its path. A performance
  sample's transaction name that is a raw path has its ids taken out too. Off by default; nothing
  changes unless you turn it on. New exported type: `StrictEventPayload`.

## 0.13.0 (2026-10-13)

- A batch the server will never accept is no longer sent again and again. Before, any response
  other than a 2xx kept the batch (metrics, infrastructure readings, performance samples) and
  re-sent it at every flush with more added, for as long as the page lived; a plan without custom
  metrics answered 403 on every flush, and once the buffer was full, new metrics were dropped too.
  Now a 4xx other than 408 and 429 drops the batch at once.
- A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) still keeps
  the batch for the next flush, but only for 5 flushes in a row: the fifth failure drops the batch
  and starts clean, so an endpoint that stays down can no longer grow one batch without end. A
  delivery that goes through resets the count. The 1000 entry cap on each metric buffer is
  unchanged.
- When a batch is dropped, or the server rejects an error event, a trace or a session replay,
  `logger` is told once what was dropped and why. Nothing in the public API or the exported types changed.

## 0.12.0 (2026-09-29)

- SQL masking (database spans' `db.statement`, and the opt-in `sql_statement` on errors) now also
  catches strings with backslash-escaped quotes (`'o\'brien'`, `E'o\'brien'`), prefixed strings
  (`X'DEADBEEF'`, `N'...'`, `B'...'`, `U&'...'`, masked with their prefix), and hex, binary,
  exponent and leading-dot numbers (`0x1F`, `0b101`, `3e10`, `1.5E-3`, `.5`). On a database span
  whose `dbSystem` is `"mysql"` or `"mariadb"`, `"double quoted"` strings are masked too; elsewhere
  they're identifiers and are left alone. This matches what ForgeOps itself masks on arrival.
- A string cut off right after a backslash (`'secret\`, as a truncated statement can end) is
  now masked to the end like any other cut-off string, instead of being left as written.

## 0.11.0 (2026-09-25)

- A `database` span can now carry the SQL it ran: pass `statement` (and optionally `dbSystem`, such
  as `"sqlite"`) to `span()` or `recordSpan()`. The statement is masked before it leaves the process
  (every string and number literal becomes `?`), cut at 4000 characters, and sent in the span's data
  as `db.statement`, with `db.system` lowercased. A `db.statement` put in `data` directly is masked
  the same way. Both options are ignored on spans of any other kind.

## 0.10.0 (2026-09-25)

- New `recordChange(kind, title, options)` tells ForgeOps what changed in your app, typically from a
  feature flag or remote config change callback, so the change shows on the timeline next to the
  errors around it. `kind` is one of the six in the new `CHANGE_KINDS` export (anything else is sent
  as `"other"`); options are `details`, `environment`, `service`, `actor`, `url`, `id`, and
  `occurredAt`. Sent in the background to `/api/v1/changes`; it never throws, a failed request or a
  plan without change tracking is silent, and it's a no-op when reporting isn't enabled.

## 0.9.0

- Follow a request from the page into your backend with W3C trace context. Trace and span ids are
  now guaranteed valid W3C ids (32 and 16 lowercase hex characters, never all zeros), and a trace's
  id is readable as `t.traceId`. Every `fetch` and `XMLHttpRequest` made while exactly one trace is
  open gets a `traceparent` header naming that request's own `http` span as the parent, so a
  backend reporting to ForgeOps (Ruby from 0.12.0, Python from 0.12.0, Node from 0.11.0) nests its
  spans under it. A `traceparent` you set yourself is never replaced, and this client's own requests
  to ForgeOps never get one. A relative URL now counts as the page's own host, so same-origin
  requests made inside a trace are recorded as `http` spans too (they were left out before), and a
  request is attributed to the trace open when it is sent rather than when it completes.
- By default the header only goes to same-origin requests (same protocol, host, and port as the
  page, relative URLs included). A cross-origin request carrying `traceparent` is preflighted by the
  browser and blocked unless that server's CORS configuration allows the header, so sending it
  everywhere could break calls to third-party APIs. List your own API hosts in the new
  `tracePropagationTargets` (for example `["api.example.com"]`) to send it to them as well, and add
  `traceparent` to the `Access-Control-Allow-Headers` those hosts return.
- New `t.fetch(input, init)` and `t.httpSpan(method, url)` (also on a span's scope) add the header
  and record the call explicitly.
- An error captured while a trace is open (with `captureException`, or by the page-level `error` and
  `unhandledrejection` handlers) is sent with a top-level `trace_id`, so it is linked to the
  backend's error for the same request once the two projects are linked in ForgeOps; an error
  captured outside a trace is sent exactly as before.
- New options: `propagateTraces` (default true) and `tracePropagationTargets` (default undefined,
  meaning same-origin requests only; with a list, a request gets the header when it is same-origin
  or its host matches: strings match a host and its subdomains, a RegExp is tested against the
  host).

This client has earlier published releases, but no `CHANGELOG.md` existed for it before this entry;
it starts here without backfilling every earlier version.
