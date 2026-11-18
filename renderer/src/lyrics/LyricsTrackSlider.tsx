import React, { useRef } from "react";

/** A click+drag track, the glass twin of the transport's `DragTrack`. Shared with the visualizer's pill. */
export function Track({ value, onChange, disabled = false, ariaLabel }: { value: number; onChange: (value: number) => void; disabled?: boolean; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const frac = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return value;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onChange(frac(e.clientX));
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => { if (dragging.current) onChange(frac(e.clientX)); };
  const up = (e: React.PointerEvent<HTMLDivElement>) => { dragging.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  return (
    <div
      ref={ref}
      className={`lyrics-track${disabled ? " is-disabled" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((value || 0) * 100)}
      aria-disabled={disabled || undefined}
    >
      <i style={{ width: `${Math.max(0, Math.min(1, value || 0)) * 100}%` }} />
    </div>
  );
}
