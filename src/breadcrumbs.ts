import { Configuration } from "./configuration.js";
import { addNetworkListener } from "./networkInstrumentation.js";

export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
  category: string;
  message: string;
  level: BreadcrumbLevel;
  timestamp: string;
  data?: Record<string, unknown>;
}

// A single console.log(hugeObject) or a very long URL shouldn't make one breadcrumb dominate an
// event's payload size the way MAX_MESSAGE_LENGTH already bounds the error message itself
// server-side (see api/v1/events_controller.rb).
const MAX_MESSAGE_LENGTH = 500;

/**
 * A bounded, in-order trail of whatever happened recently in the page: console output,
 * navigation, clicks, and network requests, captured automatically once installBreadcrumbs()
 * runs below, plus anything added by hand via addBreadcrumb() in index.ts. A ring buffer, not an
 * unbounded log: the oldest entry is dropped once Configuration#maxBreadcrumbs is reached, so a
 * long-lived single-page app session never grows this without bound. Deliberately never cleared
 * after a report: the same trail leading up to one error is still exactly what's relevant if
 * another one is reported moments later, the same way it would read to someone watching over the
 * visitor's shoulder.
 */
export class BreadcrumbBuffer {
  private configuration: Configuration;
  private entries: Breadcrumb[] = [];

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  add(breadcrumb: Breadcrumb): void {
    // Read fresh on every add, not captured once at construction, the same reasoning
    // DeliveryQueue re-reads Configuration#queueSize on every push(): a size change from init()
    // has to take effect on whatever's added next, not just on a buffer created afterward.
    // Strict privacy: breadcrumbs are free text, never sent then, so they aren't kept either.
    const maxSize = Math.max(0, this.configuration.maxBreadcrumbs);
    if (maxSize === 0 || this.configuration.strictPrivacy) {
      return;
    }

    this.entries.push(breadcrumb);
    while (this.entries.length > maxSize) {
      this.entries.shift();
    }
  }

  all(): Breadcrumb[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

let installed = false;
const originalConsoleMethods: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
let removeNetworkListener: (() => void) | null = null;
let originalPushState: typeof history.pushState | null = null;
let originalReplaceState: typeof history.replaceState | null = null;
let popstateListener: (() => void) | null = null;
let clickListener: ((event: MouseEvent) => void) | null = null;
let lastHref: string | null = null;

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_LEVELS: Record<ConsoleMethod, BreadcrumbLevel> = {
  log: "info",
  info: "info",
  warn: "warning",
  error: "error",
  debug: "debug",
};

/**
 * Installs every automatic breadcrumb source: console output, navigation (both real
 * back/forward and a SPA router's own pushState/replaceState calls), clicks, and outgoing
 * fetch/XHR requests. Idempotent and a no-op outside a browser, matching
 * installGlobalErrorHandlers in index.ts. Each source wraps whatever's currently installed
 * rather than assuming it's still the untouched native implementation, so this composes
 * correctly if something else in the page has already patched the same global.
 */
export function installBreadcrumbs(configuration: Configuration, buffer: BreadcrumbBuffer): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  installConsoleBreadcrumbs(buffer);
  installNavigationBreadcrumbs(buffer);
  installClickBreadcrumbs(buffer);
  installNetworkBreadcrumbs(configuration, buffer);
}

/** @internal not part of the public API: restores every patched global between test cases */
export function uninstallBreadcrumbs(): void {
  if (!installed) {
    return;
  }
  installed = false;

  for (const method of Object.keys(originalConsoleMethods) as ConsoleMethod[]) {
    const original = originalConsoleMethods[method];
    if (original) {
      console[method] = original;
    }
    delete originalConsoleMethods[method];
  }

  removeNetworkListener?.();
  removeNetworkListener = null;
  if (originalPushState) {
    history.pushState = originalPushState;
    originalPushState = null;
  }
  if (originalReplaceState) {
    history.replaceState = originalReplaceState;
    originalReplaceState = null;
  }
  if (popstateListener) {
    window.removeEventListener("popstate", popstateListener);
    popstateListener = null;
  }
  if (clickListener) {
    document.removeEventListener("click", clickListener, true);
    clickListener = null;
  }
  lastHref = null;
}

function installConsoleBreadcrumbs(buffer: BreadcrumbBuffer): void {
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    // The exact, unbound reference currently on console[method]: stored as-is (not
    // .bind()'d, which would produce a new function object) so uninstallBreadcrumbs() below
    // restores console[method] to the identical reference it overwrote, not just an
    // equivalent one.
    const original = console[method];
    originalConsoleMethods[method] = original;

    console[method] = (...args: unknown[]): void => {
      buffer.add({
        category: "console",
        message: truncate(args.map(stringifyArg).join(" ")),
        level: CONSOLE_LEVELS[method],
        timestamp: new Date().toISOString(),
      });
      original.apply(console, args);
    };
  }
}

