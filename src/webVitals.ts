import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { pageUrl } from "./strictPrivacy.js";

export interface WebVitalsPayload {
  url: string;
  environment: string;
  release: string | null;
  measured_at: string;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  fcp_ms: number | null;
  ttfb_ms: number | null;
}

// The Performance Timeline entry shapes this file actually reads off, declared locally rather
// than relied on from lib.dom.d.ts: LargestContentfulPaint/LayoutShift/the "event" entry type's
// extra fields, and PerformanceObserverInit's own durationThreshold option, are newer additions
// to the DOM spec than PerformanceEntry/PerformanceObserver themselves and aren't guaranteed
// present in every TypeScript/lib.dom.d.ts version this package might compile under.
interface LargestContentfulPaintEntry extends PerformanceEntry {
  renderTime: number;
  loadTime: number;
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number;
}

interface EventTimingObserverInit extends PerformanceObserverInit {
  durationThreshold?: number;
}

let installed = false;
let sent = false;
let lcpMs: number | null = null;
let clsValue: number | null = null;
let inpMs: number | null = null;
let fcpMs: number | null = null;
let observers: PerformanceObserver[] = [];
let visibilityListener: (() => void) | null = null;
let pageHideListener: (() => void) | null = null;

// CLS's own session-window algorithm: shifts within 1s of the previous one and 5s of the
// session's first one accumulate into the same session; a bigger gap than either starts a new
// session. clsValue is the largest session total seen so far, not a running sum of every shift
// ever observed, which is what the real Cumulative Layout Shift metric is actually defined as.
let sessionValue = 0;
let sessionFirstEntryTime = 0;
let sessionLastEntryTime = 0;

function supportsEntryType(type: string): boolean {
  return typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes?.includes(type) ?? false);
}

/**
 * Installs Core Web Vitals capture: LCP, CLS, INP, FCP, and TTFB, sent as one measurement once
 * the page becomes hidden, with whatever subset of those actually finished by then. Idempotent
 * and a no-op outside a browser (or one without PerformanceObserver at all), matching
 * installBreadcrumbs in breadcrumbs.ts.
 */
export function installWebVitals(configuration: Configuration, client: Client): void {
  if (installed || typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
    return;
  }
  installed = true;

  // CLS is a real, meaningful zero on a browser that supports it at all: "no layout shift
  // happened" is a genuine measurement, not the same thing as LCP/INP/FCP never having fired.
  if (supportsEntryType("layout-shift")) {
    clsValue = 0;
  }

  observeLcp();
  observeCls();
  observeInp();
  observeFcp();

  visibilityListener = (): void => {
    if (document.visibilityState === "hidden") {
      send(configuration, client);
    }
  };
  document.addEventListener("visibilitychange", visibilityListener);

  // A fallback for whatever path doesn't fire visibilitychange reliably (some in-app browser
  // webviews, historically); visibilitychange is still the primary, recommended signal, since it
  // also covers a tab switch or the OS backgrounding the app, neither of which pagehide alone
  // would catch.
  pageHideListener = (): void => send(configuration, client);
  window.addEventListener("pagehide", pageHideListener);
}

/** @internal not part of the public API: restores every observer/listener between test cases */
export function uninstallWebVitals(): void {
  if (!installed) {
    return;
  }
  installed = false;
  sent = false;
  lcpMs = null;
  clsValue = null;
  inpMs = null;
  fcpMs = null;
  sessionValue = 0;
  sessionFirstEntryTime = 0;
  sessionLastEntryTime = 0;

  for (const observer of observers) {
    observer.disconnect();
  }
  observers = [];

  if (visibilityListener) {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
  if (pageHideListener) {
    window.removeEventListener("pagehide", pageHideListener);
    pageHideListener = null;
  }
}

function observeLcp(): void {
  if (!supportsEntryType("largest-contentful-paint")) {
    return;
  }
  const observer = new PerformanceObserver((list) => {
    const entries = list.getEntries() as LargestContentfulPaintEntry[];
    const last = entries[entries.length - 1];
    if (last) {
      // renderTime is 0 (not exposed) for a cross-origin image with no Timing-Allow-Origin
      // header; loadTime is the documented fallback for exactly that case.
      lcpMs = last.renderTime || last.loadTime;
    }
  });
  observer.observe({ type: "largest-contentful-paint", buffered: true });
  observers.push(observer);
}

function observeCls(): void {
  if (!supportsEntryType("layout-shift")) {
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LayoutShiftEntry[]) {
      if (entry.hadRecentInput) {
        continue;
      }

      const gapFromLast = entry.startTime - sessionLastEntryTime;
      const gapFromFirst = entry.startTime - sessionFirstEntryTime;
      if (sessionValue > 0 && gapFromLast < 1000 && gapFromFirst < 5000) {
        sessionValue += entry.value;
      } else {
        sessionValue = entry.value;
        sessionFirstEntryTime = entry.startTime;
      }
      sessionLastEntryTime = entry.startTime;

      if (sessionValue > (clsValue ?? 0)) {
        clsValue = sessionValue;
      }
    }
  });
  observer.observe({ type: "layout-shift", buffered: true });
  observers.push(observer);
}

function observeInp(): void {
  if (!supportsEntryType("event")) {
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as EventTimingEntry[]) {
      if (inpMs === null || entry.duration > inpMs) {
        inpMs = entry.duration;
      }
    }
  });
  // durationThreshold: 40, not the Event Timing API's own default (104ms): a much lower bar
  // catches the moderate-but-real interactions this simplified "track the single worst
  // interaction" approach needs to see, rather than only the most extreme ones. The real INP
  // metric reports closer to the 98th percentile across every interaction on pages with many of
  // them; tracking just the worst single one is a deliberate simplification, honest about being
  // one rather than pretending to the full percentile algorithm.
  const options: EventTimingObserverInit = { type: "event", buffered: true, durationThreshold: 40 };
  observer.observe(options);
  observers.push(observer);
}

function observeFcp(): void {
  if (!supportsEntryType("paint")) {
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === "first-contentful-paint") {
        fcpMs = entry.startTime;
      }
    }
  });
  observer.observe({ type: "paint", buffered: true });
  observers.push(observer);
}

function getTtfb(): number | null {
  if (!supportsEntryType("navigation")) {
    return null;
  }
  const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return entry ? entry.responseStart : null;
}

function send(configuration: Configuration, client: Client): void {
  if (sent) {
    return;
  }
  sent = true;

  const payload: WebVitalsPayload = {
    // Strict privacy: the page's origin and path with its ids taken out, no query or fragment.
    url: configuration.strictPrivacy ? pageUrl(window.location.href) : window.location.href,
    environment: configuration.environment,
    release: configuration.release,
    measured_at: new Date().toISOString(),
    lcp_ms: lcpMs,
    cls: clsValue,
    inp_ms: inpMs,
    fcp_ms: fcpMs,
    ttfb_ms: getTtfb(),
  };

  // Fire-and-forget: Client.deliverWebVitals already catches every failure mode itself and
  // resolves to false rather than throwing, so there's nothing further to do with the result
  // here, the same posture Reporter.report() takes toward DeliveryQueue.
  void client.deliverWebVitals(payload);
}
