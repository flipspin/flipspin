import type { openTrackInfo } from "../library/tracks/trackInfoStore";
import type { AudioPlayerValue } from "../state/AudioPlayerContext";
import React from "react";
import { useHeld } from "../ui/react/useHeld";
import { useVizOpen } from "../viz/vizStore";
import { MatchHost } from "../match/MatchWindow";
import { closeLyricsModal, lyricsKeyOf, openLyricsModal, useLyricsModalRelPath, useLyricsOverlayRelPath } from "../lyrics/lyricsStore";

const LyricsOverlay = React.lazy(() => import("../lyrics/LyricsOverlay"));
const VizOverlay = React.lazy(() => import("../viz/VizOverlay"));
const LyricsModal = React.lazy(() => import("../lyrics/LyricsModal"));

/**
 * What draws over the page: full-screen lyrics for the playing song (its state
 * lives in lyricsStore so it survives a page change), the visualizer and the
 * "Lyrics…" modal (the same one the tables open). Its own
 * component, so only it subscribes to those stores.
 */
export default function Overlays({ onOpenInfo, selectedTrack }: Pick<AudioPlayerValue, "selectedTrack"> & { onOpenInfo: typeof openTrackInfo }) {
  const lyricsOverlayRel = useLyricsOverlayRelPath();
  const lyricsModalRel = useLyricsModalRelPath();
  const heldLyricsModalRel = useHeld(lyricsModalRel);
  const vizOpen = useVizOpen();
  return (
    <>
      <MatchHost />
      {lyricsOverlayRel && (
        <React.Suspense fallback={null}>
          <LyricsOverlay onOpenInfo={onOpenInfo as React.ComponentProps<typeof LyricsOverlay>["onOpenInfo"]} onOpenModal={(rel) => openLyricsModal(rel)} />
        </React.Suspense>
      )}
      {vizOpen && (
        <React.Suspense fallback={null}>
          <VizOverlay />
        </React.Suspense>
      )}
      {heldLyricsModalRel && (
        <React.Suspense fallback={null}>
          <LyricsModal
            open={!!lyricsModalRel}
            relPath={lyricsModalRel}
            track={lyricsKeyOf(selectedTrack) === lyricsModalRel ? selectedTrack : null}
            onClose={closeLyricsModal}
          />
        </React.Suspense>
      )}
    </>
  );
}
