import { act } from '@testing-library/react';
import { setLibraryPresence } from '../library/trackPresence';
import i18n from '../i18n';
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QueueList from "./QueueList";

vi.mock("../ui/components/CoverTile", () => ({ default: () => <span /> }));

const tracks = ["First", "Second", "Third"].map(title => ({ title, path: `music/${title}.mp3`, artist: "Artist" }));
function Queue({ onReorder }) {
  const [queue, setQueue] = useState(tracks);
  const scrollerRef = useRef<HTMLDivElement>(null);
  return <div ref={scrollerRef}><QueueList queue={queue} scrollerRef={scrollerRef} coverOf={() => null} labelOf={track => track.title}
    onPlay={vi.fn()} onRemove={vi.fn()} onReorder={(from, to) => {
      onReorder(from, to);
      setQueue(old => { const next = [...old]; next.splice(to, 0, ...next.splice(from, 1)); return next; });
    }} /></div>;
}

describe("QueueList sorting through useSortableList", () => {
  it("retains lifted styling, sibling movement, release-once commit, keyboard focus and announcements", () => {
    const reorder = vi.fn();
    const { container } = render(<Queue onReorder={reorder} />);
    [...container.querySelectorAll(".qrow")].forEach((row, i) => Object.defineProperties(row, { offsetTop: { value: i * 51 }, offsetHeight: { value: 44 } }));
    const grip = screen.getByRole("button", { name: "Arrastrar First para reordenar" });
    grip.setPointerCapture = vi.fn();
    const pointer = (type: string, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 5 });
      fireEvent(grip, event);
    };
    pointer("pointerdown", 22);
    pointer("pointermove", 130);
    expect(grip.closest(".qrow")).toHaveClass("qrow--lifted");
    expect(screen.getByRole("button", { name: "Arrastrar Second para reordenar" }).closest<HTMLElement>(".qrow")!.style.transform).toBe("translateY(-51px)");
    expect(reorder).not.toHaveBeenCalled();
    pointer("pointerup", 130);
    expect(reorder).toHaveBeenCalledExactlyOnceWith(0, 2);
    expect(screen.getByText("Movida a la posición 3 de 3")).toBeInTheDocument();
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(reorder).toHaveBeenLastCalledWith(2, 1);
    expect(grip).toHaveFocus();
    expect(screen.getByText("Movida a la posición 2 de 3")).toBeInTheDocument();
  });
});

it('renders stale queue entries without Deleted labels or muted styling', async () => {
  await i18n.changeLanguage('en');
  setLibraryPresence([{ tracks: [tracks[1], tracks[2]] }]);
  try {
    const { container } = render(<Queue onReorder={vi.fn()} />);
    expect(screen.queryByText('Deleted')).toBeNull();
    expect(screen.queryByTitle('Not in your library anymore')).toBeNull();
    expect(container.querySelectorAll('.qrow')).toHaveLength(3);
    expect([...container.querySelectorAll<HTMLElement>('.qrow')].every(row => row.style.opacity === '')).toBe(true);
  } finally { act(() => setLibraryPresence()); await i18n.changeLanguage('es'); }
});
