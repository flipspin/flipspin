import { useEffect, useState } from "react";
import SongWindow from "./SongWindow";
import { openSongMatch } from "../../match/matchStore";
import BulkTagsWindow from "./BulkTagsWindow";
import TagEditDetails from "./TagEditDetails";
import { closeBulkTags, closeTagEditDetails, useBulkTagPaths, useTagEditDetails } from "./bulkTagStore";
import { claimHost, closeSongWindow, releaseHost, useIsActiveHost, useSongWindowTrack } from "./songWindowStore";

export function SongWindowHost() {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => {
    const claimed = claimHost();
    setId(claimed);
    return () => releaseHost(claimed);
  }, []);
  const active = useIsActiveHost(id);
  const track = useSongWindowTrack();
  const paths = useBulkTagPaths();
  const editId = useTagEditDetails();
  return active ? <>
    <SongWindow open={Boolean(track)} track={track} onClose={closeSongWindow} onMatch={(song) => { closeSongWindow(); openSongMatch(song); }} />
    <BulkTagsWindow paths={paths} onClose={closeBulkTags} />
    <TagEditDetails editId={editId} onClose={closeTagEditDetails} />
  </> : null;
}
