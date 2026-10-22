import { afterEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("../../src/index.js", () => ({ captureException }));

const { forgeOpsOnRequestError } = await import("../../src/integrations/nextjs.js");

afterEach(() => {
  captureException.mockClear();
});

describe("forgeOpsOnRequestError", () => {
  it("reports a real Error with request/route context", () => {
    const error = new Error("boom");

    forgeOpsOnRequestError(
      error,
      { path: "/api/orders", method: "POST", headers: {} },
      { routerKind: "App Router", routePath: "/api/orders", routeType: "route" },
    );

    expect(captureException).toHaveBeenCalledWith(error, {
      path: "/api/orders",
      method: "POST",
      routerKind: "App Router",
      routePath: "/api/orders",
      routeType: "route",
    });
  });

  it("wraps a non-Error thrown value in an Error before reporting", () => {
    forgeOpsOnRequestError(
      "a string was thrown",
      { path: "/", method: "GET", headers: {} },
      { routerKind: "Pages Router", routePath: "/", routeType: "render" },
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const [reportedError] = captureException.mock.calls[0]!;
    expect(reportedError).toBeInstanceOf(Error);
    expect((reportedError as Error).message).toBe("a string was thrown");
  });
});
