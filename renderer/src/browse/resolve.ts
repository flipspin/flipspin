/** Share resolve decisions across catalog and library album pages.
 * Move owned files from another album; confirm replacement of a different cut
 * because acquisition deletes the old file after the new one lands. */
import i18n from "../i18n";
import { confirmAction } from "../ui";
import { formatDuration } from "../ui/components/cardArt";
import { BrowseError } from "./browseApi";
import { apiUrl } from "@lib/api";

export interface OwnedFile {
  title?: string;
  artist?: string;
  album?: string;
  path: string;
  durationSeconds?: number | null;
  trackNumber?: number | null;
}

export interface OwnershipVerdict {
  owned?: boolean;
  match?: OwnedFile | null;
  nearMatch?: OwnedFile | null;
  reason?: string | null;
}

/**
 * An album title as compared, never displayed: case and accents folded, and a
 * bracketed tail dropped; "Discovery (Deluxe)" and "discovery" are one album.
 */
export function foldTitle(s: unknown): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*[([].*?[)\]]\s*/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

/**
 * The file to move, when the library has this song under an album other than
 * `albumTitle` (the page's). Null when it is not owned, or already here.
 *
 * "Here" is the album tag *or* the folder: a move retags only an MP3, so a
 * moved FLAC still carries its single's album tag from a folder named after
 * this album, and must not offer the move again.
 */
export function ownedElsewhere(verdict: OwnershipVerdict | null | undefined, albumTitle: unknown): OwnedFile | null {
  const match = verdict?.owned ? verdict.match : null;
  const want = foldTitle(albumTitle);
  if (!match?.path || !want) return null;
  const folder = match.path.split(/[/\\]/).filter(Boolean).slice(-2, -1)[0];
  return foldTitle(match.album) === want || foldTitle(folder) === want ? null : match;
}

/** Show one acquire or resolve control per row, as defined by contracts/resolver.json.
 * albumTitle is null outside an album page. */
export type RowControl = "anadir" | "cambiar" | "mover" | "ninguno";
export function rowControl(verdict: OwnershipVerdict | null | undefined, albumTitle: unknown): RowControl {
  if (!verdict?.owned && verdict?.nearMatch) return "cambiar";
  if (albumTitle && ownedElsewhere(verdict, albumTitle)) return "mover";
  return verdict?.owned ? "ninguno" : "anadir";
}

export interface MoveTrackRequest {
  path: string;
  /** An existing library album's key; without it, where a download of `albumTitle` lands. */
  albumDir?: string | null;
  albumTitle?: string | null;
  trackNumber?: number | null;
}

/** `POST /api/library/move-track`. A 409's detail is a Spanish sentence, kept as the message. */
export async function moveTrack(body: MoveTrackRequest): Promise<{ success: boolean; path: string }> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/library/move-track"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: body.path,
        albumDir: body.albumDir || null,
        albumTitle: body.albumTitle || null,
        trackNumber: body.trackNumber ?? null,
      }),
    });
  } catch {
    throw new BrowseError(i18n.t("Couldn't connect to your nest."), "offline", 0);
  }
  if (response.ok) return response.json();
  let detail: unknown = null;
  try {
    detail = (await response.json())?.detail;
  } catch {
    detail = null;
  }
  const message = typeof detail === "string" && detail ? detail : i18n.t("Error {{status}}", { status: response.status });
  throw new BrowseError(message, response.status === 409 ? "conflict" : "failed", response.status);
}

/** "Swap for this version?"; the one line says which file goes. */
export function confirmReplace(near: OwnedFile): Promise<boolean> {
  const length = Number.isFinite(near?.durationSeconds) ? formatDuration(near.durationSeconds) : "";
  return confirmAction({
    title: i18n.t("Swap for this version?"),
    message: length
      ? i18n.t("Your {{duration}} version will be deleted.", { duration: length })
      : i18n.t("Your version will be deleted."),
    confirmLabel: i18n.t("Swap"),
    cancelLabel: i18n.t("Cancel"),
    destructive: true,
  });
}

/** Whether a finished acquisition carried a replacement that landed. */
export function replacementLanded(
  snapshot: { terminal?: boolean; failed?: number } | null | undefined,
  tracks: Array<{ replaces?: string | null }> | null | undefined,
): boolean {
  if (!snapshot?.terminal || snapshot.failed) return false;
  return Boolean(tracks?.some((t) => t?.replaces));
}

export { announceLibraryChanged } from '@lib/libraryEvents';
