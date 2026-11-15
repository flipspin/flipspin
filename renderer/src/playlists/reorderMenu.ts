import i18n from "../i18n";
import type { MenuItem } from "../albums/TrackContextMenu";
import { canMove, moves, type Move } from "./reorder";
import type { PlaylistTrack } from "./playlistTracks";

export function reorderMenu(order: PlaylistTrack[], moving: PlaylistTrack[], enabled: boolean, onMove: (tracks: PlaylistTrack[], moving: PlaylistTrack[]) => void): MenuItem[] {
  if (!enabled) return [];
  const t = i18n.t.bind(i18n);
  const labels: [Move, string][] = [["top", t("To top")], ["up", t("Up")], ["down", t("Down")], ["bottom", t("To bottom")]];
  return [{ label: t("Move"), color: "var(--teal)", submenu: labels.map(([move, label]) => ({
    label, disabled: !canMove(order, moving, move), onClick: () => onMove(moves[move](order, moving), moving),
  })) }];
}
