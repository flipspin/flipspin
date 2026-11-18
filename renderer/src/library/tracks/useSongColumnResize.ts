import { useLayoutEffect, useRef } from "react";
import {
  clampSongColumnWidth, getState, setColumnWidths, SONG_WIDTH_IDS,
  songColumnMin, subscribe, type SongColumnWidths, type SongColumnId, type SongWidthId,
} from "./songTableColumns";

// Title is an uncapped fr track; only its neighbours have a 600px ceiling.
const clampResizeWidth = (id: SongWidthId, width: number) => id === "title"
  ? Math.max(songColumnMin(id), width) : clampSongColumnWidth(id, width);

/** One canvas measurement per rendered cell; no measuring row layout. */
export function fittedSongColumnWidth(root: HTMLElement, id: SongWidthId): number | undefined {
  const cells = [...root.querySelectorAll<HTMLElement>(`.song-grid > .song-col--${id}`)];
  if (!cells.some(cell => cell.closest(".retro-song-table__row"))) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  const widths = cells.map(cell => {
    const text = cell.querySelector("[data-column-label]") ?? cell;
    const style = getComputedStyle(text);
    context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const content = text.textContent?.trim() ?? "";
    return context.measureText(style.textTransform === "uppercase" ? content.toUpperCase() : content).width;
  });
  const rows = widths.slice(1).sort((a, b) => a - b);
  const middle = Math.floor(rows.length / 2);
  const median = rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
  return clampResizeWidth(id, Math.ceil(Math.max(widths[0], ...rows.filter(width => width <= median * 2)) + 24));
}

type Drag = {
  id: SongWidthId; handle: HTMLElement; pointerId: number; x: number; width: number;
  before: SongColumnWidths; frozen: SongColumnWidths; neighbours: SongColumnId[];
  direction: number; pending?: SongColumnWidths; moved: boolean;
};

/** Transfer only available space, nearest neighbour first. Title is never in this list. */
function redistribute(widths: SongColumnWidths, id: SongWidthId, neighbours: SongColumnId[], current: number, requested: number): SongColumnWidths {
  const next = { ...widths };
  let remaining = clampResizeWidth(id, requested) - current;
  for (const neighbour of neighbours) {
    const width = widths[neighbour]!;
    const transfer = remaining > 0 ? Math.min(remaining, Math.max(0, width - songColumnMin(neighbour)))
      : -Math.min(-remaining, Math.max(0, 600 - width));
    next[neighbour] = width - transfer;
    remaining -= transfer;
    if (remaining === 0) break;
  }
  if (id !== "title") next[id] = clampResizeWidth(id, requested) - remaining;
  return next;
}

