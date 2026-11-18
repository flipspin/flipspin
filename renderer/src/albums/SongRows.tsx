import React, { useImperativeHandle, useLayoutEffect, type ReactNode, type Ref, type RefObject, type HTMLAttributes } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";

/** Above this many songs the list renders only what is on screen. */
export const VIRTUAL_FROM = 150;

/**
 * The default window, started on an even index: the zebra stripes are
 * `:nth-child(even)` on the rendered rows, so an odd first row would swap
 * every stripe while scrolling.
 */
function evenStart(range: Range): number[] {
  const indexes = defaultRangeExtractor(range);
  return indexes.length && indexes[0] % 2 === 1 ? [indexes[0] - 1, ...indexes] : indexes;
}

/** More slots than rows ever on screen + overscan, so two rows never share one. */
const POOL = 256;

function keyOf(item: unknown, index: number): string | number {
  const path = (item as { path?: string } | null)?.path;
  return path ?? index;
}

export type SongRowsHandle = { scrollToIndex: (index: number) => void };

type Props<T> = {
  items: readonly T[];
  scrollRef: RefObject<HTMLElement | null>;
  /** Every row's height in px (they are all one height; measured by the caller). */
  rowHeight: number;
  /**
   * Draw one row; put `key` on it. In a virtual list the key is a recycled slot
   * (index mod POOL), so a row scrolling in reuses the component of the row
   * that just left; an update instead of a mount, much cheaper per frame.
   */
  renderRow: (item: T, index: number, key: string | number) => ReactNode;
  handleRef?: Ref<SongRowsHandle>;
  /**
   * Where to start (the saved scroll position). The virtualizer writes its own
   * offset to the scroller on mount, so a position set from outside before
   * that is overwritten with 0.
   */
  initialOffset?: number;
  scrollMargin?: number;
  scrollPaddingStart?: number;
  listProps?: HTMLAttributes<HTMLUListElement>;
  afterRows?: ReactNode;
};

/** Virtualize long lists and isolate scroll updates from the toolbar.
 * Fixed row heights allow arithmetic offsets without per-row measurement. */
export default function SongRows<T>({ items, scrollRef, rowHeight, renderRow, handleRef, initialOffset = 0, scrollMargin = 0, scrollPaddingStart = 0, listProps, afterRows }: Props<T>) {
  const virtual = items.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    enabled: virtual,
    scrollMargin,
    scrollPaddingStart,
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    initialRect: { width: 0, height: typeof window === "undefined" ? 800 : window.innerHeight },
    rangeExtractor: evenStart,
    initialOffset,
    // A scroll step re-renders on React's normal schedule, not synchronously
    // inside the scroll event (flushSync per event cost WebKit frames).
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  useImperativeHandle(handleRef, () => ({
    scrollToIndex: (index: number) => {
      if (virtual) {
        virtualizer.scrollToIndex(index, { align: "auto" });
        return;
      }
      const row = scrollRef.current?.querySelectorAll(".retro-song-table__row")[index];
      row?.scrollIntoView({ block: "nearest" });
    },
  }), [virtual, virtualizer, scrollRef]);

  if (!virtual) {
    return <ul {...listProps} data-first-index={0} className={`retro-song-table__body text-sm ${listProps?.className ?? ""}`}>{items.map((item, index) => renderRow(item, index, keyOf(item, index)))}{afterRows}</ul>;
  }
  const shown = virtualizer.getVirtualItems();
  // A box the full list's height, and the rendered rows moved into place with
  // a transform: moving the window is a compositor change, not a relayout of
  // every rendered row (a top padding re-laid out all ~40 rows per step).
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      <ul
        {...listProps}
        data-first-index={shown[0]?.index ?? 0}
        className={`retro-song-table__body text-sm ${listProps?.className ?? ""}`}
        style={{ transform: `translateY(${shown.length ? shown[0].start - scrollMargin : 0}px)` }}
      >
        {shown.map((row) => renderRow(items[row.index], row.index, row.index % POOL))}
        {afterRows}
      </ul>
    </div>
  );
}
