import { useEffect, useRef, useState, type PointerEvent } from "react";
import { moveBlock } from "../reorder";
import type { PlaylistTrack } from "../playlistTracks";

type Drag = { moving: PlaylistTrack[]; x: number; y: number; boundary: number; line: number };
type Session = { pointerId: number; x: number; y: number; moving: PlaylistTrack[]; lifted: boolean; boundary: number; list: HTMLElement; scroll: HTMLElement; order: PlaylistTrack[] };

export function usePlaylistDrag(tracks: PlaylistTrack[], enabled: boolean, isSelected: (track: PlaylistTrack) => boolean, onMove?: (tracks: PlaylistTrack[], moving: PlaylistTrack[]) => void, reveal?: (index: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const session = useRef<Session | null>(null);
  const latest = useRef({ tracks, enabled, onMove, reveal });
  latest.current = { tracks, enabled, onMove, reveal };
  const suppressClick = useRef(false);
  const frame = useRef(0);
  const cancel = useRef<() => void>(() => {});

  useEffect(() => {
    let pointer = { x: 0, y: 0 };
    const finish = () => {
      session.current = null;
      cancelAnimationFrame(frame.current);
      setDrag(null);
    };
    cancel.current = finish;
    const paint = () => {
      const s = session.current;
      if (!s?.lifted) return;
      const rows = Array.from(s.list.querySelectorAll<HTMLElement>(":scope > [data-path]"));
      let boundary = rows.findIndex(row => pointer.y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
      if (boundary < 0) boundary = rows.length;
      s.boundary = Number(s.list.dataset.firstIndex ?? 0) + boundary;
      const listRect = s.list.getBoundingClientRect();
      const line = (rows[boundary]?.getBoundingClientRect().top ?? rows.at(-1)?.getBoundingClientRect().bottom ?? listRect.top) - listRect.top;
      setDrag({ moving: s.moving, ...pointer, boundary: s.boundary, line });
    };
    const scroll = () => {
      const s = session.current;
      if (!s?.lifted) return;
      const rect = s.scroll.getBoundingClientRect();
      const header = (s.list.closest(".playlist-songs")?.querySelector(".playlist-song-stack") ?? s.list.closest(".playlist-songs")?.querySelector(".retro-song-table__header"))?.getBoundingClientRect();
      const top = Math.max(rect.top, Math.min(header?.bottom ?? rect.top, rect.bottom));
      const edge = 48;
      const speed = pointer.y < top + edge ? -Math.min(16, (top + edge - pointer.y) / 3) : pointer.y > rect.bottom - edge ? Math.min(16, (pointer.y - rect.bottom + edge) / 3) : 0;
      if (speed && pointer.x >= rect.left && pointer.x <= rect.right) {
        s.scroll.scrollTop += speed;
        paint();
      }
      frame.current = requestAnimationFrame(scroll);
    };
    const move = (e: globalThis.PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!latest.current.enabled || latest.current.tracks !== s.order) return finish();
      pointer = { x: e.clientX, y: e.clientY };
      if (!s.lifted && Math.hypot(pointer.x - s.x, pointer.y - s.y) < 4) return;
      e.preventDefault();
      if (!s.lifted) {
        s.lifted = true;
        suppressClick.current = true;
        frame.current = requestAnimationFrame(scroll);
      }
      paint();
    };
    const up = (e: globalThis.PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (s.lifted && latest.current.enabled && latest.current.tracks === s.order) {
        const rect = s.list.getBoundingClientRect();
        const scrollRect = s.scroll.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= scrollRect.top && e.clientY <= scrollRect.bottom) {
          const paths = new Set(s.moving.map(song => song.path));
          const before = s.order.slice(0, s.boundary).filter(song => paths.has(song.path)).length;
          const next = moveBlock(s.order, s.moving, s.boundary - before);
          if (next !== s.order) {
            latest.current.onMove?.(next, s.moving);
            latest.current.reveal?.(next.findIndex(song => paths.has(song.path)));
          }
        }
      }
      finish();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && session.current) { e.preventDefault(); e.stopPropagation(); finish(); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", finish);
    return () => {
      finish();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", finish);
    };
  }, []);

  useEffect(() => { cancel.current(); }, [tracks, enabled]);

  const start = (track: PlaylistTrack, e: PointerEvent<HTMLButtonElement>) => {
    if (!enabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const list = e.currentTarget.closest<HTMLElement>("ul")!;
    let scroll = list.parentElement!;
    while (scroll.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
    suppressClick.current = false;
    session.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moving: isSelected(track) ? tracks.filter(isSelected) : [track], lifted: false, boundary: 0, list, scroll, order: tracks };
  };
  return { drag, start, resetClick: () => { suppressClick.current = false; }, captureClick: (e: React.MouseEvent) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } } };
}
