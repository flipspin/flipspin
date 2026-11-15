import { useRemoveActions, withRemoveActions } from "../acquisition/removeActions";
import CollectionActions from "../acquisition/CollectionActions";
import React from "react";
import { Ellipsis, Play, Shuffle } from "lucide-react";
import { apiUrl, buildCoverImageUrl, parseTrackPath } from "@lib/api";
import { describeOwner } from "@lib/playlistAccess";
import { useIdentity } from "@state/identityStore";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";
import { playlistColor, playlistInk } from "./playlistBadge";
import { playlistFacts } from "./playlistFacts";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { Missing } from "../ui/react/components/Missing";
import "./playlists.css";
import { missingWord } from "../ui/react/components/missingWords";

/** The list's colour band groups its facts, editable name and whole-list verbs.
 * Search belongs to the table toolbar; its prop remains accepted during migration. */
function trackCover(track) {
  if (!track) return null;
  if (track.albumCover) return track.albumCover;
  if (track.album && typeof track.album === "object" && track.album.cover) return track.album.cover;
  const { albumName } = parseTrackPath(track.path);
  return buildCoverImageUrl(albumName);
}

function sourceLabel(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes("spotify")) return "Spotify";
  if (u.includes("youtube") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("genius")) return "Genius";
  return msg("Source_origin");
}

/** The covers the collage is built from: the playlist's own, else the first
 *  four distinct album covers of its songs. */
export function playlistCovers(playlist, tracks = []) {
  if (!playlist) return [];
  if (playlist.cover) return [playlist.cover];
  const covers = [];
  for (const track of tracks) {
    const c = trackCover(track);
    if (c && !covers.includes(c)) covers.push(c);
    if (covers.length >= 4) break;
  }
  return covers;
}

const COVER = "clamp(140px, 18vw, 220px)";

export default function PlaylistHero({
  playlist,
  tracks = [],
  onPlay,
  onRefresh,
  renaming = false,
  renameValue = "",
  setRenameValue,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onDelete,
  shuffleOn = false,
  onToggleShuffle,
  search: _search = null,
}) {
  const { t } = useTranslation();
  const identity = useIdentity();
  const [menu, setMenu] = React.useState({ open: false, x: 0, y: 0 });
  const [household, setHousehold] = React.useState({ me: null, users: [] });
  const ownerId = playlist?.owner;
  const me = identity.me;
  React.useEffect(() => {
    if (!ownerId || ownerId === me?.id || !me?.isOwner) return;
    const controller = new AbortController();
    void fetch(apiUrl("/api/users"), { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!controller.signal.aborted) setHousehold({ me, users: data?.users || [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setHousehold({ me, users: [] });
      });
    return () => controller.abort();
  }, [ownerId, me]);
  const name = playlist?.name || "";
  const color = playlistColor(name);
  const ink = React.useMemo(() => playlistInk(name), [name]);

  const removals = useRemoveActions(tracks);
  if (!playlist) return null;

  const covers = playlistCovers(playlist, tracks);

  const totalDuration = tracks.reduce(
    (sum, track) => sum + (Number(track?.duration ?? track?.metadata?.duration) || 0),
    0,
  );
  const source = sourceLabel(playlist.source_url);
  const owner = describeOwner(playlist.owner, me, household.me === me ? household.users : []);
  // One line, the same on all three apps (`contracts/playlist-page.json`).
  const factsLine = playlistFacts({ songs: tracks.length, seconds: totalDuration, downloaded: null }, t);

  const openSource = () => {
    if (playlist.source_url) window.desktopAPI?.openExternal?.(playlist.source_url);
  };

  const menuItems = [
    onStartRename ? { label: t("Rename playlist"), color: "var(--teal)", onClick: onStartRename } : null,
    source ? { label: t("Open in {{source}}", { source: t(source) }), color: "var(--blue)", onClick: openSource } : null,
    playlist.source_url && onRefresh
      ? { label: t("Refresh from link"), color: "var(--green)", onClick: onRefresh }
      : null,
    onDelete ? { label: t("Delete playlist"), color: "var(--rose)", danger: true, onClick: onDelete } : null,
  ].filter(Boolean);

  return (
    <div className="playlist-hero" style={{ "--list-color": color, "--list-ink": ink } as React.CSSProperties}>
      {/* 1 · The band. */}
      <header className="playlist-band">
        {/* The collage: the first four album covers, or one, or a blank tile. */}
        <div className="playlist-band__cover" style={{ width: COVER, height: COVER }}>
          {covers.length === 0 ? (
            <div className="w-full h-full grid place-items-center text-xs font-mono text-center p-2 opacity-70">
              {t("No cover")}
            </div>
          ) : covers.length < 4 ? (
            <img src={covers[0]} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
              {covers.slice(0, 4).map((c, i) => (
                <img key={i} src={c} alt="" className="w-full h-full object-cover" />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 min-w-0 flex-1">
          <div className="playlist-band__facts">
            {owner ? (
              <>
                <span className="playlist-band__dot" aria-hidden="true" />
                <span className="playlist-band__owner" title={owner.label ? (owner.mine ? t("You created it") : t("Created by {{label}}", { label: owner.label })) : undefined}>
                  {owner.label || <Missing kind={owner.mine ? "nodata" : me?.isOwner ? (household.me === me ? "unavailable" : "loading") : "noAccess"} />}
                </span>
                <span aria-hidden="true"> · </span>
              </>
            ) : null}
            <span>{factsLine}</span>
          </div>

          <div className="playlist-band__title-row">
            {renaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitRename?.();
                  else if (e.key === "Escape") onCancelRename?.();
                }}
                onBlur={() => onCancelRename?.()}
                aria-label={t("Rename playlist")}
                className="playlist-band__title playlist-band__rename"
              />
            ) : (
              <h1
                className="playlist-band__title"
                onDoubleClick={onStartRename || undefined}
                title={onStartRename ? t("Double-click to rename") : undefined}
              >
                {playlist.name || missingWord("noTitle")}
              </h1>
            )}
            {menuItems.length || removals.length ? (
              <button
                type="button"
                className="playlist-actions__icon playlist-band__more"
                onClick={(e) => setMenu({ open: true, ...menuPointFrom({ clientX: 0, clientY: 0, currentTarget: e.currentTarget }) })}
                aria-haspopup="menu"
                aria-expanded={menu.open}
                title={t("More options")}
                aria-label={t("More options")}
              >
                <Ellipsis size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {playlist.description ? (
            <p className="m-0 text-[13px] opacity-85 max-w-[62ch] break-words line-clamp-2">{playlist.description}</p>
          ) : null}

          <div className="playlist-actions">
            {onPlay ? (
              <button
                type="button"
                className="playlist-actions__play"
                onClick={onPlay}
                disabled={tracks.length === 0}
                title={t("Play")}
                aria-label={t("Play")}
              >
                <Play size={18} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
            ) : null}
            {onToggleShuffle ? (
              <button
                type="button"
                className={`playlist-actions__icon ${shuffleOn ? "is-on" : ""}`}
                onClick={onToggleShuffle}
                aria-pressed={shuffleOn}
                title={shuffleOn ? t("Turn shuffle off") : t("Turn shuffle on")}
                aria-label={t("Shuffle")}
              >
                <Shuffle size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
            ) : null}
            <CollectionActions removalMenu={false} variant="icons" kind="playlist" refId={String(playlist.id || playlist.name)} title={name} tracks={tracks} />
          </div>
        </div>
      </header>

      <TrackContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        title={playlist.name}
        artist={factsLine}
        items={withRemoveActions(menuItems, removals)}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />
    </div>
  );
}
