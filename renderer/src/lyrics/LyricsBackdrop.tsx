import React from "react";

/**
 * The artwork backdrop, in CSS: the same cover four times, blurred and
 * oversaturated, each copy turning on its own clock. The blur sits on the
 * `<img>` and the rotation on its wrapper, so WebKit rasterises the filter
 * once and the animation is a compositor transform. Under a dark scrim, so
 * the white text reads on a white sleeve too.
 */
const LyricsBackdrop = React.memo(function LyricsBackdrop({ cover }: { cover: string | null }) {
  return (
    <div className="lyrics-bg" aria-hidden>
      {cover &&
        [0, 1, 2, 3].map((i) => (
          <div key={i} className={`lyrics-bg-blob lyrics-bg-blob--${i}`}>
            <img src={cover} alt="" draggable={false} />
          </div>
        ))}
      <div className="lyrics-bg-scrim" />
    </div>
  );
});

export default LyricsBackdrop;
