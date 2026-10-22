import { Breadcrumb } from "./breadcrumbs.js";
import { Configuration } from "./configuration.js";
import * as sqlStatement from "./sqlStatement.js";
import { Scrubbable, scrub, scrubString } from "./piiScrubber.js";
import * as strictPrivacy from "./strictPrivacy.js";

const MAX_FRAMES = 500;

// Identifies this client to the server's auto language-detection on the project the event lands
// in (see Project#note_sdk_platform server-side); matches this repo's own sdks/typescript
// directory name, the same convention every other language's client follows.
const SDK_NAME = "typescript";

export interface BacktraceFrame {
  file: string | null;
  line: number | null;
  method: string | null;
  in_app: boolean;
}

export interface EventPayload {
  exception_class: string;
  message: string;
  backtrace: BacktraceFrame[];
  occurred_at: string;
  environment: string;
  release: string | null;
  server_name: string | null;
  context: Record<string, unknown>;
  tags: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  /**
   * Set only when session replay is on and had something buffered at the moment this error was
   * reported (see Reporter#report); correlates this event with the SessionReplay recording
   * uploaded alongside it, matching app/models/session_replay.rb's own comment for why that's a
   * plain shared id rather than either upload referencing the other's server-assigned one.
   */
  replay_id: string | null;
  sdk_name: string;
  sql_objects?: sqlStatement.SqlObjects;
  sql_statement?: string;
  user?: Record<string, unknown>;
  // The W3C trace id of the trace open when this was captured (see tracing.ts), which ForgeOps uses
  // to link it to errors from linked projects in the same request. Omitted when there was none.
  trace_id?: string;
}

/**
 * What an error event carries with Configuration#strictPrivacy on (see strictPrivacy.ts): no
 * message (message_fingerprint instead), breadcrumbs, replay_id or SQL statement; context and tags
 * only when an allowed key is left; the user as its id only.
 */
export type StrictEventPayload = Omit<EventPayload, "message" | "breadcrumbs" | "replay_id" | "sql_statement" | "context" | "tags" | "user"> & {
  message_fingerprint: string;
  context?: Record<string, strictPrivacy.AllowedValue>;
  tags?: Record<string, strictPrivacy.AllowedValue>;
  user?: { id: string };
};

