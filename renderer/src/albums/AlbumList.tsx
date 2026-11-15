import type { StatusActions } from "../browse/cards.types";
import type { LibraryAlbum } from "./library.types";
import React, { useRef, useEffect, useCallback } from "react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { useSettings } from "@state/SettingsContext";
import { decorate } from "../home/decorateTrack";
import { useStatus } from "../state/useStatus";
import { useLibraryView } from "./hooks/useLibraryView";
import { useAlbumActions } from "./hooks/useAlbumActions";
import AlbumListPanel from "./AlbumListPanel";
import { TrackInfoHost } from "../library/tracks/TrackInfoModal";
import { openTrackInfo } from "../library/tracks/trackInfoStore";
import { LibraryEmptyState } from "../onboarding/LibraryEmptyState";
import { ContentPlaceholder } from "../ui/components/ContentPlaceholder";
import i18n from "../i18n";

type Props = { albums: LibraryAlbum[]; albumsLoaded?: boolean; _onUploadVLC?: unknown; onLibraryChanged?: () => unknown };

class AlbumErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: unknown }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("AlbumList crashed:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-[#C13A5C] text-white rounded">
          {/* A class component: `i18n.t` at render time, which is still call time. */}
          <div className="font-bold mb-2">{i18n.t("The library failed")}</div>
          <div className="text-sm whitespace-pre-wrap">{String(this.state.error || "")}</div>
          <button
            className="mt-2 px-2 py-1 bg-white text-[#8B1A4A] rounded"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            {i18n.t("Retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AlbumListInner({ albums, albumsLoaded = true, _onUploadVLC, onLibraryChanged }: Props) {
  const { vlcIp } = useSettings();
  const { status, showSuccess, showError, clear } = useStatus() as StatusActions;
  const {
    audioRef: _audioRef,
    isPlaying,
    setIsPlaying,
    selectedTrack,
    setSelectedTrack,
    visualizationType: _visualizationType,
    setVisualizationType: _setVisualizationType,
    svgWaveformStyle: _svgWaveformStyle,
    setSvgWaveformStyle: _setSvgWaveformStyle,
    audioWaveformStyle: _audioWaveformStyle,
    setAudioWaveformStyle: _setAudioWaveformStyle,
    play,
    goNext: _goNext,
    goPrevious: _goPrevious,
    addToQueue,
    addNextInQueue,
  } = useAudioPlayer();

  const view = useLibraryView(albums);

  const panelsRef = useRef<HTMLDivElement>(null);

  // One decorator for the Library and Home (home/decorateTrack.ts): a
  // queued track carries a stub of its album, never the album with its tracks.
  const decorateTrack = decorate;

  const highlightMatches = useCallback((text: string, query: string) => {
    if (!query.trim()) return text;
    try {
      const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
      return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="bg-[var(--coral)] text-white">{part}</span>
        ) : (
          part
        )
      );
    } catch {
      return text;
    }
  }, []);

  const { sendItems } = useAlbumActions({ vlcIp });

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => clear(), 2000);
    return () => clearTimeout(t);
  }, [status, clear]);


  if (!albumsLoaded) return <ContentPlaceholder count={5} />;

  if (!albums || albums.length === 0) {
    return <LibraryEmptyState />;
  }

  return (  
    <div className="flex flex-col flex-1 min-h-0 p-6 overflow-hidden text-ink">
      <div ref={panelsRef} className="flex flex-col flex-1 min-h-0 min-w-0 w-full overflow-hidden">
        <AlbumListPanel
          view={view}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          selectedTrack={selectedTrack}
          {...{ setSelectedTrack }}
          play={play}
          decorateTrack={decorateTrack}
          highlightMatches={highlightMatches}
          addToQueue={addToQueue}
          addNextInQueue={addNextInQueue}
          sendItems={sendItems}
          onOpenAnalysis={openTrackInfo as React.ComponentProps<typeof AlbumListPanel>["onOpenAnalysis"]}
          showSuccess={showSuccess}
          showError={showError}
          onLibraryChanged={onLibraryChanged}
        />
      </div>
      <style>
      {`
          .scrollbar-hide::-webkit-scrollbar { display: none; }
          .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}  
      </style>
      <TrackInfoHost />
    </div>
  );
}

export default function AlbumList(props: Props) {
  return (
    <AlbumErrorBoundary>
      <AlbumListInner {...props} />
    </AlbumErrorBoundary>
  );
}
