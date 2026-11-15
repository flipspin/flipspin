import { useRef, useSyncExternalStore } from "react";
import { useFloatingHeaderLayout } from "../shell/useFloatingHeaderLayout";
import "./home-rail.css";
import { useHomeRows } from "./useHomeRows";
import RecentAlbums from "./RecentAlbums";
import PlaylistsPanel from "./PlaylistsPanel";
import MostPlayedPanel from "./MostPlayedPanel";
import LibraryStats from "./LibraryStats";
import JobsPanel from "./JobsPanel";
import { usePortrait } from "../shell/usePortrait";
import type { ListedAlbum } from "./decorateTrack";
import { useHomeRailLayout } from "./useHomeRail";

// Tailwind's `lg`; fit "Just added" tiles once the listening column has room.
const LG = "(min-width: 1024px)";
const subscribeLg = (cb: () => void) => {
  const mq = window.matchMedia?.(LG);
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
};
const isLgNow = () => window.matchMedia?.(LG).matches ?? false;

/** Home keeps listening content dominant and operational status secondary. */
export default function Home({ albums = [], albumsLoading = false, albumsLoaded = true, albumsSnapshotAt = null, onOpenExplore, onOpenPlaylist }: {
  albums?: ListedAlbum[];
  albumsLoading?: boolean;
  albumsLoaded?: boolean;
  albumsSnapshotAt?: number | null;
  onOpenExplore?: () => void;
  onOpenPlaylist?: (name: string) => void;
}) {
  // Choose the portrait layout in JavaScript because wide portrait windows also match lg.
  const home = useHomeRows();
  const rows = home?.albums ?? albums;
  const loaded = home !== null || albumsLoaded;
  const snapshotAt = home ? home.at : albumsSnapshotAt;
  const portrait = usePortrait();
  const isLg = useSyncExternalStore(subscribeLg, isLgNow, () => false);
  const landscape = useFloatingHeaderLayout();
  const floating = landscape && !portrait;
  const rootRef = useRef<HTMLElement>(null);
  const railFolded = useHomeRailLayout(rootRef, floating);
  if (portrait) {
    // Use block layout so panel percentage heights resolve to auto and the portrait page can scroll.
    return (
      <div className="home-compact h-full p-6 overflow-y-auto slim-scrollbar">
        <div className="space-y-5">
          <RecentAlbums loaded={loaded} albums={rows} snapshotAt={snapshotAt} limit={10} compact />
          <PlaylistsPanel onOpen={onOpenPlaylist} />
          <MostPlayedPanel loaded={loaded} albums={rows} snapshotAt={snapshotAt} />
          <div className="home-library-square"><LibraryStats albums={albums} loading={!albumsLoaded || albumsLoading} onOpenExplore={onOpenExplore} /></div>
          <div className="h-[360px]"><JobsPanel /></div>
        </div>
      </div>
    );
  }

  return (
    // Each landscape column pads its own bottom so cards scroll to the player edge.
    <div className={floating ? "home-floating" : "home-compact flex flex-col flex-1 min-h-0 h-full p-6 overflow-y-auto slim-scrollbar"}>
      <div className={floating ? "home-columns" : "grid grid-cols-1 gap-5 items-start w-full"}>
        {/* This column scrolls on its own; the aside stays put. "Just added" caps its own covers (`fit`) and is as tall as they are. */}
        <main ref={rootRef} className={floating ? "home-main" : "flex flex-col gap-5 min-w-0"}>
          <div className="lg:flex-none">
            <RecentAlbums loaded={loaded} albums={rows} snapshotAt={snapshotAt} limit={10} compact fit={isLg} />
          </div>
          <PlaylistsPanel onOpen={onOpenPlaylist} />
          <MostPlayedPanel loaded={loaded} albums={rows} snapshotAt={snapshotAt} />
        </main>

        {/* Library keeps its card; Jobs uses the remaining rail height. In short
            windows the fixed inner column scrolls without clipping either section. */}
        <aside id="home-rail" className={floating ? "home-rail" : "min-w-0"} data-folded={floating && railFolded ? "" : undefined} inert={floating && railFolded} aria-hidden={floating && railFolded ? true : undefined}>
          <div className={floating ? "home-rail__clip" : "flex flex-col gap-5"}>
            <div className="home-library-square">
              <LibraryStats albums={albums} loading={!albumsLoaded || albumsLoading} onOpenExplore={onOpenExplore} />
            </div>
            <div className={floating ? "home-rail__jobs" : "h-[360px]"}>
              <JobsPanel frameless={floating} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
