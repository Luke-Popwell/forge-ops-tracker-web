import { Configuration } from "./configuration.js";

/** The kinds the changes endpoint accepts; anything else is sent as "other" rather than rejected. */
export const CHANGE_KINDS = ["feature_flag", "config", "migration", "dependency", "infrastructure", "other"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The server's own limit on a change's title; a longer one is truncated here instead of rejected there. */
export const MAX_CHANGE_TITLE_LENGTH = 200;

export interface RecordChangeOptions {
  /** A small JSON object describing the change, e.g. `{ flag: "new_checkout", from: false, to: true }`. */
  details?: Record<string, unknown>;
  /** Defaults to the configured `environment`. */
  environment?: string;
  /** Which part of your system changed. A browser has no service name of its own, so this is only sent when passed. */
  service?: string;
  /** Who made the change: a person, a flag service, a deploy bot. */
  actor?: string;
  /** An http(s) link to where the change was made; anything else is left out. */
  url?: string;
  /** An idempotency key: recording the same id twice records one change. */
  id?: string;
  /** When the change happened. Defaults to now. */
  occurredAt?: Date | string;
}

export interface ChangePayload {
  kind: ChangeKind;
  title: string;
  environment: string;
  occurred_at: string;
  details?: Record<string, unknown>;
  service?: string;
  actor?: string;
  url?: string;
  id?: string;
}

export function normalizeChangeKind(kind: unknown): ChangeKind {
  return (CHANGE_KINDS as readonly unknown[]).includes(kind) ? (kind as ChangeKind) : "other";
}

/**
 * Builds the POST /api/v1/changes body. Returns null for a change with no title, the one field the
 * server can't do without, so the caller drops it instead of sending a request that would be rejected.
 */
export function buildChangePayload(configuration: Configuration, kind: unknown, title: unknown, options: RecordChangeOptions = {}): ChangePayload | null {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") {
    return null;
  }

  const occurredAt = options.occurredAt instanceof Date ? options.occurredAt.toISOString() : (options.occurredAt ?? new Date().toISOString());
  const payload: ChangePayload = {
    kind: normalizeChangeKind(kind),
    title: trimmed.slice(0, MAX_CHANGE_TITLE_LENGTH),
    environment: options.environment ?? configuration.environment,
    occurred_at: occurredAt,
  };

  if (options.details !== null && typeof options.details === "object" && !Array.isArray(options.details)) {
    payload.details = options.details;
  }
  if (options.service) {
    payload.service = options.service;
  }
  if (options.actor) {
    payload.actor = options.actor;
  }
  if (options.url && /^https?:\/\//i.test(options.url)) {
    payload.url = options.url;
  }
  if (options.id) {
    payload.id = options.id;
  }
  return payload;
}
