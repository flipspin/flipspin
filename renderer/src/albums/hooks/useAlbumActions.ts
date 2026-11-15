import { useCallback } from "react";
import { openVlcCard, sendToVlc, vlcMenuItems } from "../../vlc/vlcSend";

type Song = { path: string };

/** Pass songs explicitly because outside mousedown can clear selection before a menu action runs.
 * Share the saved VLC address and address editor between Library and Playlists. */
export function useAlbumActions({ vlcIp }: { vlcIp?: string }) {
  const saveToBackend = useCallback(async (songs: Song[]) => {
    if (!songs?.length) return;
    const ip = (vlcIp || "").trim();
    if (ip) await sendToVlc(songs, ip);
    else openVlcCard(songs);
  }, [vlcIp]);

  const sendItems = useCallback((songs: Song[]) => vlcMenuItems(songs, vlcIp || ""), [vlcIp]);

  return { saveToBackend, sendItems };
}
