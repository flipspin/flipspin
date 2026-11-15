import React, { type RefObject } from "react";
import type { TFunction } from "i18next";
import { formatStamp, type LyricLine } from "./lrc";

/** The lines; only a change of `current` (a line transition) re-renders it. */
const LyricList = React.memo(function LyricList({ lines, current, synced, lowLines, isPlayingThis, seek, lineRefs, t, picked, onPick }: {
  lines: LyricLine[]; current: number; synced: boolean; lowLines: Set<number>;
  isPlayingThis: boolean; seek: (seconds: number) => void;
  lineRefs: RefObject<Array<HTMLLIElement | null>>; t: TFunction;
  picked?: number | null; onPick?: (index: number) => void;
}) {
  return (
    <ol className={`lyrics-lines${onPick ? " is-picking" : ""}`}>
      {lines.map((line, i) => {
        const state = i === current ? "cur" : synced && i < current ? "past" : "";
        const doubtful = lowLines.has(i);
        return (
          <li
            key={i}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className={`lyrics-line ${state}${doubtful ? " dudosa" : ""}${onPick && i === picked ? " is-picked" : ""}`}
            tabIndex={onPick ? 0 : -1}
            title={doubtful ? t("Timing uncertain") : undefined}
            onClick={onPick ? () => onPick(i) : line.time !== null && isPlayingThis ? () => seek(line.time) : undefined}
            onKeyDown={onPick ? event => { if (event.key === "Enter") { event.preventDefault(); onPick(i); } } : undefined}
            aria-pressed={onPick ? i === picked : undefined}
            role={onPick || (line.time !== null && isPlayingThis) ? "button" : undefined}
          >
            <span className="lyrics-stamp">{synced ? formatStamp(line.time) : ""}</span>
            <span className="lyrics-text">{line.text || "♪"}</span>
          </li>
        );
      })}
    </ol>
  );
});

export default LyricList;
