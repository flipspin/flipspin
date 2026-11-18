import { Profiler } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import Fader from './Fader';
import { dbToGain, dbToPosition, formatDb, gainToDb, gainToPosition, loadMix, originalMix, positionToDb, positionToGain, saveMix, UNITY_POSITION } from './mix';

beforeAll(() => {
  // jsdom has no PointerEvent/capture. Retain the coordinates and modifiers used by browsers.
  class Pointer extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', Pointer);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
function setup(db = -10) {
  const onLive = vi.fn(), onCommit = vi.fn(), renders = vi.fn();
  const props = { name: 'Voz', level: dbToGain(db) * 100, onLive, onCommit };
  const view = render(<Profiler id="fader" onRender={renders}><Fader {...props} /></Profiler>);
  const slider = screen.getByRole('slider');
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 300 } as DOMRect);
  const down = (x = gainToPosition(props.level / 100) * 300, extra = {}) => fireEvent.pointerDown(slider, { clientX: 10 + x, pointerId: 1, button: 0, ...extra });
  const move = (x: number, extra = {}) => fireEvent.pointerMove(slider, { clientX: 10 + x, pointerId: 1, ...extra });
  const up = () => fireEvent.pointerUp(slider, { pointerId: 1 });
  return { ...view, props, slider, down, move, up, onLive, onCommit, renders };
}

describe('Ardour law and linear mix compatibility', () => {
  it('round-trips p ↔ dB continuously across the travel', () => {
    for (const p of [0.001, 0.03, 0.1, 0.31, 0.5, UNITY_POSITION, 0.9, 1]) {
      expect(dbToPosition(positionToDb(p))).toBeCloseTo(p, 12);
    }
    for (const db of [-90, -60, -20, -10, -6, -3.5, 0, 2, 6]) expect(positionToDb(dbToPosition(db))).toBeCloseTo(db, 10);
  });
  it('has silence at zero, exact unity at about .7818 and a 2× (+6.02 dB) ceiling', () => {
    expect(positionToGain(0)).toBe(0); expect(positionToDb(0)).toBe(-Infinity); expect(dbToPosition(-Infinity)).toBe(0);
    expect(UNITY_POSITION).toBeCloseTo(0.7818, 4); expect(positionToGain(UNITY_POSITION)).toBe(1);
    expect(dbToPosition(-300)).toBe(0); expect(positionToGain(1)).toBe(2); expect(positionToDb(1)).toBeCloseTo(6.0206, 4);
  });
  it.each([[-3.5, '−3.5 dB'], [2, '+2.0 dB'], [0, '0.0 dB'], [-0.001, '0.0 dB'], [-Infinity, '−∞'], [6.0206, '+6.0 dB'], [-90, '−90.0 dB']])('formats %s as %s', (db, text) => expect(formatDb(db)).toBe(text));
  it('reads old mixes without reinterpretation and retains boost up to 200', () => {
    const mix = { ...originalMix(), levels: { drums: 100, bass: 200, other: 150, vocals: 20 } };
    saveMix(mix); expect(loadMix()).toEqual(mix); expect(gainToDb(loadMix().levels.vocals / 100)).toBeCloseTo(-13.9794, 4);
    localStorage.setItem('krobi.mix', JSON.stringify({ levels: { bass: 400, vocals: -10 } }));
    expect(loadMix().levels).toEqual({ drums: 100, bass: 200, other: 100, vocals: 0 });
    localStorage.removeItem('krobi.mix');
  });
});

