import { Client } from "./client.js";
import { Configuration } from "./configuration.js";

// What actually gets masked, always, no configuration to turn any of this off (see
// Configuration#sessionReplay's own comment for why): every text node's content, and an input/
// textarea's own typed value. Not masked, and a real, deliberate v1 scope limitation rather than
// an oversight: placeholder/alt/title/aria-label attributes, which can occasionally carry
// something sensitive a project set by hand (a placeholder of "e.g. jane@example.com" is fine;
// one hardcoding a real customer's own address wouldn't be). A project with that concern should
// avoid putting a real value in one of those attributes for now, the same care it would already
// need to take with anything else meant to be genuinely private.
export interface SessionReplayPayload {
  replay_id: string;
  started_at: string;
  duration_ms: number;
  page_url: string;
  /** Base64-encoded, gzip-compressed JSON; see app/controllers/api/v1/session_replays_controller.rb. */
  recording: string;
}

// A DOM node has no id of its own; this app assigns one the first time it ever serializes or
// references a given node, and reuses it for as long as that node stays in the live document
// (a WeakMap so a removed node's own entry can be garbage-collected once nothing else in the
// buffer still references it). Every recorded event refers to nodes by this id, never by walking
// the tree again, the same technique full session-replay libraries (rrweb included) use it for.
let nodeIds = new WeakMap<Node, number>();
let nextNodeId = 1;

function nodeId(node: Node): number {
  let id = nodeIds.get(node);
  if (id === undefined) {
    id = nextNodeId++;
    nodeIds.set(node, id);
  }
  return id;
}

type SerializedNode =
  | { id: number; type: "element"; tag: string; attrs: Record<string, string>; children: SerializedNode[] }
  | { id: number; type: "text"; text: string };

type RecordedEvent =
  | { t: number; type: "childList"; targetId: number; added: SerializedNode[]; removedIds: number[] }
  | { t: number; type: "attributes"; targetId: number; name: string; value: string | null }
  | { t: number; type: "characterData"; targetId: number; text: string }
  | { t: number; type: "click"; targetId: number | null; x: number; y: number }
  | { t: number; type: "mousemove"; x: number; y: number }
  | { t: number; type: "scroll"; x: number; y: number }
  | { t: number; type: "resize"; width: number; height: number };

interface Recording {
  snapshot: SerializedNode | null;
  events: RecordedEvent[];
}

// Every recording bottoms out in one of these two bounds, whichever comes first: this is what
// keeps a page open for hours from ever accumulating an unbounded buffer, by periodically
// throwing away history and starting over from a fresh, self-contained snapshot rather than
// trying to cap total size by counting bytes. REBASELINE_INTERVAL_MS is also, not coincidentally,
// roughly how much "look back before the error" a replay ever actually shows: long enough to see
// what led somewhere wrong, short enough that the encoded upload comfortably survives a page
// unload (Client#post's keepalive fetch caps a request body around 64KB; a plain marketing page's
// worth of DOM plus ~15s of ordinary interaction, gzipped, sits well under that in practice).
const REBASELINE_INTERVAL_MS = 15_000;
const MAX_BUFFERED_EVENTS = 300;
const SCROLL_THROTTLE_MS = 200;
// Coarser than scroll's own throttle: a raw mousemove stream is a genuinely high-frequency event
// (every few milliseconds on some browsers), and the player only ever shows a cursor's resting
// position between samples anyway (see the player's own comment on why), not an animated path
// between them, so anything finer than "roughly ten positions a second" buys fidelity nobody
// watching a replay would actually notice.
const MOUSEMOVE_THROTTLE_MS = 100;

// Attributes that are themselves script/style content, or a resource reference no different from
// any other attribute a real page might legitimately want to see reconstructed (src/href); not
// masked, since masking them would make an image or a link impossible to tell apart from any
// other, without actually protecting anything a URL wasn't already going to reveal on its own.
const SKIPPED_TAGS = new Set([ "SCRIPT", "STYLE", "NOSCRIPT" ]);