// V8 (Chrome/Edge/Node-in-browser-devtools) stack frame, e.g.
//   "    at innerFunc (https://app.example.com/assets/app.js:12:9)"
//   "    at https://app.example.com/assets/app.js:8:3"   (no named function)
// Same shape as sdks/node/src/eventBuilder.js's FRAME_RE, since V8 produces this format
// identically whether it's running in Node or a Chromium-based browser.
const V8_FRAME_RE = /^\s*at\s+(?:(async)\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

// Firefox/Safari stack frame, e.g.
//   "innerFunc@https://app.example.com/assets/app.js:12:9"
//   "@https://app.example.com/assets/app.js:8:3"   (anonymous frame)
// Verified directly against real Error#stack output captured in both Firefox and Safari before
// relying on it, not assumed from documentation alone; their shared "name@url:line:col" shape
// differs from V8's "at name (url:line:col)" enough that a single regex can't cover both.
const SPIDERMONKEY_FRAME_RE = /^(.*)@(.+):(\d+):(\d+)$/;

/**
 * Turns a raised exception into the payload shape the ingestion API expects. Backtrace parsing
 * tries both known browser stack formats per line (see the two regexes above); a line matching
 * neither (Node's frame under a test runner, or a future engine's own format) is simply skipped,
 * the same graceful-degradation approach PHP's client uses for frames it can't parse: a shorter
 * backtrace, never a thrown error.
 */
export class EventBuilder {
  private configuration: Configuration;

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  build(
    error: Error,
    context: Record<string, unknown> = {},
    breadcrumbs: Breadcrumb[] = [],
    replayId: string | null = null,
    user: Record<string, unknown> | null = null,
    traceId: string | null = null,
  ): EventPayload {
    const payload: EventPayload = {
      exception_class: error?.name ?? "Error",
      message: error?.message ?? "",
      backtrace: this.backtrace(error),
      occurred_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      environment: this.configuration.environment,
      release: this.configuration.release,
      server_name: this.configuration.serverName,
      context: { ...context },
      tags: {},
      breadcrumbs,
      replay_id: replayId,
      sdk_name: SDK_NAME,
    };
    if (user && Object.keys(user).length > 0) {
      payload.user = { ...user };
    }
    // Never scrubbed (see scrubPayload): an id this client generated, not text from the app.
    if (traceId) {
      payload.trace_id = traceId;
    }

    this.attachSql(payload, error);
    return this.configuration.scrubPii ? this.scrubPayload(payload) : payload;
  }

  /**
   * The same event with strict privacy's rules applied (see StrictEventPayload). The fingerprint is
   * taken from the message as it would otherwise have been sent (scrubbed, when scrubPii is on), so
   * it matches what the server fingerprints from a client without strict privacy.
   */
  buildStrict(error: Error, context: Record<string, unknown> = {}, user: Record<string, unknown> | null = null, traceId: string | null = null): StrictEventPayload {
    const built = this.build(error, context, [], null, user, traceId);
    const allowed = this.configuration.privacyAllowedFields ?? [];
    const payload: StrictEventPayload = {
      exception_class: built.exception_class,
      backtrace: built.backtrace,
      occurred_at: built.occurred_at,
      environment: built.environment,
      release: built.release,
      server_name: built.server_name,
      sdk_name: built.sdk_name,
      message_fingerprint: strictPrivacy.messageFingerprint(built.message),
    };
    if (built.sql_objects) {
      payload.sql_objects = built.sql_objects;
    }
    if (built.trace_id) {
      payload.trace_id = built.trace_id;
    }
    const allowedContext = strictPrivacy.allowedFields(built.context, allowed);
    if (allowedContext) {
      payload.context = allowedContext;
    }
    const allowedTags = strictPrivacy.allowedFields(built.tags, allowed);
    if (allowedTags) {
      payload.tags = allowedTags;
    }
    const strictUser = strictPrivacy.userId(user);
    if (strictUser) {
      payload.user = strictUser;
    }
    return payload;
  }

  // See sqlStatement.ts for what's read off the error and how it's masked. The statement itself
  // only goes out when captureSqlStatement is on; the extracted names go out on their own
  // (captureSqlObjects) so an issue can still name the procedure or view involved.
  private attachSql(payload: EventPayload, error: Error): void {
    const config = this.configuration;
    if (!config.captureSqlObjects && !config.captureSqlStatement) {
      return;
    }

    const masked = sqlStatement.mask(sqlStatement.findIn(error));
    if (masked === null) {
      return;
    }

    const found = sqlStatement.objects(masked);
    if (found && config.captureSqlObjects) {
      payload.sql_objects = found;
    }
    if (config.captureSqlStatement) {
      payload.sql_statement = masked;
    }
  }

  // exception_class/occurred_at/environment/release/server_name/user/trace_id are left alone: structured
  // fields this client or the host app sets deliberately, not free text that could accidentally
  // carry sensitive data. category/level/timestamp on a breadcrumb are the same kind of
  // structured field; only its message and data (a console.log argument, a clicked element's own
  // id/class, a request URL) are free text that could carry anything. user specifically is a
  // deliberate exemption, not an oversight: the scrubber's own email pattern would otherwise
  // redact the exact thing this field exists to carry.
  private scrubPayload(payload: EventPayload): EventPayload {
    return {
      ...payload,
      message: scrubString(payload.message),
      backtrace: payload.backtrace.map((frame) => ({
        ...frame,
        file: frame.file ? scrubString(frame.file) : frame.file,
        method: frame.method ? scrubString(frame.method) : frame.method,
      })),
      context: scrub(payload.context as Scrubbable) as Record<string, unknown>,
      tags: scrub(payload.tags as Scrubbable) as Record<string, unknown>,
      ...(payload.sql_statement !== undefined ? { sql_statement: scrubString(payload.sql_statement) } : {}),
      breadcrumbs: payload.breadcrumbs.map((breadcrumb) => ({
        ...breadcrumb,
        message: scrubString(breadcrumb.message),
        ...(breadcrumb.data ? { data: scrub(breadcrumb.data as Scrubbable) as Record<string, unknown> } : {}),
      })),
    };
  }

  private backtrace(error: Error): BacktraceFrame[] {
    const stack = typeof error?.stack === "string" ? error.stack : "";
    const frames: BacktraceFrame[] = [];

    for (const line of stack.split("\n")) {
      if (frames.length >= MAX_FRAMES) {
        break;
      }

      const v8Match = V8_FRAME_RE.exec(line);
      // file/lineNo are guaranteed present whenever the regex matches at all (they're
      // non-optional capture groups); TS can't infer that from a pattern stored in a variable
      // rather than a literal, hence the `?? ""`/`?? "0"` fallbacks, which are unreachable in
      // practice but keep this a real string/number rather than a silently-widened `undefined`.
      if (v8Match) {
        const [, , fn, file, lineNo] = v8Match;
        frames.push(this.frame(file ?? "", Number(lineNo ?? "0"), fn ?? null));
        continue;
      }

      const spiderMatch = SPIDERMONKEY_FRAME_RE.exec(line);
      if (spiderMatch) {
        const [, fn, file, lineNo] = spiderMatch;
        frames.push(this.frame(file ?? "", Number(lineNo ?? "0"), fn || null));
        continue;
      }

      // The "Error: message" header line, or anything unparseable, skipped rather than an error.
    }

    return frames;
  }

  private frame(file: string, line: number, method: string | null): BacktraceFrame {
    return { file, line, method, in_app: this.isInApp(file) };
  }

  private isInApp(file: string | null): boolean {
    const origin = this.configuration.appOrigin;
    if (!file || !origin) {
      return false;
    }
    if (!file.startsWith(origin)) {
      return false;
    }
    // A bundled dependency's source map can still carry a /node_modules/ path segment even
    // though it's served from the same origin as the rest of the app, same exclusion Node's
    // EventBuilder applies for the same reason.
    return !file.includes("/node_modules/");
  }
}
