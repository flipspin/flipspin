import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import { useSongMenu } from "../library/tracks/useSongMenu";
/** Batch ownership for the list, and render without markers if that lookup fails.
 * Keep near matches distinct: another cut needs confirmation before replacement. */
import type { BrowseTrack, OwnedFile, OwnershipVerdict } from "./browse.types";
import type { BrowseAcquisition, BrowseRowEnd } from "./acquisition.types";
import type { StatusActions } from "./cards.types";
import type { CatalogTrack } from "../acquisition/api";
import type { PlayerTrack } from "@state/AudioPlayerContext";
import type { MouseEvent } from "react";
import { useLocalCopies, useOffline } from "../offline/useOffline";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, FolderInput, Loader2, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";

import { formatDuration } from "../ui/components/cardArt";
import { relPathOf } from "@state/userLibraryStore";
import { buildCoverImageUrl, buildMediaUrl, parseTrackPath } from "@lib/api";
import { albumStub } from "@lib/albumStub";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { checkOwnership } from "./browseApi";
import { announceLibraryChanged, confirmReplace, moveTrack, ownedElsewhere, type OwnedFile as ResolvedFile } from "./resolve";
import { useStatus } from "../state/useStatus";
import { useHeld } from "../ui/react/useHeld";
import PanelModal from "../ui/components/PanelModal";
import { RowEnd as LegacyRowEnd } from "../acquisition/RowState";
import { requestTrackProgress } from "../acquisition/trackProgress";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { useRemovalActionsFor } from "../acquisition/removeActions";
import { Missing } from "../ui/react/components/Missing";

/** Artist and search rows can lack ISRCs; translate this notice at render time. */
const RowEnd = LegacyRowEnd as BrowseRowEnd;

export const ISRC_NOTICE = msg(
  "Matching is more precise from the album page: those songs include an ISRC and these don't.",
);

/** Build media keys from the matched file's directory, never its display album name. */
export function playableFromMatch(match: OwnedFile | null | undefined): PlayerTrack | null {
  const { albumName, fileName } = parseTrackPath(match?.path);
  if (!match || !albumName || !fileName) return null;
  const album = { album: match.album, artist: match.artist, path: match.path.replace(/[/\\][^/\\]+$/, "") };
  return {
    title: match.title,
    artist: match.artist,
    path: match.path,
    relPath: relPathOf(match) || undefined,
    duration: match.durationSeconds ?? undefined,
    track_number: match.trackNumber ?? undefined,
    album: albumStub(album, buildCoverImageUrl(albumName)),
    url_path: buildMediaUrl(albumName, fileName),
  };
}

/** Artist and search rows link to albums where full recording identity is available.
 * Only album pages supply albumTitle, which enables moving an owned file into that album. */
type Acquisition = BrowseAcquisition;
type Props = {
  tracks?: BrowseTrack[];
  showArtist?: boolean;
  showDuration?: boolean;
  onAcquire?: (track: BrowseTrack) => unknown;
  acquiring?: boolean;
  onOpenAlbum?: (track: BrowseTrack) => void;
  ownershipKey?: number;
  onOwnership?: (verdicts: OwnershipVerdict[]) => void;
  albumTitle?: string | null;
  acquisition?: Acquisition;
};

