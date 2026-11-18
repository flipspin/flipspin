import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CoverTile from "./CoverTile";
import { setCoverBackendOnline } from "./coverRetry";

const src = "krobi-media://localhost/api/media/Album/cover.jpg?size=96&v=";

beforeEach(() => {
  vi.useFakeTimers();
  setCoverBackendOnline(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mount() {
  const view = render(<CoverTile src={src} label="Album" />);
  await act(async () => {});
  return view;
}

it("retries a failed cover on a real backend reconnect without changing its media URL", async () => {
  const { container } = await mount();
  const first = container.querySelector("img")!;
  fireEvent.error(first);
  expect(container.querySelector("img")).toBeNull();
  expect(container).toHaveTextContent("A");
  act(() => setCoverBackendOnline(false));
  act(() => setCoverBackendOnline(true));
  const recovered = container.querySelector("img")!;
  expect(recovered).not.toBe(first);
  expect(recovered).toHaveAttribute("src", src);
  fireEvent.load(recovered);
  expect(recovered).toHaveAttribute("data-loaded");
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelector("img")).toBe(recovered);
});

it("bounds persistent 404s to three retries, ignoring repeated healthy statuses until focus", async () => {
  const { container } = await mount();
  fireEvent.error(container.querySelector("img")!);
  for (const delay of [2_000, 8_000, 30_000]) {
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(container.querySelector("img")).toBeNull();
    act(() => setCoverBackendOnline(true));
    expect(container.querySelector("img")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const retry = container.querySelector("img")!;
    expect(retry).toHaveAttribute("src", src);
    fireEvent.error(retry);
  }
  act(() => vi.advanceTimersByTime(300_000));
  act(() => setCoverBackendOnline(true));
  expect(container.querySelector("img")).toBeNull();
  fireEvent.focus(window);
  expect(container.querySelector("img")).toHaveAttribute("src", src);
  fireEvent.error(container.querySelector("img")!);
  act(() => vi.advanceTimersByTime(2_000));
  expect(container.querySelector("img")).toHaveAttribute("src", src);
});

it("cancels the old backoff on recovery and leaves healthy images alone", async () => {
  const listen = vi.spyOn(window, "addEventListener");
  const { container } = render(<>
    <CoverTile src={src} label="Album" />
    <CoverTile src={`${src}2`} label="Other" />
  </>);
  await act(async () => {});
  const [failed, healthy] = container.querySelectorAll("img");
  fireEvent.error(failed);
  act(() => vi.advanceTimersByTime(1_000));
  fireEvent.focus(window);
  const recovered = container.querySelector("img");
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(container.querySelectorAll("img")[0]).toBe(recovered);
  expect(container.querySelectorAll("img")[1]).toBe(healthy);
  expect(listen.mock.calls.filter(([event]) => event === "focus")).toHaveLength(1);
});

it("stops pending retries and recovery subscriptions when tiles are unmounted", async () => {
  const { container, unmount } = await mount();
  fireEvent.error(container.querySelector("img")!);
  unmount();
  fireEvent.focus(window);
  act(() => setCoverBackendOnline(false));
  act(() => setCoverBackendOnline(true));
  act(() => vi.advanceTimersByTime(300_000));
  expect(container.querySelector("img")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("resets the retry budget when the source changes and cancels it when cleared", async () => {
  const { container, rerender } = await mount();
  fireEvent.error(container.querySelector("img")!);
  act(() => vi.advanceTimersByTime(2_000));
  fireEvent.error(container.querySelector("img")!);
  rerender(<CoverTile src={`${src}2`} label="Other" />);
  expect(container.querySelector("img")).toHaveAttribute("src", `${src}2`);
  fireEvent.error(container.querySelector("img")!);
  act(() => vi.advanceTimersByTime(2_000));
  expect(container.querySelector("img")).toHaveAttribute("src", `${src}2`);
  fireEvent.error(container.querySelector("img")!);
  rerender(<CoverTile src={null} label="Other" />);
  fireEvent.focus(window);
  act(() => vi.advanceTimersByTime(300_000));
  expect(container.querySelector("img")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("draws a scaled note, not a text glyph, when there is nothing to cut initials from", () => {
  const view = render(<CoverTile src={null} label="" fontSize="13px" />);
  const note = view.getByTestId("cover-note");
  expect(note.tagName.toLowerCase()).toBe("svg");
  expect(note.getAttribute("class")).toContain("h-[46%]");
  expect(view.container.textContent).toBe("");
  view.rerender(<CoverTile src={null} label="Blue Train" fontSize="13px" />);
  expect(view.queryByTestId("cover-note")).toBeNull();
  expect(view.container.textContent).toBe("BT");
});