let installed = false;
let mutationObserver: MutationObserver | null = null;
let rebaselineTimer: ReturnType<typeof setInterval> | null = null;
let clickListener: ((event: MouseEvent) => void) | null = null;
let mousemoveListener: ((event: MouseEvent) => void) | null = null;
let scrollListener: (() => void) | null = null;
let resizeListener: (() => void) | null = null;
// One shared listener for both "input" and "change": same handler either way (see
// liveFormFieldOverride's own comment for why a form field's value needs its own dedicated
// capture path at all, distinct from the MutationObserver every other kind of change goes
// through).
let formFieldListener: ((event: Event) => void) | null = null;
let scrollThrottled = false;
let mousemoveThrottled = false;

let baselineSnapshot: SerializedNode | null = null;
let baselineAt = 0;
let bufferedEvents: RecordedEvent[] = [];

/**
 * Installs continuous session replay recording: a DOM snapshot, then every mutation/click/
 * mousemove/scroll/resize after it, always buffered in memory, never uploaded on their own. Uploading only
 * ever happens through flushSessionReplay(), called from Reporter#report the moment an error is
 * actually reported: a session that never errors never uploads a single byte. Idempotent and a
 * no-op outside a browser (or one with no MutationObserver at all), matching installWebVitals/
 * installBreadcrumbs.
 */
export function installSessionReplay(): void {
  if (installed || typeof window === "undefined" || typeof MutationObserver === "undefined") {
    return;
  }
  installed = true;

  rebaseline();
  observeMutations();
  observeInteractions();
  rebaselineTimer = setInterval(rebaseline, REBASELINE_INTERVAL_MS);
}

/** @internal not part of the public API: restores every observer/listener between test cases */
export function uninstallSessionReplay(): void {
  if (!installed) {
    return;
  }
  installed = false;

  mutationObserver?.disconnect();
  mutationObserver = null;

  if (rebaselineTimer !== null) {
    clearInterval(rebaselineTimer);
    rebaselineTimer = null;
  }
  if (clickListener) {
    document.removeEventListener("click", clickListener, { capture: true });
    clickListener = null;
  }
  if (mousemoveListener) {
    document.removeEventListener("mousemove", mousemoveListener, { capture: true });
    mousemoveListener = null;
  }
  if (scrollListener) {
    window.removeEventListener("scroll", scrollListener);
    scrollListener = null;
  }
  if (resizeListener) {
    window.removeEventListener("resize", resizeListener);
    resizeListener = null;
  }
  if (formFieldListener) {
    document.removeEventListener("input", formFieldListener, { capture: true });
    document.removeEventListener("change", formFieldListener, { capture: true });
    formFieldListener = null;
  }

  nodeIds = new WeakMap();
  nextNodeId = 1;
  baselineSnapshot = null;
  baselineAt = 0;
  bufferedEvents = [];
  // Without this, a throttle flag left true by a setTimeout that hadn't fired yet (a real
  // possibility, not just a test-ordering hazard: reinstalling right after uninstalling, on a
  // page that does both, would otherwise inherit whichever timers were already in flight)
  // silently drops the very next scroll/mousemove after reinstalling until that stale timer
  // finally clears it.
  scrollThrottled = false;
  mousemoveThrottled = false;
}

/**
 * Packages whatever's currently buffered (the last baseline snapshot, plus every event since) and
 * kicks off an async, best-effort upload, returning the id to correlate against the error event
 * being reported alongside it (see EventPayload#replay_id) immediately, without waiting for that
 * upload to actually finish: Reporter#report must stay synchronous and never throw, the same
 * contract it already holds everywhere else. Returns null when recording isn't installed, or
 * hasn't captured an initial snapshot yet (a call in the first few milliseconds of a page's own
 * install(), vanishingly rare in practice).
 */
export function flushSessionReplay(configuration: Configuration, client: Client): string | null {
  if (!installed || baselineSnapshot === null) {
    return null;
  }

  const replayId = generateReplayId();
  const startedAt = baselineAt;
  const durationMs = Date.now() - baselineAt;
  const recording: Recording = { snapshot: baselineSnapshot, events: [ ...bufferedEvents ] };

  void uploadRecording(configuration, client, replayId, startedAt, durationMs, recording);
  return replayId;
}

