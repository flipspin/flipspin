/* krobi-ui; AGPL-3.0; see LICENSE. */
import { flushSync } from "react-dom";

type StartViewTransition = (update: () => void) => unknown;

let queue: (() => void)[] | null = null;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Run a navigation as one View Transition: the old page is captured, every
 * update queued in the same tick is applied together inside the transition
 * (a browse-stack reset *and* the page switch), and the CSS in
 * ui/tokens/app.css animates the `.k-page` surface between the two.
 *
 * Callers that must stay synchronous for readers (a store mutating its own
 * state) mutate first and hand only the *notification* here. Without the API
 * (jsdom, an older WebKit) or under reduced motion it just runs the update.
 */
export function pageTransition(update: () => void): void {
  if (queue) {
    queue.push(update);
    return;
  }
  const start = (typeof document !== "undefined"
    ? (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition
    : undefined);
  if (!start || reducedMotion()) {
    update();
    return;
  }
  queue = [update];
  // Name the surface for this transition only (see ui/tokens/app.css: a
  // permanent view-transition-name traps position:fixed children in WebKit).
  const root = document.documentElement;
  root.dataset.pageTransition = "";
  const unname = () => {
    delete root.dataset.pageTransition;
  };
  try {
    const transition = start.call(document, () => {
      const run = queue ?? [];
      queue = null;
      flushSync(() => run.forEach((fn) => fn()));
    }) as { finished?: Promise<unknown> } | undefined;
    if (transition?.finished) transition.finished.then(unname, unname);
    else unname();
  } catch {
    const run = queue ?? [];
    queue = null;
    unname();
    run.forEach((fn) => fn());
  }
}