/**
 * Real back/forward navigation fires "popstate", but a SPA router changing routes via
 * history.pushState/replaceState fires neither; both are wrapped here too, so a client-side
 * route change shows up in the trail the same way a full navigation would.
 */
function installNavigationBreadcrumbs(buffer: BreadcrumbBuffer): void {
  lastHref = window.location.href;

  const recordNavigation = (): void => {
    const currentHref = window.location.href;
    if (currentHref === lastHref) {
      return;
    }
    buffer.add({
      category: "navigation",
      message: `${lastHref} -> ${currentHref}`,
      level: "info",
      timestamp: new Date().toISOString(),
    });
    lastHref = currentHref;
  };

  popstateListener = recordNavigation;
  window.addEventListener("popstate", popstateListener);

  const capturedPushState = history.pushState.bind(history);
  originalPushState = history.pushState;
  history.pushState = function (this: History, data: unknown, unused: string, url?: string | URL | null): void {
    capturedPushState(data, unused, url);
    recordNavigation();
  };

  const capturedReplaceState = history.replaceState.bind(history);
  originalReplaceState = history.replaceState;
  history.replaceState = function (this: History, data: unknown, unused: string, url?: string | URL | null): void {
    capturedReplaceState(data, unused, url);
    recordNavigation();
  };
}

// A single delegated listener in the capture phase, not one per element: fires regardless of
// whether the click's own handler calls stopPropagation(), and needs no wiring into whatever the
// page's own event handling looks like.
function installClickBreadcrumbs(buffer: BreadcrumbBuffer): void {
  clickListener = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) {
      return;
    }
    buffer.add({
      category: "click",
      message: describeElement(event.target),
      level: "info",
      timestamp: new Date().toISOString(),
    });
  };
  document.addEventListener("click", clickListener, true);
}

// Tag name plus id/a couple of classes: enough to recognize which element it was without
// capturing its text content or attributes, which could easily carry whatever the visitor typed
// or was shown.
function describeElement(element: Element): string {
  let descriptor = element.tagName.toLowerCase();
  if (element.id) {
    descriptor += `#${element.id}`;
  }
  const classes = Array.from(element.classList).slice(0, 2);
  if (classes.length > 0) {
    descriptor += `.${classes.join(".")}`;
  }
  return descriptor;
}

/**
 * Records each completed fetch or XMLHttpRequest (see networkInstrumentation.ts for how both are
 * wrapped, and for why this client's own delivery requests never appear here).
 */
function installNetworkBreadcrumbs(configuration: Configuration, buffer: BreadcrumbBuffer): void {
  removeNetworkListener = addNetworkListener(configuration, ({ kind, method, url, status, ok, durationMs }) => {
    buffer.add({
      category: kind,
      message: `${method} ${url}`,
      level: status === null ? "error" : ok ? "info" : "warning",
      timestamp: new Date().toISOString(),
      data: status === null ? { duration_ms: durationMs } : { status, duration_ms: durationMs },
    });
  });
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.message;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...` : message;
}