export function TrackList({ tracks, showArtist = false, showDuration = true, onAcquire, acquiring = false, onOpenAlbum, ownershipKey = 0, onOwnership, albumTitle = null, acquisition }: Props) {
  const { t } = useTranslation();
  const offline = useOffline();
  const { showSuccess, showError } = useStatus() as StatusActions;
  // Rows whose "+" was pressed and whose job has not ended: the "+" turns into
  // a spinner until the page's acquisition goes idle (`acquiring` true → false),
  // when the ownership refresh redraws the row as saved.
  const [pending, setPending] = useState<Set<string | number>>(() => new Set());
  const wasAcquiring = useRef(acquiring);
  useEffect(() => {
    if (wasAcquiring.current && !acquiring) setPending(new Set());
    wasAcquiring.current = acquiring;
  }, [acquiring]);
  const acquireRow = (track: BrowseTrack, key: string | number) => {
    if (!onAcquire || pending.has(key)) return;
    setPending((prev) => new Set(prev).add(key));
    onAcquire(track);
  };
  const [ownership, setOwnership] = useState<OwnershipVerdict[]>([]);
  // Bumped after a move, so the row re-asks the oracle and flips.
  const [recheckKey, setRecheckKey] = useState(0);
  const [moving, setMoving] = useState<Set<string | number>>(() => new Set());
  const moveHere = async (track: BrowseTrack, file: ResolvedFile, key: string | number) => {
    if (moving.has(key)) return;
    setMoving((prev) => new Set(prev).add(key));
    try {
      await moveTrack({ path: file.path, albumTitle, trackNumber: track.trackPosition ?? null });
      showSuccess(t("“{{title}}” moved to “{{album}}”", { title: track.title, album: albumTitle }));
      announceLibraryChanged();
      setRecheckKey((k) => k + 1);
    } catch (e) {
      showError((e instanceof Error ? e.message : "") || t("Couldn't move it."));
    } finally {
      setMoving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };
  const replaceWith = async (track: BrowseTrack, near: OwnedFile, key: string | number) => {
    setNearOpen(null);
    if (!(await confirmReplace(near))) return;
    acquireRow({ ...track, replaces: near.path }, key);
  };
  // The near match whose dialog is open: {track, near}.
  const [nearOpen, setNearOpen] = useState<{ track: BrowseTrack; near: OwnedFile; key: string | number } | null>(null);
  const heldNear = useHeld(nearOpen);

  const { setQueueWithTracks, addToQueue, addNextInQueue } = useAudioPlayer();

  // Share the ownership batch with page totals. A ref avoids refetching when the callback identity changes.
  const reportRef = useRef(onOwnership);
  reportRef.current = onOwnership;

  useEffect(() => {
    let cancelled = false;
    setOwnership([]);
    if (!tracks?.length) return undefined;
    checkOwnership(tracks).then((results) => {
      if (cancelled) return;
      setOwnership(results);
      reportRef.current?.(results);
    });
    return () => {
      cancelled = true;
    };
    // `ownershipKey` is bumped after an acquisition finishes so the owned
    // markers re-check without remounting the list; `recheckKey` after a move.
  }, [tracks, ownershipKey, recheckKey, acquisition?.ownershipRevision]);

  // One playable per owned row, index-aligned with `tracks` (null for the
  // rest), so ▶ on a row queues every owned song after it, like an album.
  const playables = useMemo(() => ownership.map((v) => (v?.owned ? playableFromMatch(v.match) : null)), [ownership]);
  const progress = useMemo(() => requestTrackProgress(acquisition?.requests || (acquisition?.request ? { [acquisition.request.id]: acquisition.request } : {}), (tracks || []) as CatalogTrack[], acquisition?.retainedIds), [acquisition?.requests, acquisition?.request, acquisition?.retainedIds, tracks]);
  const copies = useLocalCopies(ownership.flatMap(value => value?.owned ? [relPathOf(value.match)].filter(Boolean) : []));
  const playFrom = (i: number) => {
    const list = playables.filter((track): track is PlayerTrack => !!track && (!offline || copies.has(relPathOf(track))));
    const start = list.indexOf(playables[i]!);
    if (start !== -1) setQueueWithTracks(list, start);
  };

  const removalTracks = (tracks || []).map((_track, i) => ({ ...ownership[i]?.match, relPath: progress[i]?.key || relPathOf(ownership[i]?.match) }));
  const removalFor = useRemovalActionsFor(removalTracks);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const menuSong = menu ? playables[menu.index] : null;
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const songMenu = useSongMenu(menuSong ? [menuSong] : [], { showSuccess, showError });
  const menuItems = menuSong && menu ? songMenu.build({
    onPlay: () => playFrom(menu.index),
    onPlayNext: () => addNextInQueue([menuSong]),
    onQueue: () => addToQueue([menuSong]),
    playlistSubmenu: playlistMenu.submenu([menuSong]),
  }) : menu ? removalFor([removalTracks[menu.index]]) : [];
  const openMenu = (event: MouseEvent, index: number) => {
    event.preventDefault(); event.stopPropagation();
    if (playables[index] || removalFor([removalTracks[index]]).length) {
      setMenu({ ...menuPointFrom(event), index });
      playlistMenu.refresh();
    }
  };
  if (!tracks?.length) return null;

  // Set varying grid templates inline so Tailwind does not need to discover assembled class names.
  // Share the template and gap between headers and rows.
  const columns = [
    "32px",
    "minmax(0, 1fr)",
    showArtist ? "minmax(120px, .6fr)" : null,
    // A narrow panel (Browse's right column) drops the length: the title is
    // what has to fit there.
    showDuration ? "60px" : null,
    "56px",
  ].filter(Boolean).join(" ");
  const gridStyle = { gridTemplateColumns: columns };

  return (
    <div className="retro-song-table retro-song-table--embedded">
      <div className="retro-song-table__header grid items-center gap-3 px-3 py-2.5" style={gridStyle}>
        <span className="text-center">#</span>
        <span>{t("Title")}</span>
        {showArtist ? <span>{t("Artist")}</span> : null}
        {showDuration ? <span className="text-right">{t("Duration")}</span> : null}
        <span className="acquire-row-end" />
      </div>
      <ul className="retro-song-table__body">
      {tracks.map((track, i) => {
        const owned = ownership[i]?.owned === true;
        const near = !owned ? ownership[i]?.nearMatch : null;
        const ownedPath = progress[i]?.key || (owned ? relPathOf(ownership[i]?.match) : null);

        const unavailable = offline && !copies.has(ownedPath);
        const playable = unavailable ? null : playables[i];
        const rowKey = track.ref?.id || i;
        const published = progress[i].published && progress[i].current;
        const item = progress[i].current || progress[i].item?.state === 'failed' ? progress[i].item : undefined;
        const busy = !item && ((progress[i].current && !published) || (pending.has(rowKey) && acquiring));
        const status = { unavailable, catalog: true, acquired: published, trackKey: ownedPath, inNest: owned || published, near: !!near, nearDuration: near?.durationSeconds, busy, item, track, title: track.title, onAdd: () => near ? setNearOpen({ track, near, key: rowKey }) : acquireRow(track, rowKey), onRetry: (youtubeUrl?: string) => progress[i].requestId && acquisition?.retryItem ? acquisition.retryItem(progress[i].requestId, progress[i].index, youtubeUrl) : acquireRow(track, rowKey) };
        const elsewhere = albumTitle ? ownedElsewhere(ownership[i], albumTitle) : null;
        const isMoving = moving.has(rowKey);
        return (
          <li
            onContextMenu={event => openMenu(event, i)}
            onDoubleClick={playable ? () => playFrom(i) : undefined}
            aria-disabled={unavailable || undefined}
            title={unavailable ? t("Unavailable offline") : undefined}
            key={track.ref?.id || i}
            className={`retro-song-table__row grid items-center gap-3 px-3 py-1.5 ${owned ? "browse-row--owned" : ""} ${unavailable ? "is-offline-unavailable" : ""}`}
            style={gridStyle}
          >
            {/* Number at rest, ▶ on hover; the library row's pattern, and
                only where the server already has the file. */}
            <div className="song-row__num relative text-center tabular-nums">
              {/* The label class is what the row hover hides; only give it
                  to rows that have a ▶ to show in its place. */}
              <span className={playable ? "song-row__num-label" : "block"}>
                {String(track.trackPosition ?? i + 1).padStart(2, "0")}
              </span>
              {playable ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    playFrom(i);
                  }}
                  title={t("Play")}
                  aria-label={t("Play {{title}}", { title: track.title })}
                  className="song-row__action song-row__play"
                >
                  <Play size={12} strokeWidth={0} fill="currentColor" aria-hidden />
                </button>
              ) : null}
            </div>

            {/* A row, so the "Move here" note and button sit beside the title
                instead of being clipped with it. */}
            <div className="flex items-center min-w-0">
              <span className="truncate text-[13.5px] font-bold text-black">
                {onOpenAlbum && track.albumRef?.id ? (
                  // Text, not a <button>: the song table frames every button in
                  // a row as a 3D control, and this should read as a title that
                  // underlines on hover.
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={() => onOpenAlbum(track)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpenAlbum(track);
                    }}
                    title={track.albumTitle ? t("Open the album “{{title}}”", { title: track.albumTitle }) : t("Open album")}
                    className="browse-row__title-link"
                  >
                    {track.title}
                  </span>
                ) : (
                  track.title
                )}
                {track.explicit ? (
                  <span
                    className="ml-1.5 px-1 rounded-[3px] border border-black text-[9px] align-middle"
                    title={t("Explicit content")}
                  >
                    E
                  </span>
                ) : null}
              </span>
              {elsewhere?.album ? <span className="song-row--missing__note truncate max-w-[45%]">{t("in “{{album}}”", { album: elsewhere.album })}</span> : null}
              {elsewhere && !unavailable ? (
                <button
                  type="button"
                  onClick={() => moveHere(track, elsewhere, rowKey)}
                  disabled={offline || isMoving}
                  aria-busy={isMoving || undefined}
                  title={t("Move here")}
                  aria-label={t("Move “{{title}}” here", { title: track.title })}
                  className="song-row__action song-row__get ml-1 shrink-0"
                >
                  {isMoving ? (
                    <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : (
                    <FolderInput size={13} strokeWidth={2.5} aria-hidden />
                  )}
                </button>
              ) : null}
            </div>

            {showArtist ? <span className="truncate text-[12px] text-[var(--ink-3)]">{track.artistName || <Missing kind="noArtist" />}</span> : null}

            {showDuration ? (
              <span className="text-right text-[12.5px] tabular-nums text-[var(--ink-3)]">
                {formatDuration(track.durationSeconds)}
              </span>
            ) : null}

            <RowEnd {...status} />
          </li>
        );
      })}
      </ul>
      <TrackContextMenu open={menu != null && menuItems.length > 0} x={menu?.x ?? 0} y={menu?.y ?? 0} items={menuItems} onClose={() => setMenu(null)} />
      {heldNear ? (
        <NearMatchDialog
          open={nearOpen != null}
          track={heldNear.track}
          near={heldNear.near}
          onClose={() => setNearOpen(null)}
          onReplace={onAcquire ? () => replaceWith(heldNear.track, heldNear.near, heldNear.key) : null}
        />
      ) : null}
    </div>
  );
}

