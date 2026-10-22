import { Component, ErrorInfo, ReactNode } from "react";
import { captureException } from "../index.js";

export interface ForgeOpsErrorBoundaryProps {
  children: ReactNode;
  /** Rendered in place of the crashed subtree. A function receives the caught error. */
  fallback: ReactNode | ((error: Error) => ReactNode);
}

interface State {
  error: Error | null;
}

/**
 * A React error boundary that reports to ForgeOps before rendering its fallback. Error boundaries
 * are the one place React itself calls out as needing a class component: getDerivedStateFromState
 * and componentDidCatch have no hook equivalent as of React 19, so this is deliberately a class,
 * not a stylistic choice.
 *
 * componentDidCatch (not getDerivedStateFromError) is where reporting happens: React guarantees
 * it's only called after the tree has already committed its error state, so a slow or failed
 * report here can never affect whether or how fast the fallback UI appears. getDerivedStateFromError
 * only sets local state (no side effects belong there per React's own contract for that lifecycle
 * method): confirmed directly against React's docs before splitting the two, not assumed to be
 * interchangeable.
 *
 * Reports only the error boundary's own catch: an error your own code catches and handles
 * locally (a try/catch inside an event handler, for instance) never reaches a boundary at all,
 * since React error boundaries only catch errors thrown during rendering, in lifecycle methods,
 * and in constructors of the tree below them, not in event handlers or async callbacks. Report
 * those explicitly with captureException() at the catch site instead, the same gap every other
 * SDK in this repo has for its own framework integrations.
 */
export class ForgeOpsErrorBoundary extends Component<ForgeOpsErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, { componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    if (this.state.error) {
      return typeof this.props.fallback === "function"
        ? this.props.fallback(this.state.error)
        : this.props.fallback;
    }
    return this.props.children;
  }
}
