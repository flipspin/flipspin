import type { BrowseAcquisition } from "./acquisition.types";
import type { CatalogCard } from "./cards.types";
/** Omit capabilities the provider does not declare. A declared section in partial
 * is a failure; an empty successful response is an empty section. */
import type { BrowseLoadOptions } from "./useBrowseResource";
import { useCallback, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";

import { CardArt, CardCell, CardGrid, MediaCard as LegacyMediaCard, ProviderChip } from "../ui/components/MediaCard";
import { ArtistTag, EntityList, EntityRow, ExplorePanel, TagWrap } from "./ExplorePanel";
import { openExternal } from "../ui/components/cardArt";
import { BrowseSkeleton, EmptyState, ErrorState } from "./BrowseStates";
import { ISRC_NOTICE, TrackList } from "./TrackList";
import { AcquireBar } from "./AcquireBar";
import { useAcquisition } from "./useAcquisition";
import { fetchArtist } from "./browseApi";
import { push, routeFor } from "./navigationStore";
import { useBrowseResource } from "./useBrowseResource";

// The legacy component supports percentage sizes; its default infers number.
const MediaCard = LegacyMediaCard as CatalogCard;

// `msg` keys: built once at import, translated where rendered with `t(...)`.
const SECTION_LABELS: Record<string, string> = {
  top: msg("Popular songs"),
  albums: msg("Discography"),
  related: msg("Similar artists"),
  playlists: msg("Playlists"),
};

export default function ArtistPage({ provider, id }: { provider: string; id: string }) {
  const { t } = useTranslation();
  const loader = useCallback(
    ({ refresh, signal }: BrowseLoadOptions) => fetchArtist(provider, id, { refresh, signal }),
    [provider, id],
  );
  const { data, error, loading, reload } = useBrowseResource(loader, [provider, id]);
  const [ownershipKey, setOwnershipKey] = useState(0);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1)) as BrowseAcquisition;

  if (loading && !data) return <BrowseSkeleton rows={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { artist, topTracks, albums, related, playlists, partial } = data;
  const open = (entity: Parameters<typeof routeFor>[0], kind: string) => {
    const route = routeFor(entity, kind);
    if (route) push(route);
  };

  return (
    <div className="flex flex-col gap-6 pb-8">
      {/* Square photo and the facts that matter here: how much there is to
          browse. No follower count; that is the streaming service's metric. */}
      <header className="flex gap-5 items-center flex-wrap">
        <CardArt title={artist.name} imageUrl={artist.imageUrl} size={120} />
        <div className="flex flex-col gap-2 min-w-0">
          <ProviderChip name={artist.ref?.provider === "deezer" ? "Deezer" : artist.ref?.provider} />
          <h1 className="m-0 text-[28px] leading-tight font-extrabold text-black break-words">{artist.name}</h1>
          {artist.albumCount ? (
            <p className="m-0 text-[12.5px] text-[var(--ink-3)]">
              {t("{{n}} albums", { count: artist.albumCount, n: artist.albumCount })}
            </p>
          ) : null}
          {artist.ref?.url ? (
            <button type="button" className="explore-button self-start" onClick={() => openExternal(artist.ref.url)}>
              <ExternalLink size={14} strokeWidth={2.5} /> {t("View on Deezer")}
            </button>
          ) : null}
        </div>
      </header>

      {partial?.length ? (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-[8px] border-2 border-black text-[12.5px]"
          style={{ background: "var(--yellow)" }}
        >
          <AlertTriangle size={14} strokeWidth={2.5} />
          {t("Couldn't load: {{sections}}.", {
            sections: partial.map((p) => (SECTION_LABELS[p] ? t(SECTION_LABELS[p]) : p)).join(", "),
          })}
        </div>
      ) : null}

      {/* Each panel renders only if the provider actually supplied it. An
          absent panel means the capability was never declared. Albums lead:
          an album page is where a song can be saved with its ISRC. */}
      {albums?.length || topTracks?.length || related?.length || playlists?.length ? (
        <div className="explore-columns">
          <div className="flex flex-col gap-6 min-w-0">
            {albums?.length ? (
              <ExplorePanel title={t(SECTION_LABELS.albums)} accent="var(--coral)" count={albums.length}>
                <CardGrid min={128}>
                  {albums.map((album) => (
                    <CardCell width={undefined} key={album.ref.id}>
                      <MediaCard
                        title={album.title}
                        subtitle={album.releaseDate ? String(album.releaseDate).slice(0, 4) : album.recordType}
                        imageUrl={album.coverUrl}
                        kind="album"
                        size={128}
                        onOpen={() => open(album, "album")}
                      />
                    </CardCell>
                  ))}
                </CardGrid>
              </ExplorePanel>
            ) : null}
            {playlists?.length ? (
              <ExplorePanel title={t(SECTION_LABELS.playlists)} accent="var(--blue)" count={playlists.length}>
                <EntityList>
                  {playlists.map((playlist) => (
                    <EntityRow
                      key={playlist.ref.id}
                      title={playlist.title}
                      subtitle={
                        playlist.trackCount
                          ? t("{{n}} songs", { count: playlist.trackCount, n: playlist.trackCount })
                          : playlist.owner
                      }
                      imageUrl={playlist.pictureUrl}
                      onOpen={() => open(playlist, "playlist")}
                    />
                  ))}
                </EntityList>
              </ExplorePanel>
            ) : null}
          </div>

          <div className="flex flex-col gap-6 min-w-0">
            {topTracks?.length ? (
              <ExplorePanel title={t(SECTION_LABELS.top)} accent="var(--yellow)" count={topTracks.length} bodyClassName="flex flex-col">
                {/* Top tracks come from Deezer's /artist/{id}/top, which carries
                    no ISRC, so a save from here goes through review-grade
                    matching. The "›" opens the album, where the same song has one. */}
                <p className="m-0 px-4 pt-3 text-[11.5px] text-[var(--ink-3)]">{t(ISRC_NOTICE)}</p>
                <div className="px-4 pt-3"><AcquireBar acquisition={acquisition} /></div>
                <div className="pt-2">
                  <TrackList
                    tracks={topTracks}
                    showArtist={false}
                    showDuration={false}
                    ownershipKey={ownershipKey}
                    // No folder: the adapter files each track under its own album.
                    onAcquire={(track) => acquisition.acquire([track])}
                    acquiring={acquisition.active}
                    acquisition={acquisition}
                    onOpenAlbum={(track) => open({ ref: track.albumRef, title: track.albumTitle }, "album")}
                  />
                </div>
              </ExplorePanel>
            ) : null}
            {related?.length ? (
              <ExplorePanel title={t(SECTION_LABELS.related)} accent="var(--teal)" count={related.length}>
                <TagWrap>
                  {related.map((other) => (
                    <ArtistTag
                      key={other.ref.id}
                      name={other.name}
                      imageUrl={other.imageUrl}
                      onOpen={() => open({ ...other, title: other.name }, "artist")}
                    />
                  ))}
                </TagWrap>
              </ExplorePanel>
            ) : null}
          </div>
        </div>
      ) : (
        <EmptyState>{t("This source returned nothing for this artist.")}</EmptyState>
      )}
    </div>
  );
}

