import type { BrowseAcquisition } from "./acquisition.types";
import type { CatalogCard } from "./cards.types";
/**
 * A genre, inside the app: its own chart.
 *
 * Opened from Browse's genre circles. One `/chart/{id}` answers all four
 * panels; the genre's top songs, albums, artists and lists; so the page is
 * two requests including the header, cached for a day like any entity page.
 */
import type { BrowseLoadOptions } from "./useBrowseResource";
import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CardArt, CardCell, MediaCard as LegacyMediaCard, ProviderChip } from "../ui/components/MediaCard";
import { BrowseSkeleton, EmptyState, ErrorState } from "./BrowseStates";
import { ISRC_NOTICE, TrackList } from "./TrackList";
import { AcquireBar } from "./AcquireBar";
import { ArtistTag, EntityList, EntityRow, ExplorePanel, FillGrid, TagWrap } from "./ExplorePanel";
import { fetchGenre } from "./browseApi";
import { push, routeFor } from "./navigationStore";
import { useAcquisition } from "./useAcquisition";
import { useBrowseResource } from "./useBrowseResource";

// The legacy component supports percentage sizes; its default infers number.
const MediaCard = LegacyMediaCard as CatalogCard;

export default function GenrePage({ provider, id }: { provider: string; id: string }) {
  const { t } = useTranslation();
  const loader = useCallback(
    ({ refresh, signal }: BrowseLoadOptions) => fetchGenre(provider, id, { refresh, signal }),
    [provider, id],
  );
  const { data, error, loading, reload } = useBrowseResource(loader, [provider, id]);
  const [ownershipKey, setOwnershipKey] = useState(0);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1)) as BrowseAcquisition;

  if (loading && !data) return <BrowseSkeleton />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { genre, tracks, albums, artists, playlists } = data;
  const open = (entity: Parameters<typeof routeFor>[0], kind: string) => {
    const route = routeFor(entity, kind);
    if (route) push(route);
  };
  const nothing = !tracks?.length && !albums?.length && !artists?.length && !playlists?.length;

  return (
    <div className="flex flex-col gap-6 pb-8">
      <header className="flex gap-5 items-center flex-wrap">
        {/* Round, like the circle it was opened from. */}
        <CardArt title={genre.name} imageUrl={genre.imageUrl} round size={120} />
        <div className="flex flex-col gap-2 min-w-0">
          <ProviderChip name={genre.ref?.provider === "deezer" ? "Deezer" : genre.ref?.provider} />
          <h1 className="m-0 text-[28px] leading-tight font-extrabold text-black break-words">{genre.name}</h1>
          <p className="m-0 text-[12.5px] text-[var(--ink-3)]">{t("What this genre is playing right now.")}</p>
          <button type="button" className="explore-button self-start" onClick={() => reload(true)}>
            <RotateCcw size={14} strokeWidth={2.5} /> {t("Refresh")}
          </button>
        </div>
      </header>

      {nothing ? (
        <EmptyState>{t("This source returned nothing for this genre.")}</EmptyState>
      ) : (
        <div className="explore-columns">
          <div className="flex flex-col gap-6 min-w-0">
            {albums?.length ? (
              <ExplorePanel title={t("Albums")} accent="var(--coral)" count={albums.length} bodyClassName="p-4 flex flex-col">
                <FillGrid
                  items={albums}
                  renderItem={(album) => (
                    <CardCell width={undefined} key={album.ref.id}>
                      <MediaCard title={album.title} subtitle={album.artistName} imageUrl={album.coverUrl} kind="album" size="100%" onOpen={() => open(album, "album")} />
                    </CardCell>
                  )}
                />
              </ExplorePanel>
            ) : null}
            {playlists?.length ? (
              <ExplorePanel title={t("Playlists")} accent="var(--blue)" count={playlists.length}>
                <EntityList>
                  {playlists.map((playlist) => (
                    <EntityRow key={playlist.ref.id} title={playlist.title} subtitle={playlist.owner} imageUrl={playlist.pictureUrl} onOpen={() => open(playlist, "playlist")} />
                  ))}
                </EntityList>
              </ExplorePanel>
            ) : null}
          </div>

          <div className="flex flex-col gap-6 min-w-0">
            {tracks?.length ? (
              <ExplorePanel title={t("Trending songs")} accent="var(--yellow)" count={tracks.length} bodyClassName="flex flex-col">
                <p className="m-0 px-4 pt-3 text-[11.5px] text-[var(--ink-3)]">{t(ISRC_NOTICE)}</p>
                <div className="px-4 pt-3 empty:hidden"><AcquireBar acquisition={acquisition} /></div>
                <div className="pt-2">
                  <TrackList
                    tracks={tracks}
                    showArtist
                    showDuration={false}
                    ownershipKey={ownershipKey}
                    onAcquire={(track) => acquisition.acquire([track])}
                    acquiring={acquisition.active}
                    acquisition={acquisition}
                    onOpenAlbum={(track) => open({ ref: track.albumRef, title: track.albumTitle }, "album")}
                  />
                </div>
              </ExplorePanel>
            ) : null}
            {artists?.length ? (
              <ExplorePanel title={t("Artists")} accent="var(--teal)" count={artists.length}>
                <TagWrap>
                  {artists.map((artist) => (
                    <ArtistTag key={artist.ref.id} name={artist.name} imageUrl={artist.imageUrl} onOpen={() => open({ ...artist, title: artist.name }, "artist")} />
                  ))}
                </TagWrap>
              </ExplorePanel>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
