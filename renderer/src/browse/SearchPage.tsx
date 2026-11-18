import type { BrowseAcquisition } from "./acquisition.types";
import type { CatalogCard } from "./cards.types";
/** Search metadata providers for recording identities before acquisition.
 * Keep failed categories distinct from empty results so the user can retry them. */
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CardArt, CardCell, MediaCard as LegacyMediaCard } from "../ui/components/MediaCard";
import { ArtistTag, EntityList, EntityRow, ExplorePanel, FillGrid, ShowMoreButton, TagWrap, useShowMore } from "./ExplorePanel";
import { EmptyState, ErrorState } from "./BrowseStates";
import { ISRC_NOTICE, TrackList } from "./TrackList";
import { AcquireBar } from "./AcquireBar";
import { useAcquisition } from "./useAcquisition";
import { push, replace, routeFor, searchRoute } from "./navigationStore";
import { useBrowseSearch, validSearch } from "./useBrowseSearch";
import SearchScopeSwitch from "../library/search/SearchScopeSwitch";
import { rememberSearch } from "./catalogSearchHistory";

// The legacy component supports percentage sizes; its default infers number.
const MediaCard = LegacyMediaCard as CatalogCard;

export default function SearchPage({ query, mode = "full" }: { query: string; initialDraft?: string; mode?: "typing" | "full" }) {
  const { t } = useTranslation();
  const { data, error, isPending: loading, refetch: reload, isPlaceholderData, isSuccess, showProgress } = useBrowseSearch(query, mode);
  const [ownershipKey, setOwnershipKey] = useState(0);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1)) as BrowseAcquisition;

  const tracks = useShowMore(data?.tracks, 8);
  const playlists = useShowMore(data?.playlists, 6);

  useEffect(() => { if (isSuccess && data && !error && !isPlaceholderData && !data.failed?.length) rememberSearch(query); }, [data, query, isPlaceholderData, error, isSuccess]);
  const submit = (term = query) => {
    if (!validSearch(term)) return;
    replace(searchRoute(term, "full"));
  };

  const open = (entity: Parameters<typeof routeFor>[0], kind: string) => {
    const route = routeFor(entity, kind);
    if (route) push(route);
  };

  const controls = <div><SearchScopeSwitch scope="explore" query={query} />
    {error && data ? <button type="button" className="explore-link" onClick={() => reload()}>{t("Retry")}</button> : showProgress ? <span role="status" className="text-xs text-[var(--ink-3)]">{t("Searching…")}</span> : null}
  </div>;

  if (!query.trim()) return <div className="flex flex-col gap-5 pb-8">{controls}</div>;

  if (loading && !data && validSearch(query)) {
    return <div className="flex flex-col gap-5 pb-8">{controls}<SearchSkeleton /></div>;
  }
  if (error && !data) {
    return <div className="flex flex-col gap-5 pb-8">{controls}<ErrorState error={error} onRetry={() => reload()} /></div>;
  }
  if (!data) return <div className="flex flex-col gap-5 pb-8">{controls}</div>;

  const artists = data.artists || [];
  const total = (data.albums?.length || 0) + artists.length + (data.tracks?.length || 0) + (data.playlists?.length || 0);
  // The first artist is the best match the provider ranked; it leads the page
  // and the rest follow as tags.
  const [best, ...otherArtists] = artists;

  return (
    <div className="flex flex-col gap-5 pb-8">
      {controls}

      {data.failed?.length ? (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-[8px] border-2 border-black text-[12.5px]"
          style={{ background: "var(--yellow)" }}
        >
          <AlertTriangle size={14} strokeWidth={2.5} />
          {t("Couldn't search in: {{categories}}.", { categories: data.failed.join(", ") })}
        </div>
      ) : null}

      {total === 0 ? (
        <EmptyState>{t("No results for “{{query}}”.", { query: data.query })}</EmptyState>
      ) : (
        <div className="explore-columns">
          <div className="flex flex-col gap-6 min-w-0">
            {data.albums?.length ? (
              <ExplorePanel title={t("Albums")} accent="var(--coral)" count={data.albums.length} bodyClassName="p-4 flex flex-col">
                <FillGrid
                  items={data.albums}
                  onShowAll={mode === "typing" ? () => submit() : undefined}
                  renderItem={(album) => (
                    <CardCell width={undefined} key={album.ref.id}>
                      <MediaCard
                        title={album.title}
                        subtitle={album.artistName}
                        imageUrl={album.coverUrl}
                        kind="album"
                        size="100%"
                        onOpen={() => open(album, "album")}
                      />
                    </CardCell>
                  )}
                />
              </ExplorePanel>
            ) : null}

            {data.tracks?.length ? (
              <ExplorePanel title={t("Songs")} accent="var(--yellow)" count={data.tracks.length} bodyClassName="flex flex-col">
                {/* Search results carry no ISRC either; see TrackList's note. */}
                <p className="m-0 px-4 pt-3 text-[11.5px] text-[var(--ink-3)]">{t(ISRC_NOTICE)}</p>
                <div className="px-4 pt-3"><AcquireBar acquisition={acquisition} /></div>
                <div className="pt-2">
                  <TrackList
                    tracks={tracks.visible}
                    showArtist
                    ownershipKey={ownershipKey}
                    onAcquire={(track) => acquisition.acquire([track])}
                    acquiring={acquisition.active}
                    acquisition={acquisition}
                    onOpenAlbum={(track) => open({ ref: track.albumRef, title: track.albumTitle }, "album")}
                  />
                </div>
                <div className="px-4 pb-4 empty:hidden"><ShowMoreButton state={tracks} onShowAll={mode === "typing" ? () => submit() : undefined} /></div>
              </ExplorePanel>
            ) : null}
          </div>

          <div className="flex flex-col gap-6 min-w-0">
            {best ? (
              <ExplorePanel title={t("Best match")} accent="var(--purple)">
                <button
                  type="button"
                  onClick={() => open({ ...best, title: best.name }, "artist")}
                  className="explore-entity-row w-full min-h-0 p-2 bg-transparent border-0 text-left flex items-center gap-4 rounded-panel cursor-pointer"
                  title={t("Open “{{title}}”", { title: best.name })}
                >
                  <CardArt title={best.name} imageUrl={best.imageUrl} size={88} />
                  <span className="flex flex-col gap-1 min-w-0 flex-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--ink-3)]">{t("Artist")}</span>
                    <span className="text-[20px] leading-tight font-extrabold text-black break-words">{best.name}</span>
                  </span>
                  <ChevronRight size={18} strokeWidth={2.75} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
                </button>
              </ExplorePanel>
            ) : null}

            {otherArtists.length ? (
              <ExplorePanel title={t("Artists")} accent="var(--teal)" count={otherArtists.length}>
                <TagWrap>
                  {otherArtists.map((artist) => (
                    <ArtistTag
                      key={artist.ref.id}
                      name={artist.name}
                      imageUrl={artist.imageUrl}
                      onOpen={() => open({ ...artist, title: artist.name }, "artist")}
                    />
                  ))}
                </TagWrap>
              </ExplorePanel>
            ) : null}

            {data.playlists?.length ? (
              <ExplorePanel title={t("Playlists")} accent="var(--blue)" count={data.playlists.length} bodyClassName="p-4 flex flex-col">
                <EntityList>
                  {playlists.visible.map((playlist) => (
                    <EntityRow
                      key={playlist.ref.id}
                      title={playlist.title}
                      subtitle={playlist.owner}
                      imageUrl={playlist.pictureUrl}
                      onOpen={() => open(playlist, "playlist")}
                    />
                  ))}
                </EntityList>
                <ShowMoreButton state={playlists} onShowAll={mode === "typing" ? () => submit() : undefined} />
              </ExplorePanel>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="explore-columns animate-pulse" aria-busy="true">
      <div className="h-[420px] rounded-xl border-2 border-black bg-[var(--panel-2)]" />
      <div className="h-[260px] rounded-xl border-2 border-black bg-[var(--panel-2)]" />
    </div>
  );
}