async function uploadRecording(
  configuration: Configuration,
  client: Client,
  replayId: string,
  startedAt: number,
  durationMs: number,
  recording: Recording,
): Promise<void> {
  try {
    const encoded = await gzipAndEncode(JSON.stringify(recording));
    // CompressionStream is unsupported (older Safari, some non-browser test runners); skip
    // silently rather than uploading an uncompressed payload that risks blowing past the
    // keepalive body limit REBASELINE_INTERVAL_MS's own comment explains. The error report
    // itself already went out with replay_id set regardless, this is a bonus attachment to it,
    // never something its absence should be treated as a failure.
    if (encoded === null) {
      return;
    }

    // One attempt, whatever the outcome: a recording the server refuses is never sent again.
    const status = await client.deliverSessionReplay({
      replay_id: replayId,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: Math.max(durationMs, 1),
      page_url: window.location.href,
      recording: encoded,
    });
    if (status === "rejected") {
      configuration.log("[forge-ops-tracker] the server rejected the session replay, dropping it");
    }
  } catch (e) {
    const err = e as Error;
    configuration.log(`[forge-ops-tracker] session replay upload failed: ${err.name}: ${err.message}`);
  }
}

function rebaseline(): void {
  baselineSnapshot = serializeNode(document.documentElement);
  baselineAt = Date.now();
  bufferedEvents = [];
}

function pushEvent(event: RecordedEvent): void {
  bufferedEvents.push(event);
  // A hard count cap as a safety net underneath the timer-driven rebaseline above, for the rare
  // page that mutates the DOM hundreds of times within one REBASELINE_INTERVAL_MS window (a
  // fast-ticking animation, a big list re-rendering in a loop); forces an early, clean rebaseline
  // rather than silently dropping the oldest events, which would leave the remaining ones
  // referencing a snapshot they no longer actually apply cleanly on top of.
  if (bufferedEvents.length > MAX_BUFFERED_EVENTS) {
    rebaseline();
  }
}

function observeMutations(): void {
  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      recordMutation(mutation);
    }
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
  });
}

function recordMutation(mutation: MutationRecord): void {
  const t = Date.now() - baselineAt;

  if (mutation.type === "childList") {
    const added = Array.from(mutation.addedNodes)
      .map((node) => serializeNode(node))
      .filter((node): node is SerializedNode => node !== null);
    const removedIds = Array.from(mutation.removedNodes)
      .map((node) => nodeIds.get(node))
      .filter((id): id is number => id !== undefined);
    if (added.length === 0 && removedIds.length === 0) {
      return;
    }
    pushEvent({ t, type: "childList", targetId: nodeId(mutation.target), added, removedIds });
    return;
  }

  if (mutation.type === "attributes") {
    const element = mutation.target as Element;
    const name = mutation.attributeName;
    if (!name || SKIPPED_TAGS.has(element.tagName)) {
      return;
    }
    pushEvent({ t, type: "attributes", targetId: nodeId(element), name, value: attributeValueFor(element, name) });
    return;
  }

  // characterData: a text node's own content changed in place (the common case for, say, a
  // counter ticking up), rather than being replaced by a whole new text node (which childList
  // above already covers).
  const parent = mutation.target.parentElement;
  const text = maskTextFor(parent, mutation.target.textContent ?? "");
  pushEvent({ t, type: "characterData", targetId: nodeId(mutation.target), text });
}