/** Show both durations so replacing a near match is an informed choice. */
function NearMatchDialog({ open, track, near, onClose, onReplace }: { open: boolean; track: BrowseTrack; near: OwnedFile; onClose: () => void; onReplace?: (() => unknown) | null }) {
  const { t } = useTranslation();
  const { setQueueWithTracks } = useAudioPlayer();
  const playable = playableFromMatch(near);
  const where = [near.artist, near.album].filter(Boolean).join(" · ");
  return (
    <PanelModal open={open} title={t("You have another version")} onClose={onClose} accent="var(--yellow)" width="max-w-md"
      footer={
        <div className="flex flex-wrap gap-2 justify-end w-full">
          {playable ? (
            <button type="button" className="k-btn k-btn--text" onClick={() => { setQueueWithTracks([playable], 0); onClose(); }}>
              <Play size={13} strokeWidth={0} fill="currentColor" aria-hidden /> {t("Play the one I have")}
            </button>
          ) : null}
          {/* Show only the replacement action for another cut, as required by rowControl. */}
          {onReplace && near.path ? (
            <button type="button" className="k-btn k-btn--text k-btn--text-primary" onClick={onReplace}>
              <ArrowRightLeft size={14} strokeWidth={2.5} aria-hidden /> {t("Swap for this version")}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="p-4 flex flex-col gap-3 text-[13.5px] leading-snug">
        <p className="m-0">
          {t("Your nest has «{{title}}» at {{duration}}; this one is {{other}}.", {
            title: near.title || track.title,
            duration: formatDuration(near.durationSeconds),
            other: formatDuration(track.durationSeconds),
          })}
        </p>
        {where ? <p className="m-0 text-[12.5px] text-[var(--ink-3)]">{where}</p> : null}
        <p className="m-0 text-[12.5px] text-[var(--ink-2)]">
          {t("The length difference suggests another version: live, extended, a remix or a radio edit.")}
        </p>
      </div>
    </PanelModal>
  );
}
