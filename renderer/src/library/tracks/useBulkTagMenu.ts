import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../data";
import { useOffline } from "../../offline/useOffline";
import type { MenuItem } from "../../albums/TrackContextMenu";
import { bulkTagPaths, openBulkTags, type TagSong } from "./bulkTagStore";

export function useBulkTagMenu() {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const offline = useOffline();
  return (songs: TagSong[]): MenuItem[] => {
    if (me.data?.role !== "owner" || songs.length < 2) return [];
    const paths = bulkTagPaths(songs);
    const tooltip = offline ? t("Editing tags requires the nest")
      : paths.length > 500 ? t("Select up to 500 songs")
      : paths.length < 2 || songs.some(song => !bulkTagPaths([song]).length) ? t("Could not read tags") : undefined;
    return [{ label: t("Edit tags"), color: "var(--teal)", disabled: !!tooltip, tooltip, onClick: () => openBulkTags(songs) }];
  };
}
