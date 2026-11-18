/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useEffect, useRef, type RefObject } from "react";

export interface DismissLayerOptions {
  onEscape?: (event: KeyboardEvent) => void;
  onOutsidePress?: (event: PointerEvent) => void;
  /** portalled or trigger elements that count as part of this layer. */
  branches?: readonly RefObject<HTMLElement | null>[];
}

interface Layer {
  id: symbol;
  ref: RefObject<HTMLElement | null>;
}

const layers: Layer[] = [];

/**
 * An innermost-wins dismiss layer. Only the top layer observes Escape or an
 * outside pointer press; nested portalled controls therefore close one at a
 * time. Handlers are cancellable through `preventDefault()`.
 */
export function useDismissLayer(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: DismissLayerOptions,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { id: Symbol("dismiss-layer"), ref };
    layers.push(layer);

    const isTop = () => layers[layers.length - 1]?.id === layer.id;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTop()) return;
      const handler = optionsRef.current.onEscape;
      if (!handler) return;
      event.preventDefault();
      handler(event);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.defaultPrevented || !isTop()) return;
      const handler = optionsRef.current.onOutsidePress;
      if (!handler) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest("[data-krobi-notifications]")) return;
      const inside = [ref, ...(optionsRef.current.branches ?? [])].some((branch) => branch.current?.contains(target));
      if (!inside) handler(event);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      const index = layers.findIndex((candidate) => candidate.id === layer.id);
      if (index >= 0) layers.splice(index, 1);
    };
  }, [active, ref]);
}