describe('fader gestures', () => {
  it('grabs either edge without jumping, captures, drags relative continuously, and commits once on release without pointermove renders', () => {
    const f = setup(); const x = dbToPosition(-10) * 300;
    f.down(x + 4); expect(f.onLive).not.toHaveBeenCalled(); expect(f.slider.setPointerCapture).toHaveBeenCalledWith(1);
    const renders = f.renders.mock.calls.length;
    f.move(x + 4 + 17.35);
    expect(f.onLive).toHaveBeenLastCalledWith(positionToGain(dbToPosition(-10) + 17.35 / 300) * 100);
    expect(f.onCommit).not.toHaveBeenCalled(); expect(f.renders).toHaveBeenCalledTimes(renders);
    expect(f.slider).toHaveAttribute('aria-valuetext', formatDb(gainToDb(f.onLive.mock.lastCall![0] / 100)));
    expect(f.slider.style.getPropertyValue('--fader-position')).not.toBe('');
    f.up(); expect(f.onCommit).toHaveBeenCalledTimes(1); expect(f.onCommit).toHaveBeenLastCalledWith(f.onLive.mock.lastCall![0]);
  });
  it('jumps on track click and keeps dragging relative to that point', () => {
    const f = setup(); f.down(60); expect(f.onLive).toHaveBeenLastCalledWith(positionToGain(0.2) * 100);
    f.move(90); expect(f.onLive.mock.lastCall![0]).toBeCloseTo(positionToGain(0.3) * 100, 10); f.up();
  });
  it('scales Shift motion ×.1 and re-anchors on both modifier transitions', () => {
    const f = setup(-20); const x = dbToPosition(-20) * 300;
    f.down(x, { shiftKey: true }); f.move(x + 30, { shiftKey: true });
    expect(f.onLive.mock.lastCall![0]).toBeCloseTo(positionToGain(dbToPosition(-20) + 0.01) * 100, 10);
    fireEvent.keyUp(window, { key: 'Shift' }); f.move(x + 60);
    expect(f.onLive.mock.lastCall![0]).toBeCloseTo(positionToGain(dbToPosition(-20) + 0.11) * 100, 10);
    fireEvent.keyDown(window, { key: 'Shift' }); f.move(x + 90, { shiftKey: true });
    expect(f.onLive.mock.lastCall![0]).toBeCloseTo(positionToGain(dbToPosition(-20) + 0.12) * 100, 10); f.up();
  });
  it('re-anchors when the pointer event itself first reports a modifier change', () => {
    const f = setup(); const x = dbToPosition(-10) * 300;
    f.down(); f.move(x + 10); const value = f.onLive.mock.lastCall![0];
    f.move(x + 10, { shiftKey: true }); expect(f.onLive).toHaveBeenLastCalledWith(value);
    f.move(x + 30, { shiftKey: true }); expect(f.onLive.mock.lastCall![0]).toBeCloseTo(positionToGain(dbToPosition(-10) + 12 / 300) * 100, 10); f.up();
  });
  it('holds exactly 0 dB over an eight-pixel detent and bypasses it with Shift', () => {
    const f = setup(0); const x = UNITY_POSITION * 300;
    f.down(); f.move(x + 3.9); expect(f.onLive).toHaveBeenLastCalledWith(100);
    f.move(x - 3.9); expect(f.onLive).toHaveBeenLastCalledWith(100);
    f.move(x + 4.1); expect(f.onLive.mock.lastCall![0]).toBeGreaterThan(100);
    fireEvent.keyDown(window, { key: 'Escape' });
    f.down(x, { shiftKey: true }); f.move(x + 3, { shiftKey: true }); expect(f.onLive.mock.lastCall![0]).toBeGreaterThan(100); f.up();
  });
  it('Esc and pointercancel restore the value from press, including a track jump', () => {
    const f = setup(-3.5); f.down(20); fireEvent.keyDown(window, { key: 'Escape' });
    expect(f.onCommit.mock.lastCall![0]).toBeCloseTo(dbToGain(-3.5) * 100, 10);
    f.down(30); fireEvent.pointerCancel(f.slider, { pointerId: 1 }); expect(f.onCommit.mock.lastCall![0]).toBeCloseTo(dbToGain(-3.5) * 100, 10);
  });
  it('double-click and Option-click reset to unity', () => {
    const f = setup(); fireEvent.doubleClick(f.slider); expect(f.onCommit).toHaveBeenLastCalledWith(100);
    f.down(20, { altKey: true }); expect(f.onCommit).toHaveBeenLastCalledWith(100); expect(f.onCommit).toHaveBeenCalledTimes(2);
  });
  it('ignores unrelated pointers, wheel and level prop updates during a captured drag', () => {
    const f = setup(); f.down(); f.move(dbToPosition(-10) * 300 + 15);
    const liveCalls = f.onLive.mock.calls.length;
    fireEvent.pointerMove(f.slider, { pointerId: 2, clientX: 2 }); fireEvent.wheel(f.slider, { deltaY: -1 });
    f.rerender(<Fader {...f.props} level={0} />);
    expect(f.onLive).toHaveBeenCalledTimes(liveCalls); expect(f.slider).not.toHaveAttribute('aria-valuetext', '−∞'); f.up();
  });
  it('wheel moves .5 dB or .1 dB with Shift and prevents page scrolling', () => {
    const f = setup(0);
    expect(fireEvent.wheel(f.slider, { deltaY: 1, cancelable: true })).toBe(false);
    expect(f.slider).toHaveAttribute('aria-valuetext', '−0.5 dB');
    fireEvent.wheel(f.slider, { deltaY: -1, shiftKey: true }); expect(f.slider).toHaveAttribute('aria-valuetext', '−0.4 dB');
    expect(f.onCommit).toHaveBeenCalledTimes(2);
  });
  it('keys use .5/.1 dB, pages 3 dB, Home silence, End boost; all update ARIA', () => {
    const f = setup(0);
    for (const [key, shiftKey, text] of [['ArrowLeft', false, '−0.5 dB'], ['ArrowRight', true, '−0.4 dB'], ['PageDown', false, '−3.4 dB'], ['PageUp', false, '−0.4 dB'], ['Home', false, '−∞'], ['ArrowRight', false, '−59.5 dB'], ['End', false, '+6.0 dB']] as const) {
      fireEvent.keyDown(f.slider, { key, shiftKey }); expect(f.slider).toHaveAttribute('aria-valuetext', text);
    }
    expect(f.onCommit).toHaveBeenLastCalledWith(200);
  });
  it('keeps silence when stepping down at Home, and leaves it when stepping up', () => {
    const f = setup(-Infinity);
    fireEvent.keyDown(f.slider, { key: 'ArrowLeft' }); fireEvent.wheel(f.slider, { deltaY: 1 });
    expect(f.slider).toHaveAttribute('aria-valuetext', '−∞'); expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.wheel(f.slider, { deltaY: -1 }); expect(f.slider).toHaveAttribute('aria-valuetext', '−59.5 dB');
  });
  it('does not snap continuous sub-decimal movement to display precision', () => {
    const f = setup(-20); f.down(); f.move(dbToPosition(-20) * 300 + 0.123);
    const level = f.onLive.mock.lastCall![0]; expect(gainToDb(level / 100)).not.toBe(Number(gainToDb(level / 100).toFixed(1))); f.up();
  });
  it('commits the last audible value if the view is removed mid-gesture', () => {
    const f = setup(); f.down(); f.move(100); act(() => f.unmount());
    expect(f.onCommit).toHaveBeenCalledTimes(1); expect(f.onCommit).toHaveBeenLastCalledWith(f.onLive.mock.lastCall![0]);
  });
});
