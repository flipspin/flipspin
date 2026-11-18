import type { BrowseCollectionActions, BrowseAcquisition } from "./acquisition.types";
/** Open provider albums inside the app; retain the provider URL for attribution and external viewing. */
import type { BrowseLoadOptions } from "./useBrowseResource";
import { useCallback, useMemo, useState } from "react";
import { ExternalLink, Play, RotateCcw, Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAudioPlayer } from "@state/AudioPlayerContext";
import CoverTile from "../ui/components/CoverTile";
import { artColorFor, formatDuration, openExternal } from "../ui/components/cardArt";
import { playlistInk } from "../playlists/playlistBadge";
import { BrowseSkeleton, ErrorState } from "./BrowseStates";
import { TrackList, playableFromMatch } from "./TrackList";
import { fetchAlbum } from "./browseApi";
import { push, routeFor } from "./navigationStore";
import { useAcquisition } from "./useAcquisition";
import { useBrowseResource } from "./useBrowseResource";
import LegacyCollectionActions from "../acquisition/CollectionActions";
import { AcquireBar } from "./AcquireBar";
import type { OwnershipVerdict } from "./browseApi";
import type { CSSProperties } from "react";
import { APP_NAME } from "../brand";

const CollectionActions = LegacyCollectionActions as BrowseCollectionActions;

/** The playlist hero's cover size, as on the library's album page: it follows the window. */
const HERO_COVER = "clamp(140px, 18vw, 220px)";

/** Same look as the library's album page (`albums/LibraryAlbumPage.tsx`). */
export default function AlbumPage({ provider, id }: { provider: string; id: string }) {
  const { t } = useTranslation();
  const { setQueueWithTracks, shuffleEnabled, toggleShuffle } = useAudioPlayer();
  const loader = useCallback(
    ({ refresh, signal }: BrowseLoadOptions) => fetchAlbum(provider, id, { refresh, signal }),
    [provider, id],
  );
  const { data, error, loading, reload } = useBrowseResource(loader, [provider, id]);
  const [ownershipKey, setOwnershipKey] = useState(0);
  const [verdicts, setVerdicts] = useState<OwnershipVerdict[]>([]);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1), { kind: "album", provider, provider_id: id, title: data?.album?.title || "" }) as BrowseAcquisition;
  const playables = useMemo(
    () => verdicts.map((v) => (v?.owned ? playableFromMatch(v.match) : null)).filter((track) => track !== null),
    [verdicts],
  );

  if (loading && !data) return <BrowseSkeleton />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { album, tracks } = data;
  const totalSeconds = (tracks || []).reduce((sum, t) => sum + (t.durationSeconds || 0), 0);
  const year = album.releaseDate ? String(album.releaseDate).slice(0, 4) : null;
  const name = album.title || t("Album");
  const color = artColorFor(name);
  const ink = playlistInk(name);
  const owned = playables.length;
  const count = tracks?.length || 0;

  const openArtist = () => {
    const route = routeFor({ ref: album.artistRef, title: album.artistName }, "artist");
    if (route) push(route);
  };

  const facts = [
    year,
    count
      ? owned && owned < count
        ? t("{{owned}} of {{total}} songs", { owned, total: count })
        : t("{{n}} songs", { count, n: count })
      : null,
    totalSeconds ? formatDuration(totalSeconds) : null,
    album.genres?.length ? album.genres.join(", ") : null,
    album.label,
  ].filter(Boolean);

  return (
    <div className="flex flex-col pb-8">
      <div className="playlist-hero" style={{ "--list-color": color, "--list-ink": ink } as CSSProperties}>
        <header className="playlist-band">
          <div className="playlist-band__cover" style={{ width: HERO_COVER, height: HERO_COVER }}>
            <CoverTile src={album.coverUrl} label={name} fontSize="56px" className="w-full h-full" />
          </div>
          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <span className="text-[12px] font-bold uppercase tracking-wide opacity-80">{album.recordType || t("Album")}</span>
            <h1 className="playlist-band__title">{name}</h1>
            <div className="flex items-center gap-2 flex-wrap text-[13px]">
              {album.artistName ? (
                <button
                  type="button"
                  className="playlist-band__owner playlist-band__owner--link"
                  onClick={openArtist}
                  disabled={!album.artistRef}
                  title={t("Go to artist")}
                >
                  {album.artistName}
                </button>
              ) : null}
              <span className="opacity-85">{facts.join(" · ")}</span>
            </div>
            {/* Inside the text column, as on the library's album page. */}
            <div className="playlist-actions">
              <button
                type="button"
                className="playlist-actions__play"
                onClick={() => setQueueWithTracks(playables, 0)}
                disabled={!owned}
                title={t("Play")}
                aria-label={t("Play")}
              >
                <Play size={18} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
              <button
                type="button"
                className={`playlist-actions__icon ${shuffleEnabled ? "is-on" : ""}`}
                onClick={toggleShuffle}
                aria-pressed={shuffleEnabled}
                title={shuffleEnabled ? t("Turn shuffle off") : t("Turn shuffle on")}
                aria-label={t("Shuffle")}
              >
                <Shuffle size={18} strokeWidth={2.25} />
              </button>
              <CollectionActions kind="album" refId={id} provider={provider} title={name} tracks={tracks} catalog verdicts={verdicts} acquisition={acquisition} />
              <button
                type="button"
                className="playlist-actions__icon"
                onClick={() => reload(true)}
                title={t("Refresh")}
                aria-label={t("Refresh")}
              >
                <RotateCcw size={17} strokeWidth={2.25} />
              </button>
              {album.ref?.url ? (
                <button
                  type="button"
                  className="playlist-actions__icon"
                  onClick={() => openExternal(album.ref.url)}
                  title={t("Open at the provider (outside {{app}})", { app: APP_NAME })}
                  aria-label={t("View on Deezer")}
                >
                  <ExternalLink size={17} strokeWidth={2.25} />
                </button>
              ) : null}
              <AcquireBar acquisition={acquisition} inline />
            </div>
          </div>
        </header>
      </div>

      <div
        className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-clip"
        style={{ "--song-table-head": color, "--song-table-head-ink": ink } as CSSProperties}
      >
        <TrackList
          tracks={tracks}
          ownershipKey={ownershipKey}
          onOwnership={setVerdicts}
          // No folder: the backend files each track under its own album,
          // so naming the album here would nest it inside itself.
          onAcquire={(track) => acquisition.acquire([track])}
          acquiring={acquisition.active}
          acquisition={acquisition}
          albumTitle={album.title}
        />
      </div>
    </div>
  );
}
