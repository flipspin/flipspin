import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { dbToGain, dbToPosition, formatDb, gainToDb, gainToPosition, positionToGain, UNITY_POSITION, FADER_TICKS } from './mix';

const clamp = (p: number) => Math.max(0, Math.min(1, p));
interface Drag {
  id: number; original: number; anchor: number; x: number; lastX: number; width: number; fine: boolean;
}
interface Props {
  name: string;
  /** Linear gain percent; never a position or a dB value. */
  level: number;
  onLive: (level: number) => void;
  onCommit: (level: number) => void;
}

/** The hand owns the DOM and audio during a gesture; React only gets its result. */
export default function Fader({ name, level, onLive, onCommit }: Props) {
  const { t } = useTranslation();
  const slider = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const position = useRef(gainToPosition(level / 100));
  const drag = useRef<Drag | null>(null);
  const callbacks = useRef({ onLive, onCommit });
  useLayoutEffect(() => { callbacks.current = { onLive, onCommit }; });
  const paint = useCallback((p: number) => {
    position.current = p;
    const text = formatDb(gainToDb(positionToGain(p)));
    slider.current?.style.setProperty('--fader-position', `${p * 100}%`);
    slider.current?.setAttribute('aria-valuenow', String(p));
    slider.current?.setAttribute('aria-valuetext', text);
    if (readout.current) readout.current.textContent = text;
  }, []);
  const live = useCallback((p: number) => {
    paint(clamp(p));
    callbacks.current.onLive(positionToGain(position.current) * 100);
  }, [paint]);
  const commit = useCallback(() => callbacks.current.onCommit(positionToGain(position.current) * 100), []);
  const finish = useCallback((cancel: boolean) => {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    if (cancel) live(gesture.original);
    commit();
    if (slider.current?.hasPointerCapture(gesture.id)) slider.current.releasePointerCapture(gesture.id);
  }, [commit, live]);
  useLayoutEffect(() => { paint(drag.current ? position.current : gainToPosition(level / 100)); });
  useEffect(() => {
    const node = slider.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (drag.current || e.deltaY === 0) return;
      const db = gainToDb(positionToGain(position.current));
      if (position.current === 0 && e.deltaY > 0) return;
      const next = (Number.isFinite(db) ? db : -60) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 0.5);
      live(dbToPosition(next)); commit();
    };
    const modifier = (e: KeyboardEvent) => {
      const gesture = drag.current;
      if (!gesture) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
      else if (e.key === 'Shift') {
        gesture.anchor = position.current; gesture.x = gesture.lastX; gesture.fine = e.type === 'keydown';
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', modifier);
    window.addEventListener('keyup', modifier);
    return () => {
      node.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', modifier);
      window.removeEventListener('keyup', modifier);
      // Release a gesture if the song/view disappears, preserving its last audible value.
      if (drag.current) { drag.current = null; commit(); }
    };
  }, [commit, finish, live]);
  const reset = () => { if (drag.current) finish(true); live(UNITY_POSITION); commit(); };
  const text = formatDb(gainToDb(level / 100));
  return <>
    <div className="fx-fader" ref={slider} role="slider" tabIndex={0} aria-label={name}
      aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={1} aria-valuenow={gainToPosition(level / 100)} aria-valuetext={text}
      title={t("Double-click: 0 dB · ⇧ while dragging: fine")}
      style={{ '--fader-position': `${gainToPosition(level / 100) * 100}%` } as CSSProperties}
      onPointerDown={e => {
        if (e.button !== 0 || drag.current) return;
        e.preventDefault(); e.currentTarget.focus();
        if (e.altKey || e.detail === 2) { reset(); return; }
        const rect = e.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const original = position.current;
        const x = e.clientX - rect.left;
        // The cap is 10 px wide. Grabbing either edge must not jump.
        if (Math.abs(x - original * rect.width) > 5) live(clamp(x / rect.width));
        drag.current = { id: e.pointerId, original, anchor: position.current, x: e.clientX, lastX: e.clientX, width: rect.width, fine: e.shiftKey };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const gesture = drag.current;
        if (!gesture || gesture.id !== e.pointerId) return;
        if (gesture.fine !== e.shiftKey) {
          gesture.anchor = position.current; gesture.x = e.clientX; gesture.fine = e.shiftKey;
        }
        gesture.lastX = e.clientX;
        let p = clamp(gesture.anchor + (e.clientX - gesture.x) / gesture.width * (gesture.fine ? 0.1 : 1));
        // Eight pixels total travel at unity; fine adjustment bypasses the detent.
        if (!gesture.fine && Math.abs(p - UNITY_POSITION) * gesture.width <= 4) p = UNITY_POSITION;
        live(p);
      }}
      onPointerUp={e => { if (drag.current?.id === e.pointerId) finish(false); }}
      onPointerCancel={e => { if (drag.current?.id === e.pointerId) finish(true); }}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={reset}
      onKeyDown={e => {
        if (drag.current) return;
        const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 };
        let p: number;
        if (e.key === 'Home') p = 0;
        else if (e.key === 'End') p = 1;
        else {
          const delta = e.key === 'PageUp' ? 3 : e.key === 'PageDown' ? -3 : steps[e.key] * (e.shiftKey ? 0.1 : 0.5);
          if (!Number.isFinite(delta)) return;
          if (position.current === 0 && delta < 0) { e.preventDefault(); return; }
          const db = gainToDb(positionToGain(position.current));
          p = gainToPosition(dbToGain((Number.isFinite(db) ? db : -60) + delta));
        }
        e.preventDefault(); live(p); commit();
      }}>
      <div className="fx-track" aria-hidden="true"><i /></div>
      {FADER_TICKS.map(tick => <span key={tick.db} aria-hidden="true" className={`fx-tick${tick.db === 0 ? ' is-unity' : ''}`} style={{ left: `${tick.position * 100}%` }} />)}
      <div className="fx-cap" aria-hidden="true" />
    </div>
    <span className="fx-val" ref={readout} aria-hidden="true">{text}</span>
  </>;
}

export function FaderScales() {
  return <div className="fx-scales" aria-hidden="true">{[0, 1].map(column => <div className="fx-scale" key={column}>
    <span /><span className="fx-scale__r">{FADER_TICKS.map(tick => <b key={tick.db} style={{ left: `${tick.position * 100}%` }}>{tick.label}</b>)}</span><span /><span />
  </div>)}</div>;
}