function observeInteractions(): void {
  clickListener = (event: MouseEvent) => {
    const targetId = event.target instanceof Node ? nodeId(event.target) : null;
    pushEvent({ t: Date.now() - baselineAt, type: "click", targetId, x: event.clientX, y: event.clientY });
  };
  // capture: true, the same reasoning breadcrumbs.ts's own click source already documents:
  // this has to see a click even if some in-app handler stops its bubbling before it would
  // otherwise reach here.
  document.addEventListener("click", clickListener, { capture: true });

  mousemoveListener = (event: MouseEvent) => {
    if (mousemoveThrottled) {
      return;
    }
    mousemoveThrottled = true;
    setTimeout(() => {
      mousemoveThrottled = false;
    }, MOUSEMOVE_THROTTLE_MS);
    pushEvent({ t: Date.now() - baselineAt, type: "mousemove", x: event.clientX, y: event.clientY });
  };
  document.addEventListener("mousemove", mousemoveListener, { capture: true, passive: true });

  scrollListener = (): void => {
    if (scrollThrottled) {
      return;
    }
    scrollThrottled = true;
    setTimeout(() => {
      scrollThrottled = false;
    }, SCROLL_THROTTLE_MS);
    pushEvent({ t: Date.now() - baselineAt, type: "scroll", x: window.scrollX, y: window.scrollY });
  };
  window.addEventListener("scroll", scrollListener, { passive: true });

  resizeListener = (): void => {
    pushEvent({ t: Date.now() - baselineAt, type: "resize", width: window.innerWidth, height: window.innerHeight });
  };
  window.addEventListener("resize", resizeListener);

  // A form field's own value change (typing, checking a box, picking a <select> option) is
  // invisible to the MutationObserver above: it changes a live IDL property, never the HTML
  // attribute of the same name, so recordMutation's own "attributes" handling would otherwise
  // never see it at all. Captured here instead as the exact same "attributes" event shape a real
  // attribute mutation produces, so the player's existing applyMutation needs no changes to
  // understand it. "input" catches most of this in real time (every keystroke into a text field);
  // "change" catches the rest (a checkbox/radio/select only ever fires that one, not "input", in
  // every browser this app targets).
  formFieldListener = (event: Event): void => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const override = liveFormFieldOverride(event.target);
    if (!override) {
      return;
    }
    pushEvent({ t: Date.now() - baselineAt, type: "attributes", targetId: nodeId(event.target), name: override.name, value: override.value });
  };
  document.addEventListener("input", formFieldListener, { capture: true });
  document.addEventListener("change", formFieldListener, { capture: true });
}