/** All drag state stays outside React. Header and virtual rows inherit root vars. */
export function useSongColumnResize() {
  const headerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = header?.closest<HTMLElement>(".retro-song-table");
    if (!header || !root) return;
    let drag: Drag | undefined;
    let frame: number | undefined;
    const html = document.documentElement;
    const cellOf = (id: SongWidthId) => header.querySelector<HTMLElement>(`.song-col--${id}`)!;
    // Assemble off-DOM so every frame mutates the table root exactly once.
    const style = document.createElement("div").style;
    const write = (widths: SongColumnWidths) => {
      style.cssText = root.style.cssText;
      for (const id of SONG_WIDTH_IDS) {
        if (widths[id] == null) style.removeProperty(`--sc-w-${id}`);
        else style.setProperty(`--sc-w-${id}`, `${widths[id]}px`);
      }
      if (root.style.cssText !== style.cssText) root.style.cssText = style.cssText;
    };
    const visibleColumns = () => getState().order.filter(id => cellOf(id).getBoundingClientRect().width > 0);
    const neighboursOf = (id: SongWidthId, visible: SongColumnId[]) => {
      if (id === "title") return visible;
      const index = visible.indexOf(id);
      return index === visible.length - 1 ? visible.slice(0, index).reverse() : visible.slice(index + 1);
    };
    const maximumWidth = (id: SongWidthId, current: number, visible: SongColumnId[]) => id === "title"
      ? current + visible.reduce((sum, neighbour) => sum + Math.max(0, cellOf(neighbour).getBoundingClientRect().width - songColumnMin(neighbour)), 0)
      : 600;
    const refresh = () => {
      const ids: SongWidthId[] = ["title", ...getState().order];
      const measured = ids.map(id => ({ id, cell: cellOf(id), width: cellOf(id).getBoundingClientRect().width }));
      const visible = measured.filter(({ id, width }) => id !== "title" && width > 0);
      const last = visible.at(-1)?.id;
      const minimum = `${visible.reduce((sum, { id }) => sum + songColumnMin(id), 0)}px`;
      if (root.style.getPropertyValue("--sc-min-rest") !== minimum) root.style.setProperty("--sc-min-rest", minimum);
      measured.forEach(({ id, cell, width }) => {
        const handle = cell.querySelector<HTMLElement>("[role=separator]")!;
        handle.hidden = width === 0 || visible.length < (id === "title" ? 1 : 2);
        handle.dataset.resizeSide = id === last ? "left" : "right";
        const preferred = drag?.pending?.[id] ?? getState().widths[id] ?? width;
        handle.setAttribute("aria-valuemax", String(Math.round(id === "title" ? maximumWidth(id, width, visibleColumns()) : 600)));
        handle.setAttribute("aria-valuenow", String(Math.round(clampResizeWidth(id, preferred))));
      });
    };
    const apply = (widths: SongColumnWidths, active = false) => {
      write(widths);
      root.toggleAttribute("data-column-widths", active || Object.keys(widths).length > 0);
      refresh();
    };
    const freeze = (): SongColumnWidths => {
      const widths = { ...getState().widths };
      // Snapshot all visible tracks before writing; their sum keeps Title steady.
      for (const id of visibleColumns()) widths[id] = cellOf(id).getBoundingClientRect().width;
      return widths;
    };
    const flush = () => {
      frame = undefined;
      if (!drag || drag.pending == null) return;
      write(drag.pending);
      const width = drag.id === "title" ? cellOf(drag.id).getBoundingClientRect().width : drag.pending[drag.id]!;
      drag.handle.setAttribute("aria-valuenow", String(Math.round(width)));
    };
    const finish = (cancel = false) => {
      if (!drag) return;
      if (frame != null) cancelAnimationFrame(frame);
      const ended = drag;
      if (!cancel) flush();
      frame = undefined;
      drag = undefined;
      ended.handle.removeAttribute("data-resizing");
      html.classList.remove("song-column-resizing");
      if (ended.handle.hasPointerCapture?.(ended.pointerId)) ended.handle.releasePointerCapture(ended.pointerId);
      if (cancel || !ended.moved) apply(ended.before);
      else setColumnWidths(ended.pending ?? ended.frozen);
      refresh();
    };
    const handleOf = (event: Event) => {
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[role=separator][data-column-id]") : null;
      return handle && header.contains(handle) ? handle : null;
    };
    const down = (event: PointerEvent) => {
      const handle = handleOf(event);
      if (!handle || handle.hidden || event.button !== 0 || drag) return;
      event.preventDefault();
      event.stopPropagation();
      const id = handle.dataset.columnId as SongWidthId;
      const width = cellOf(id).getBoundingClientRect().width;
      const before = { ...getState().widths };
      const frozen = freeze();
      const visible = visibleColumns();
      drag = { id, handle, pointerId: event.pointerId, x: event.clientX, width, before, frozen,
        neighbours: neighboursOf(id, visible), direction: id === visible.at(-1) ? -1 : 1, moved: false };
      // A click alone never commits a sizing preference.
      apply(frozen, true);
      handle.focus();
      handle.setPointerCapture(event.pointerId);
      handle.setAttribute("data-resizing", "");
      html.classList.add("song-column-resizing");
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (event.buttons === 0) { finish(); return; }
      if (event.clientX === drag.x && !drag.moved) return;
      drag.moved = true;
      drag.pending = redistribute(drag.frozen, drag.id, drag.neighbours, drag.width, drag.width + drag.direction * (event.clientX - drag.x));
      if (frame == null) frame = requestAnimationFrame(flush);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === drag?.pointerId) finish(); };
    const cancel = () => finish(true);
    const fit = (handle: HTMLElement) => {
      const id = handle.dataset.columnId as SongWidthId;
      const width = fittedSongColumnWidth(root, id);
      if (width == null) return;
      setColumnWidths(redistribute(freeze(), id, neighboursOf(id, visibleColumns()), cellOf(id).getBoundingClientRect().width, width));
    };
    const doubleClick = (event: MouseEvent) => {
      const handle = handleOf(event);
      if (!handle || handle.hidden) return;
      event.preventDefault(); event.stopPropagation();
      fit(handle);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag) {
        event.preventDefault(); event.stopPropagation(); finish(true); return;
      }
      const handle = handleOf(event);
      if (!handle || handle.hidden || drag) return;
      const id = handle.dataset.columnId as SongWidthId;
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Enter") { fit(handle); return; }
      const current = cellOf(id).getBoundingClientRect().width;
      const visible = visibleColumns();
      const direction = id === visible.at(-1) ? -1 : 1;
      const width = event.key === "Home" ? songColumnMin(id) : event.key === "End" ? maximumWidth(id, current, visible)
        : current + direction * (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 8);
      setColumnWidths(redistribute(freeze(), id, neighboursOf(id, visible), current, width));
    };
    const click = (event: MouseEvent) => { if (handleOf(event)) { event.preventDefault(); event.stopPropagation(); } };
    apply(getState().widths);
    const unsubscribe = subscribe(() => { if (drag) finish(true); apply(getState().widths); });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refresh);
    observer?.observe(header);
    header.querySelectorAll<HTMLElement>("[data-resize-column]").forEach(cell => observer?.observe(cell));
    const mutations = new MutationObserver(refresh);
    mutations.observe(root, { attributes: true, attributeFilter: ["class"] });
    header.addEventListener("pointerdown", down);
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", cancel);
    header.addEventListener("lostpointercapture", cancel);
    header.addEventListener("dblclick", doubleClick);
    header.addEventListener("click", click);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    return () => {
      finish(true);
      unsubscribe(); observer?.disconnect(); mutations.disconnect();
      header.removeEventListener("pointerdown", down);
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", cancel);
      header.removeEventListener("lostpointercapture", cancel);
      header.removeEventListener("dblclick", doubleClick);
      header.removeEventListener("click", click);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  return headerRef;
}
