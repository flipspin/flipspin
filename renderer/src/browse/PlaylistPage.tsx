import type { BrowseCollectionActions, BrowseAcquisition } from "./acquisition.types";
/** Deezer includes ISRCs in playlist rows, so no second track request is needed.
 * Acquire without a folder override to preserve the library's album/file layout. */
import type { BrowseLoadOptions } from "./useBrowseResource";
import { useCallback, useState } from "react";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CardArt, ProviderChip } from "../ui/components/MediaCard";
import { formatDuration, openExternal } from "../ui/components/cardArt";
import { BrowseSkeleton, EmptyState, ErrorState } from "./BrowseStates";
import { TrackList } from "./TrackList";
import { fetchPlaylist } from "./browseApi";
import { useAcquisition } from "./useAcquisition";
import { useBrowseResource } from "./useBrowseResource";
import LegacyCollectionActions from "../acquisition/CollectionActions";
import { AcquireBar } from "./AcquireBar";
import { ExplorePanel } from "./ExplorePanel";

const CollectionActions = LegacyCollectionActions as BrowseCollectionActions;

export default function PlaylistPage({ provider, id }: { provider: string; id: string }) {
  const { t } = useTranslation();
  const loader = useCallback(
    ({ refresh, signal }: BrowseLoadOptions) => fetchPlaylist(provider, id, { refresh, signal }),
    [provider, id],
  );
  const { data, error, loading, reload } = useBrowseResource(loader, [provider, id]);
  const [ownershipKey, setOwnershipKey] = useState(0);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1), { kind: "playlist", provider, provider_id: id, title: data?.playlist?.title || "" }) as BrowseAcquisition;

  if (loading && !data) return <BrowseSkeleton />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { playlist, tracks } = data;
  const totalSeconds = (tracks || []).reduce((sum, t) => sum + (t.durationSeconds || 0), 0);

  return (
    <div className="flex flex-col gap-6 pb-8">
      <header className="flex gap-5 flex-wrap">
        <CardArt title={playlist.title} imageUrl={playlist.pictureUrl} size={188} />
        <div className="flex flex-col gap-2 min-w-0 flex-1 pt-1">
          <ProviderChip name={playlist.ref?.provider === "deezer" ? "Deezer" : playlist.ref?.provider} />
          <h1 className="m-0 text-[26px] leading-tight font-extrabold text-black break-words">
            {playlist.title}
          </h1>
          {playlist.owner ? (
            <span className="text-[15px] font-bold text-[var(--ink-2)]">{playlist.owner}</span>
          ) : null}
          <p className="m-0 text-[12.5px] text-[var(--ink-3)]">
            {[
              tracks?.length ? t("{{n}} songs", { count: tracks.length, n: tracks.length }) : null,
              totalSeconds ? formatDuration(totalSeconds) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {playlist.description ? (
            <p className="m-0 text-[12.5px] text-[var(--ink-2)] max-w-[62ch]">{playlist.description}</p>
          ) : null}
          <div className="flex gap-2 mt-1 flex-wrap">
            <button type="button" className="explore-button" onClick={() => reload(true)}>
              <RotateCcw size={14} strokeWidth={2.5} /> {t("Refresh")}
            </button>
            <CollectionActions kind="playlist" refId={id} provider={provider} title={playlist.title} tracks={tracks} catalog acquisition={acquisition} />
            {playlist.ref?.url ? (
              <button
                type="button"
                className="explore-button"
                onClick={() => openExternal(playlist.ref.url)}
              >
                <ExternalLink size={14} strokeWidth={2.5} /> {t("View on Deezer")}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <AcquireBar acquisition={acquisition} />

      {tracks?.length ? (
        <ExplorePanel title={t("Songs")} accent="var(--yellow)" count={tracks.length} bodyClassName="flex flex-col">
          <TrackList
            tracks={tracks}
            showArtist
            ownershipKey={ownershipKey}
            onAcquire={(track) => acquisition.acquire([track])}
                    acquiring={acquisition.active}
            acquisition={acquisition}
          />
        </ExplorePanel>
      ) : (
        <EmptyState>{t("This playlist has no songs.")}</EmptyState>
      )}
    </div>
  );
}