// Walks up from an element looking for the one, deliberate, per-element opt-out this app offers
// (see Configuration#sessionReplay's own comment for why there's no broader, project-wide one):
// an ancestor marked unmasked keeps everything underneath it unmasked too, the same inheritance
// masking itself would have if this returned false instead.
function isUnmasked(element: Element | null): boolean {
  let current = element;
  while (current) {
    if (current.getAttribute("data-forgeops-unmask") === "true") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

// Every non-whitespace character becomes the same fixed glyph: the original length (and
// therefore rough layout) survives, nothing about the actual characters does. Deliberately not a
// fixed-length placeholder the way an input's own value is below: unlike a single form field, a
// whole masked paragraph collapsing to one constant string would make every masked element on
// the page look identical and destroy the layout a replay exists to show in the first place.
function maskText(text: string): string {
  return text.replace(/\S/g, "•");
}

function maskTextFor(parent: Element | null, text: string): string {
  return isUnmasked(parent) ? text : maskText(text);
}

// A fixed-length mask, unlike maskText above: the whole point of masking a password/address/card
// number is that its length is itself sensitive (a 16-digit run is obviously a card number even
// fully redacted at its real length), so this deliberately throws that signal away too.
const MASKED_INPUT_VALUE = "••••••••";

const NON_TEXT_INPUT_TYPES = new Set([ "checkbox", "radio", "button", "submit", "reset", "image", "file" ]);

function serializeNode(node: Node): SerializedNode | null {
  if (node.nodeType === Node.COMMENT_NODE) {
    return null;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return { id: nodeId(node), type: "text", text: maskTextFor(node.parentElement, node.textContent ?? "") };
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  if (SKIPPED_TAGS.has(element.tagName)) {
    return null;
  }

  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    attrs[attr.name] = attributeValueFor(element, attr.name) ?? "";
  }
  // A form field's *live* value (what's actually on screen right now) is a plain IDL property;
  // typing, checking a checkbox, or picking a <select> option changes only that property, never
  // the HTML attribute of the same name (which only ever reflects the field's *default* value,
  // set once from markup and never updated afterward). The loop above only ever visits attributes
  // that already exist as real attribute nodes, so without this, a field's current value would be
  // missing from every snapshot entirely, not just unmasked, the moment a real user had actually
  // typed into it, confirmed directly the first time this was checked. Reconciled here so both the
  // initial snapshot and every later rebaseline (see rebaseline()) reflect what's really on screen.
  const liveOverride = liveFormFieldOverride(element);
  if (liveOverride) {
    if (liveOverride.value === null) {
      delete attrs[liveOverride.name];
    } else {
      attrs[liveOverride.name] = liveOverride.value;
    }
  }

  const children: SerializedNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    const serialized = serializeNode(child);
    if (serialized) {
      children.push(serialized);
    }
  }

  return { id: nodeId(element), type: "element", tag: element.tagName.toLowerCase(), attrs, children };
}

// The one place both the initial snapshot and a later "value" attribute mutation both go through,
// so an input masked at snapshot time is masked exactly the same way if it changes afterward.
// Reads the live value property, not just the attribute HTML itself carried at parse time: an
// attribute reflects a field's default value, not whatever's actually been typed into it since,
// and it's the latter this needs to hide.
function attributeValueFor(element: Element, name: string): string | null {
  if (name !== "value" || isUnmasked(element)) {
    return element.getAttribute(name);
  }

  if (element instanceof HTMLTextAreaElement) {
    return element.value ? MASKED_INPUT_VALUE : "";
  }
  if (element instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(element.type)) {
    return element.value ? MASKED_INPUT_VALUE : "";
  }

  return element.getAttribute(name);
}

// Shared by serializeNode above (so a snapshot's own attrs reflect a form field's real current
// state) and the input/change listeners below (so a change to one shows up on the recording's own
// timeline in real time too, not just at the next rebaseline): the one place that knows which
// live IDL property actually represents "what's on screen right now" for a given form field, and
// under what attribute name a mutation event should carry it so the player's existing
// applyMutation (a plain setAttribute/removeAttribute by name) already knows what to do with it,
// no player-side change needed. Returns null for anything that isn't a form field with a live
// value worth tracking this way at all.
//
// checkbox/radio and <select> deliberately go through neither MASKED_INPUT_VALUE nor maskText:
// this file's own top comment scopes masking to "every text node's content, and an input/
// textarea's own typed value" specifically, and a checked state or a chosen option is a
// different, much lower-cardinality kind of value than free text typed into a field.
function liveFormFieldOverride(element: Element): { name: string; value: string | null } | null {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    return { name: "checked", value: element.checked ? "" : null };
  }
  if (element instanceof HTMLSelectElement) {
    return { name: "value", value: element.value || null };
  }
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(element.type))) {
    return { name: "value", value: attributeValueFor(element, "value") };
  }
  return null;
}

function generateReplayId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function gzipAndEncode(json: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") {
    return null;
  }

  // A ReadableStream built directly from the encoded bytes, not Blob([json]).stream(): both are
  // valid, standard ways to get bytes into CompressionStream, but this one has had more
  // consistently reliable support across engines historically (Blob#stream() lagged behind in
  // older Safari for a while after Blob itself shipped).
  const bytes = new TextEncoder().encode(json);
  // Typed Uint8Array<ArrayBuffer> explicitly, not the bare Uint8Array TextEncoder#encode already
  // returns: TypeScript 5.7+'s own DOM lib types CompressionStream's own readable/writable sides
  // against that more specific generic, and a bare Uint8Array (ArrayBufferLike-generic) doesn't
  // satisfy it even though the value itself is perfectly valid at runtime either way.
  const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const stream = readable.pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return arrayBufferToBase64(buffer);
}

// btoa needs a plain string of char codes, and spreading a very large Uint8Array directly into
// String.fromCharCode blows the engine's own argument-count limit; chunked the same way every
// other "encode an ArrayBuffer as base64 in a browser" implementation has to.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
