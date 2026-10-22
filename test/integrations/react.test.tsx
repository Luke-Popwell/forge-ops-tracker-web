import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("../../src/index.js", () => ({ captureException }));

// Imported after the mock above so ForgeOpsErrorBoundary picks up the mocked captureException,
// not the real one (which would otherwise try to build and deliver a real event over fetch).
const { ForgeOpsErrorBoundary } = await import("../../src/integrations/react.js");

function Bomb(): never {
  throw new Error("boom");
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
// React logs a caught render error to console.error by design (it's still a real error, just one
// this boundary handled): silenced here so test output reflects assertion failures only, not
// expected-and-handled noise from Bomb().
vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  captureException.mockClear();
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe("ForgeOpsErrorBoundary", () => {
  it("reports the error via captureException and renders the fallback", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <ForgeOpsErrorBoundary fallback={<p>Something broke</p>}>
          <Bomb />
        </ForgeOpsErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("Something broke");
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reportedError, context] = captureException.mock.calls[0]!;
    expect((reportedError as Error).message).toBe("boom");
    expect(typeof (context as { componentStack: string }).componentStack).toBe("string");
  });

  it("renders children normally, and never reports, when nothing throws", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <ForgeOpsErrorBoundary fallback={<p>Something broke</p>}>
          <p>All good</p>
        </ForgeOpsErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("All good");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("supports a function fallback that receives the caught error", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <ForgeOpsErrorBoundary fallback={(error) => <p>Failed: {error.message}</p>}>
          <Bomb />
        </ForgeOpsErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("Failed: boom");
  });
});
