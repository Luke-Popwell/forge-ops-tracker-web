import { captureException } from "../index.js";

/**
 * Matches the shape of the arguments Next.js's own instrumentation hook passes to an
 * `onRequestError` export (stable since Next.js 15, both the App Router and Pages Router):
 * typed independently here rather than importing the `next` package's own types, so this SDK
 * doesn't force a `next` dependency (or a specific version of it) onto every consumer, the same
 * "no framework dependency in the SDK itself" stance every other integration in this repo takes
 * (see e.g. sdks/node/src/integrations/fastify.js's own JSDoc @param comment for the same
 * reasoning applied to the fastify types there).
 */
export interface NextJsRequestInfo {
  path: string;
  method: string;
  headers: Record<string, string>;
}

export interface NextJsErrorContext {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "middleware";
}

/**
 * Re-export this from your own `instrumentation.ts`:
 *
 *   export { forgeOpsOnRequestError as onRequestError } from "@forge-ops/tracker-web/integrations/nextjs";
 *
 * Next.js calls this for any error that reaches its own top-level error handling, across the
 * server-side render/route-handler/server-action/middleware paths in `context.routeType` above:
 * genuinely the App Router's own designated hook for this (not a wrapper bolted on from outside),
 * so this integration reports server-side Next.js errors the same automatic, no-further-wiring
 * way the Django/Flask/Express/Fastify integrations elsewhere in this repo report their own
 * frameworks' unhandled exceptions.
 *
 * This only covers errors Next.js's server-side instrumentation sees: a client-side rendering
 * error still needs `ForgeOpsErrorBoundary` (see integrations/react.tsx), and Next.js's own
 * client/global error boundary conventions (`app/error.tsx`, `app/global-error.tsx`) should call
 * captureException() directly from within those files for the same reason every other framework
 * integration in this repo can't see an exception that never propagates as far as its own hook.
 */
export function forgeOpsOnRequestError(
  error: unknown,
  request: NextJsRequestInfo,
  context: NextJsErrorContext,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  captureException(err, {
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
