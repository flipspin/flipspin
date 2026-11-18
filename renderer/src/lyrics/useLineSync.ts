import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { currentLineIndex, offsetAtPlayhead, parseLyrics, setLyricsOffset } from "./lrc";
import { lyricsKeyOf } from "./lyricsStore";

/** Local to one lyrics surface: no document/window keyboard listener. */
export function useLineSync(relPath: string, text: string, shown: number, enabled: boolean, save: (seconds: number) => Promise<void>) {
  const player = useAudioPlayer();
  const [picked, setPicked] = useState<number | null>(null);
  const preparing = useRef(false);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  // A pending tag write is still the same lyric and must not cancel a pick.
  const identity = useMemo(() => setLyricsOffset(text, 0), [text]);
  const stamps = useMemo(() => parseLyrics(identity, 0), [identity]);
  const active = enabled && picked !== null;
  const cancel = () => { setPicked(null); cleanup.current?.(); cleanup.current = undefined; preparing.current = false; };
  useEffect(() => {
    setPicked(null);
    return () => { cleanup.current?.(); cleanup.current = undefined; preparing.current = false; };
  }, [relPath, identity, enabled]);
  const position = () => player.audioRef.current?.currentTime ?? 0;
  const enter = () => {
    const current = lyricsKeyOf(player.nowPlaying) === relPath ? currentLineIndex(parseLyrics(text, shown * 1000), position()) : -1;
    setPicked(Math.max(0, current));
  };
  const now = () => {
    if (!active || preparing.current) return;
    const stamp = stamps[picked]?.time;
    const audio = player.audioRef.current;
    if (stamp == null || !audio) return;
    const matching = lyricsKeyOf(player.nowPlaying) === relPath;
    if (!matching || !player.isPlaying) {
      const from = Math.max(0, stamp - shown - 3);
      if (!matching) {
        preparing.current = true;
        const ready = () => { audio.currentTime = from; preparing.current = false; cleanup.current?.(); cleanup.current = undefined; };
        audio.addEventListener("loadedmetadata", ready, { once: true });
        cleanup.current = () => audio.removeEventListener("loadedmetadata", ready);
        player.play({ path: relPath });
      } else {
        audio.currentTime = from;
        player.setIsPlaying(true);
      }
      return;
    }
    void save(offsetAtPlayhead(stamp, position()));
    cancel();
  };
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (event.code === "Space" || event.key === " ") {
      if (event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable)) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) now();
    }
  };
  return { active, picked: active ? picked : null, line: active ? stamps[picked]?.text ?? "" : "", enter, cancel, pick: setPicked, now, onKeyDownCapture };
}
export type LineSync = ReturnType<typeof useLineSync>;
