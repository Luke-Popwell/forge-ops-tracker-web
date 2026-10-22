/**
 * Holds a single ForgeOps DSN plus everything else the client needs to build and deliver events.
 * Mirrors sdks/node/src/configuration.js's shape, but deliberately does NOT auto-read a DSN from
 * an environment variable the way Node's Configuration reads FORGE_OPS_DSN: a browser bundle has
 * no reliable, bundler-agnostic equivalent of process.env at runtime (Vite's import.meta.env,
 * webpack's DefinePlugin, and a plain <script> tag all differ), so the DSN must always be passed
 * explicitly to init(). See gems/forge_ops_tracker/lib/forge_ops_tracker/configuration.rb for the
 * original design this is ported from.
 */
export class Configuration {
  dsn: string | null = null;
  environment = "production";
  release: string | null = null;

  /**
   * There's no meaningful "server_name" in a browser, there is no server. Left null by default;
   * a host app can set it to something like a build/deploy identifier if useful, but it's not
   * populated automatically the way Node's Configuration#serverName reads os.hostname().
   */
  serverName: string | null = null;

  /**
   * Used to decide whether a backtrace frame is "in_app": a frame's URL is compared against this
   * origin. Defaults to window.location.origin when running in an actual browser; left null in
   * any other environment (SSR, a test runner) where there's no meaningful origin to compare
   * against; every frame is then reported as not in_app rather than guessing.
   */
  appOrigin: string | null = typeof window !== "undefined" ? window.location.origin : null;

  /**
   * Whether startTrace()/trace() in index.ts start a trace at all, and so whether spans are recorded
   * and slow traces sent. On by default. Only network requests are recorded automatically (see
   * tracing.ts); everything else is a span you add by hand.
   */
  trackTracing = true;

  /** A trace is only sent when its root took at least this many milliseconds. 1s, matching every other client's default. */
  traceCaptureThresholdMs = 1000;

  /**
   * Whether a fetch or XMLHttpRequest made inside a trace carries a W3C `traceparent` header, so a
   * backend that reports to ForgeOps too continues the same trace (see tracing.ts). On by default,
   * matching gems/forge_ops_tracker's propagate_traces, but only for same-origin requests unless
   * tracePropagationTargets names more hosts: see that option for why.
   */
  propagateTraces = true;

  /**
   * Which cross-origin hosts also get the `traceparent` header; a same-origin request (same
   * protocol, host, and port as the page) always does. Undefined (the default) means same-origin
   * requests only, unlike the server SDKs' "every host" default: `traceparent` isn't a header a
   * browser sends cross-origin without asking, so a cross-origin request carrying it is preflighted,
   * and a third-party API whose CORS configuration doesn't allow the header would have the request
   * blocked outright. List your own API hosts (which must allow the header) to cover them. A string
   * matches that host and its subdomains on a dot boundary ("example.com" matches
   * "api.example.com", not "badexample.com"; a leading dot is ignored); a RegExp is tested against
   * the host (no port).
   */
  tracePropagationTargets: (string | RegExp)[] | undefined = undefined;

  /**
   * Milliseconds between flushes of the buffered captureMetric()/captureInfrastructureMetric() entries
   * (see metricBuffer.ts). There is no trackMetrics flag the way trackPerformance has one: these are
   * explicit calls the host page's own code makes, not automatic instrumentation, so there is nothing to
   * turn off that simply not calling them doesn't already do.
   */
  metricFlushIntervalMs = 60_000;
  infrastructureMetricFlushIntervalMs = 60_000;

  enabledEnvironments = new Set(["production", "staging"]);
  queueSize = 1000;
  timeoutMs = 2000;
  scrubPii = true;

  /**
   * When an error carries the SQL behind a failed database call (Sequelize, TypeORM, mysql2, and
   * anything that wraps one; see sqlStatement.ts), send the names of the stored procedure, table
   * and view it touched, so an issue says where to start looking. Names are identifiers, never
   * values, which is why this defaults on. captureSqlStatement is the separate, opt-in step of also
   * sending the statement itself, with every string and number replaced by "?"; off by default
   * because even a masked statement describes your schema, and ForgeOps' own per-project setting
   * is what durably governs whether the server stores it.
   */
  captureSqlObjects = true;
  captureSqlStatement = false;

  /**
   * Whether init() installs the automatic breadcrumb sources (console, navigation, clicks,
   * fetch/XHR); see breadcrumbs.ts. On by default, the same "on unless you turn it off" posture
   * error reporting itself already has. addBreadcrumb() in index.ts still works with this off;
   * only the automatic sources are gated by it.
   */
  breadcrumbs = true;

  /** How many recent breadcrumbs are kept; the oldest is dropped once this is exceeded. */
  maxBreadcrumbs = 30;

  /**
   * Whether init() installs the automatic Core Web Vitals capture (LCP, CLS, INP, FCP, TTFB; see
   * webVitals.ts). On by default, the same "on unless you turn it off" posture error reporting
   * itself already has.
   */
  webVitals = true;

  /**
   * Whether init() installs session replay recording (see sessionReplay.ts); off by default,
   * unlike breadcrumbs/webVitals above: this is an Enterprise-plan feature with real backend
   * storage cost behind it (see app/models/session_replay.rb), so it's opt-in rather than
   * something every integration silently starts paying for. Recording only ever buffers in
   * memory and is only ever uploaded when an error actually happens (see Reporter#report); a
   * session that never errors never uploads anything.
   *
   * Every text node and every form input's value is masked before it's ever recorded, always,
   * there's no flag here to turn that off globally, matching this app's own PII-scrubbing
   * philosophy of redacting by default. An element that's genuinely safe to show as-is (a static
   * marketing header, say) can opt out one element at a time with
   * data-forgeops-unmask="true", deliberately per-element and explicit, never a blanket switch
   * a project could flip without thinking about what it's exposing.
   */
  sessionReplay = false;

