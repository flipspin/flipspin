import type { AudioPlayerValue } from "../state/AudioPlayerContext";
import { useEffect, useRef } from "react";
import { closeViz, toggleViz } from "../viz/vizStore";
import { focusSearch, focusSearchWhenReady, isSearchShortcut } from "../library/tracks/searchShortcut";
import { closeLyrics, lyricsKeyOf, openLyricsOrAdd } from "../lyrics/lyricsStore";

/**
 * The window's keys. ⌘K / Ctrl+K: the persistent library search, with the
 * page's own search as a fallback when the shell is absent.
 * Answered even from inside a text field, unlike the bare keys: Space
 * play/pause, D the visualizer, L the lyrics. The list Settings → Atajos shows
 * is this one.
 */
export function useGlobalKeys({ selectedTrack, lyricsOpen, setIsPlaying, openLibrary }: Pick<AudioPlayerValue, "selectedTrack" | "setIsPlaying"> & { lyricsOpen: boolean; openLibrary: () => void }) {
  const selectedTrackRef = useRef(selectedTrack);
  selectedTrackRef.current = selectedTrack;
  const lyricsOpenRef = useRef(lyricsOpen);
  lyricsOpenRef.current = lyricsOpen;
  const openLibraryRef = useRef(openLibrary);
  openLibraryRef.current = openLibrary;

  useEffect(() => {
    function onSearchKey(e: KeyboardEvent) {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      closeViz();
      closeLyrics();
      if (focusSearch()) return;
      focusSearchWhenReady();
      openLibraryRef.current();
    }
    window.addEventListener("keydown", onSearchKey);
    return () => window.removeEventListener("keydown", onSearchKey);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey; // ⌘D, Ctrl+L belong to the system
      const key = e.key?.toLowerCase();
      // The two full-screen views swap: one on top of the other would be two
      // draw loops on the analyser, and nothing to see of the one underneath.
      if (key === "d" && bare) {
        e.preventDefault();
        closeLyrics();
        toggleViz();
        return;
      }
      if (key === "l" && bare) {
        e.preventDefault();
        const rel = lyricsKeyOf(selectedTrackRef.current);
        if (lyricsOpenRef.current) closeLyrics();
        else if (rel) {
          closeViz();
          void openLyricsOrAdd(rel);
        }
        return;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        setIsPlaying((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsPlaying]);
}