  /**
   * Whether the automatic network timing (see performanceFlusher.ts's installPerformance) and
   * recordPerformance()/timeTransaction() in index.ts time anything at all. On by default, the same
   * "on unless you turn it off" posture error reporting itself already has. Separate from
   * `webVitals` above: that measures how one page load felt, this measures how long named work took.
   */
  trackPerformance = true;

  /** How often the in-process tallies are flushed as one small aggregate report, in milliseconds, rather than one network call per timed call. 60s, matching gems/forge_ops_tracker's own default. */
  performanceFlushIntervalMs = 60_000;

  /**
   * Strict privacy, for apps that can't let personal or health data leave the browser: every error
   * event goes out without its message (a message_fingerprint instead, so errors still group),
   * breadcrumbs, SQL statement, or the user's email/username, and with only the context/tag keys
   * named in privacyAllowedFields. Breadcrumbs and session replays aren't recorded at all, network
   * spans are named by method and host only, span data keeps only db.statement and db.system, and
   * a web vitals measurement's page URL loses its query and the ids in its path. See
   * strictPrivacy.ts. Off by default. ForgeOps applies the same rules again on arrival when the
   * project's own Strict privacy setting is on.
   */
  strictPrivacy = false;

  /**
   * Context and tag keys strict privacy still sends (only plain string, number or boolean values
   * under these exact top-level keys), e.g. ["error_code", "feature"]. None by default.
   */
  privacyAllowedFields: string[] = [];

  logger: ((message: string) => void) | null = null;

  apiKey(): string | null {
    const parsed = this.parsedDsn();
    if (parsed === null || parsed.username === "") {
      return null;
    }
    return decodeURIComponent(parsed.username);
  }

  /** The ingestion URL with credentials stripped out (they travel as the Authorization header instead). */
  ingestionUri(): string | null {
    const parsed = this.parsedDsn();
    if (parsed === null) {
      return null;
    }
    const stripped = new URL(parsed.toString());
    stripped.username = "";
    stripped.password = "";
    return stripped.toString();
  }

  /**
   * Same derivation as ingestionUri(), with the trailing "/events" swapped for "/web_vitals": one
   * DSN, two endpoints, matching sessionCheckinsUri()'s own equivalent in every other client that
   * has one.
   */
  webVitalsUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    if (!uri.endsWith("/events")) {
      return uri;
    }
    return `${uri.slice(0, -"/events".length)}/web_vitals`;
  }

  /**
   * Same derivation as webVitalsUri() above, swapping in "/session_replays" instead.
   */
  sessionReplaysUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    if (!uri.endsWith("/events")) {
      return uri;
    }
    return `${uri.slice(0, -"/events".length)}/session_replays`;
  }

  /**
   * Same derivation as webVitalsUri() above, swapping in "/performance_samples" instead.
   */
  performanceSamplesUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    if (!uri.endsWith("/events")) {
      return uri;
    }
    return `${uri.slice(0, -"/events".length)}/performance_samples`;
  }

  /** Same derivation again, swapping in "/custom_metrics" instead. */
  customMetricsUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/custom_metrics` : uri;
  }

  /** Same derivation again, swapping in "/infrastructure_metrics" instead. */
  infrastructureMetricsUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/infrastructure_metrics` : uri;
  }

  /** Same derivation again, swapping in "/spans" instead. */
  spansUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/spans` : uri;
  }

  /** Same derivation again, swapping in "/changes" instead (see recordChange in index.ts). */
  changesUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/changes` : uri;
  }

  /**
   * Whether a request to `host` may carry a `traceparent` header: always when `sameOrigin` (the
   * request goes to the page's own protocol, host, and port), otherwise only when `host` matches
   * tracePropagationTargets. Never with propagateTraces off. Case-insensitive, since hostnames are.
   */
  propagatesTraceTo(host: string, sameOrigin = false): boolean {
    if (!this.propagateTraces) {
      return false;
    }
    if (sameOrigin) {
      return true;
    }
    if (this.tracePropagationTargets === undefined || this.tracePropagationTargets === null) {
      return false;
    }
    const normalized = host.toLowerCase();
    return this.tracePropagationTargets.some((target) => {
      if (target instanceof RegExp) {
        target.lastIndex = 0; // a /g or /y pattern would otherwise carry state from the last test
        return target.test(normalized);
      }
      const suffix = String(target).toLowerCase().replace(/^\./, "");
      return suffix !== "" && (normalized === suffix || normalized.endsWith(`.${suffix}`));
    });
  }

  isEnabled(): boolean {
    return Boolean(this.dsn) && this.apiKey() !== null && this.enabledEnvironments.has(this.environment);
  }

  log(message: string): void {
    this.logger?.(message);
  }

  private parsedDsn(): URL | null {
    if (!this.dsn) {
      return null;
    }
    try {
      // Same as Node's Configuration: the URL constructor throws a TypeError on a malformed
      // string (unlike Ruby's URI.parse, Python's urlsplit, or PHP's parse_url, all lenient),
      // verified directly, not assumed, hence this try/catch.
      return new URL(this.dsn);
    } catch {
      return null;
    }
  }
}
