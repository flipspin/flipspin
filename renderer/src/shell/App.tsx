import type { ShellSettings, ShellLibrary } from "./shell.types";
import type { LibraryAlbums } from "../data/hooks/use-library-albums";
import type { SettingsHost } from "../settings/context";
import type { BuiltinPage } from "./pageTable";
import { notify } from "../ui/notifications";
import { reportError } from '../lib/log';
import { UploadHost } from "../uploads/UploadHost";
import { onlineManager } from "@tanstack/react-query";
import { pluginPages } from "../plugins";
import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import { initRouteFromLocation, navigate, openPlaylist, setPlaylist, useRoute } from "./routeStore";
import { usePageSwitchLog } from "./usePageSwitchLog";
import { useGlobalKeys } from "./useGlobalKeys";
import { usePlaybackEffects } from "./usePlaybackEffects";
import { TrackInfoHost } from "../library/tracks/TrackInfoModal";
import { openMatch } from "../match/matchStore";
import { openBulkTags } from "../library/tracks/bulkTagStore";
import { openTrackInfo } from "../library/tracks/trackInfoStore";
import { TrackTagsHost } from "../library/tracks/TrackTagsHost";
import { openTrackTags } from "../library/tracks/trackTagsStore";
import { decorate } from "../home/decorateTrack";
import Overlays from "./Overlays";
import { AudioPlayerProvider, useAudioPlayer } from "@state/AudioPlayerContext";
import { AudioAnalyzerProvider } from "@state/AudioAnalyzerContext";
import { PluginProviders } from "../plugins/PluginProviders";
import { LibraryProvider, useLibrary } from "@state/LibraryContext";
import { PlayerWindowProvider } from "@state/PlayerWindowContext";
import { SettingsProvider, THEMES, useSettings } from "@state/SettingsContext";
import { StatusProvider } from "@state/StatusContext";
import { IS_REMOTE_BACKEND, apiUrl } from "@lib/api";
import { reset as resetBrowse, useHasBrowseRoute } from "../browse/navigationStore";
import { pageTransition } from "../ui/react/pageTransition";
import { useLyricsOverlayRelPath } from "../lyrics/lyricsStore";
import { startReconciling, stopReconciling } from "../downloads/downloadsStore";
import { PAGES, isBuiltinPage } from "./pageTable";
import Sidebar from "./layout/sidebar";
import Header from "./layout/header";
import SelectionBarLayout from "../ui/components/SelectionBarLayout";
import FixedBottomPlayerBar from "../player/FixedBottomPlayerBar";
import { useSettingsNavigation } from "../settings/useSettingsNavigation";
import { usePortrait } from "./usePortrait";
import { useTranslation } from "react-i18next";
import { ConnectionBannerDetails } from "../connection/ConnectionBannerDetails";
import { OfflineBanner } from "../offline/OfflineBanner";
import { OfflineLibraryProvider } from "../offline/OfflineLibrary";
import { useOffline } from "../offline/useOffline";
import { hasBridge, bridge } from "../bridge";
import { useQueryClient } from "@tanstack/react-query";
import { useLibraryAlbums } from "../data/hooks/use-library-albums";
import { querySnapshotAt } from "../data/http";
import { queryKeys } from "../data/keys";
import { announceLibraryChanged } from "../browse/resolve";
import { useConnection } from "../connection/connection";
import { setCoverBackendOnline } from "../ui/components/coverRetry";

const PlaybackTraceOverlay = import.meta.env.KROBI_PLAYBACK_TRACE === '1'
  ? lazy(() => import('../player/TraceOverlay')) : null;

// Keep the always-visible shell small. Editors, charts, settings and overlays
// are substantial and are only useful after the user explicitly opens them.
const BrowseRouter = React.lazy(() => import("../browse/BrowseRouter")) as React.LazyExoticComponent<React.ComponentType<{ albums?: LibraryAlbums; backendOnline?: boolean | null }>>;
const PortraitTabBar = React.lazy(() => import("./layout/PortraitTabBar"));
const PlayerWindowRoot = React.lazy(() => import("../player/PlayerWindowRoot"));
const SettingsPage = React.lazy(() => import("../settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SpotifyExportImport = React.lazy(() => import("../spotify-import/SpotifyExportImport"));
const SpotifySection = React.lazy(() => import("../settings/SpotifySection"));
// The legacy Spotify pieces Settings shows, embedded and suspended.
const SpotifyImport = () => <React.Suspense fallback={null}><SpotifyExportImport embedded /></React.Suspense>;
const SpotifyKeys = () => <React.Suspense fallback={null}><SpotifySection embedded /></React.Suspense>;

const isPlayerWindow = () =>
  typeof window !== "undefined" && window.location.search.includes("window=player");

const EMPTY_ALBUMS: LibraryAlbums = [];

function AppContent() {
  const { t } = useTranslation();
  const libraryAlbums = useLibraryAlbums();
  const albums = Array.isArray(libraryAlbums.data) ? libraryAlbums.data : EMPTY_ALBUMS;
  const albumsLoading = libraryAlbums.isPending;
  const albumsLoaded = libraryAlbums.data !== undefined;
  const queryClient = useQueryClient();
  const [identityEpoch, setIdentityEpoch] = useState(0);
  // The route (page + open playlist) lives in the URL hash: shell/routeStore.ts.
  useState(() => { initRouteFromLocation(); return null; });
  const { page: activePage, playlist: selectedPlaylistName } = useRoute();
  // Every page switch is one View Transition (a browse reset in the same tick joins it).
  const switchStarted = useRef<{ page: string; at: number } | null>(null);
  const setActivePage = React.useCallback((p: string) => {
    switchStarted.current = { page: p, at: performance.now() };
    pageTransition(() => navigate(p));
  }, []);
  const setSelectedPlaylistName = setPlaylist;
  usePageSwitchLog(activePage, switchStarted);

  // Adopt downloads the backend already knows about; a job started before a
  // reload, or from another window, would otherwise be running invisibly.
  useEffect(() => {
    const update = () => { if (onlineManager.isOnline()) startReconciling(); else stopReconciling(); };
    const stop = onlineManager.subscribe(update);
    update();
    return () => { stop(); stopReconciling(); };
  }, []);
  const connection = useConnection();
  const offline = useOffline();
  const albumsSnapshotAt = (offline || connection.state === "connecting") ? querySnapshotAt(queryClient, queryKeys.library.albums({ covers: false })) : null;
  const backendState = offline ? "offline" : connection.state === "connected" ? "online"
    : connection.state === "needs-auth" ? "locked"
    : connection.state === "unreachable" ? "offline" : null;
  const backendOnline = backendState === "online";
  useEffect(() => setCoverBackendOnline(backendOnline), [backendOnline]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The "Lyrics…" modal for the playing song: opened by the overlay, the
  // transport's mic button or the player window, so its state is the store's.
  const lyricsOverlayRel = useLyricsOverlayRelPath();
  // Choose the compact shell by orientation so wide portrait windows retain usable content width.
  const portrait = usePortrait();
  const { vlcIp, setVlcIp, theme, setTheme, mode, setMode } = useSettings() as ShellSettings;

  const { baseDir, selectBaseDir } = useLibrary() as ShellLibrary;

  const settingsRequest = useSettingsNavigation(() => {
    resetBrowse();
    setActivePage("settings");
    setMobileNavOpen(false);
  });
  const player = useAudioPlayer();
  const refreshEstimateListing = libraryAlbums.refetch;
  const estimateTrack = React.useCallback(async (relPath: string) => {
    for (const album of albums || []) {
      const track = album.tracks?.find(song => song.relPath === relPath);
      if (track) return decorate(track as Parameters<typeof decorate>[0], album as Parameters<typeof decorate>[1]);
    }
    const listing = (await refreshEstimateListing()).data;
    if (!Array.isArray(listing)) throw new Error('Track unavailable');
    for (const album of listing) {
      const track = album.tracks.find(song => song.relPath === relPath);
      if (track) return decorate(track as Parameters<typeof decorate>[0], album as Parameters<typeof decorate>[1]);
    }
    return null;
  }, [albums, refreshEstimateListing]);
  const settingsHost = React.useMemo<SettingsHost>(() => ({
    vlcIp: vlcIp || "",
    setVlcIp,
    palette: theme,
    setPalette: setTheme,
    palettes: THEMES,
    mode,
    setMode,
    chooseMusicFolder: IS_REMOTE_BACKEND ? undefined : selectBaseDir,
    openPage: (id) => { resetBrowse(); setActivePage(id); },
    SpotifyImport,
    SpotifyKeys,
    openHealthMatch: scope => openMatch(scope),
    openHealthBulkTags: relPaths => openBulkTags(relPaths.map(relPath => ({ relPath }))),
    playEstimate: async relPath => { try { const track = await estimateTrack(relPath); if (!track) throw new Error('Track unavailable'); player.play(track, { replaceQueue: true }); } catch (error) { reportError('playback', { userMessage: t("Could not load the song"), error }); } },
    openEstimateInfo: async relPath => { try { const track = await estimateTrack(relPath); if (!track) throw new Error('Track unavailable'); openTrackInfo(track); } catch { notify({ level: 'error', message: t("Could not load the song") }); } },
    openEstimateTags: async relPath => { try { const track = await estimateTrack(relPath); if (!track) throw new Error('Track unavailable'); openTrackTags(track); } catch (error) { reportError('playback', { userMessage: t("Could not load the song"), error }); } },
  }), [vlcIp, setVlcIp, theme, setTheme, mode, setMode, selectBaseDir, estimateTrack, player, setActivePage, t]);
  const { setIsPlaying, selectedTrack } = player;
  useGlobalKeys({
    selectedTrack,
    lyricsOpen: Boolean(lyricsOverlayRel),
    setIsPlaying,
    openLibrary: () => { resetBrowse(); setActivePage("albums"); setMobileNavOpen(false); },
  });
  usePlaybackEffects(player);

  const handleUploadAudioVLC = async () => {
    try {
      // TODO(types): This route declares vlc_ip in the query; preserve the legacy body pending a transport fix.
      const res = await fetch(apiUrl("/api/upload-audio-vlc"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vlcIp),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      alert(t("Upload started in the background"));
    } catch (err) {
      console.error("Upload failed:", err);
      alert(t("Upload failed: {{reason}}", { reason: err instanceof Error ? err.message : String(err) }));
    }
  };

  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().on("auth:changed", () => setIdentityEpoch(value => value + 1));
  }, []);
  useEffect(() => {
    if (connection.state === "wrong-nest") setIdentityEpoch(value => value + 1);
  }, [connection.state]);

  const previousBaseDir = useRef(baseDir);
  useEffect(() => {
    if (previousBaseDir.current && previousBaseDir.current !== baseDir) announceLibraryChanged();
    previousBaseDir.current = baseDir;
  }, [baseDir]);

  // Each page's props; the components themselves live in pageTable.tsx.
  const pageProps = {
    home: {
      albums,
      albumsLoading: !albumsLoaded || albumsLoading,
      albumsSnapshotAt,
      albumsLoaded,
      onOpenExplore: () => { resetBrowse(); setActivePage("dashboard"); },
      onOpenPlaylist: (name: string) => {
        switchStarted.current = { page: "playlists", at: performance.now() };
        pageTransition(() => openPlaylist(name));
      },
    },
    albums: { albums, albumsLoaded, onUploadAudioVLC: handleUploadAudioVLC, onLibraryChanged: announceLibraryChanged },
    playlists: { albums, selectedPlaylistName, setSelectedPlaylistName, backendOnline },
    dashboard: {},
  };
  const CurrentPage = isBuiltinPage(activePage) ? PAGES[activePage].Component : null;
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--app-bg)] text-ink">
      <UploadHost />
      {backendState === "locked" && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-coral/90 text-chalk px-4 py-2 text-center text-sm font-medium">
          {t("This device doesn't have access to your nest yet.")}{" "}
          <button
            type="button"
            // The settings page is owned by the app shell. A window event asks
            // for it from the banner, using the same signalling as the
            // sidebar, avatar menu and section shortcuts.
            onClick={() => window.dispatchEvent(new CustomEvent("krobi-show-settings", { detail: { section: "cuenta" } }))}
            className="underline font-semibold"
          >
            {t("Sign in with your account in Settings → My account")}
          </button>
        </div>
      )}
      {PlaybackTraceOverlay && <Suspense fallback={null}><PlaybackTraceOverlay /></Suspense>}
      <OfflineLibraryProvider key={identityEpoch} albums={albums as React.ComponentProps<typeof OfflineLibraryProvider>["albums"]}><StatusProvider>
        {/* Sidebar + page side by side; the player bar runs the full width under both. */}
        <div className="flex flex-1 min-h-0 min-w-0 flex-row">
        {/* Mobile drawer scrim (tap to close) */}
        {mobileNavOpen && (
          <div
            className={`${portrait ? "" : "md:hidden"} fixed inset-0 z-30 bg-black/35`}
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
        )}
        {/* Sidebar: static rail on md+, slide-in drawer on mobile; and in
            portrait at any width, where the rail would eat a fifth of the
            screen. The drawer and playlist list stay mounted either way. */}
        <div
          className={`z-40 h-full min-h-0 flex flex-col bg-panel transition-transform duration-(--dur) ease-out ${
            portrait
              // No `relative` here: both are bare `position` utilities and the
              // one Tailwind emits later would win, which is not this one.
              ? `fixed inset-y-0 left-0 shadow-[3px_0_0_var(--line-soft)] ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"}`
              : `relative md:z-20 md:shrink-0 md:translate-x-0
                 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-[3px_0_0_var(--line-soft)]
                 ${mobileNavOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"}`
          }`}
        >
          <Sidebar
            activePage={activePage}
            setActivePage={(p) => { resetBrowse(); setActivePage(p); setMobileNavOpen(false); }}
            selectedPlaylistName={selectedPlaylistName}
            setSelectedPlaylistName={setSelectedPlaylistName}
          />
        </div>
        <div className="shell-frame relative flex-1 min-h-0 flex flex-col min-w-0">
          <Header activePage={activePage} albums={albums} onMenuClick={() => setMobileNavOpen(true)} portrait={portrait} openPlaylist={selectedPlaylistName} />
          <OfflineBanner details={<ConnectionBannerDetails />} />
          <main className="k-page flex-1 min-h-0 overflow-hidden flex flex-col min-w-0 bg-[var(--app-bg)]">
            <div className="relative z-10 flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {/* A browse route (album/artist/playlist/search) renders on
                        top of whatever activePage says. BrowseRouter returns
                        null when its stack is empty, which is the signal to
                        fall through to the pages below. */}
                    <React.Suspense fallback={<ScreenFallback />}>
                    <BrowseSlot activePage={activePage} albums={albums} backendOnline={backendOnline}>
                    {CurrentPage && <CurrentPage key={activePage} {...pageProps[activePage as BuiltinPage]} />}
                    {activePage === "settings" && <SettingsPage key={settingsRequest?.nonce} initialSection={settingsRequest?.section} host={settingsHost} />}
                    {pluginPages.map((p) => activePage === p.id && <p.Component key={p.id} albums={albums} />)}
                    </BrowseSlot>
                    </React.Suspense>
                  </div>
                </div>
            </div>
          </main>
        </div>
        </div>
        <FixedBottomPlayerBar onOpenInfo={openTrackInfo} />
        {portrait && (
          <React.Suspense fallback={null}>
            <PortraitTabBar
              activePage={activePage}
              onSelect={(p) => {
                resetBrowse();
                // Tapping the tab you are already on pops to its root,
                // as on the phone: Playlists goes back to the grid.
                if (p === "playlists" && activePage === "playlists") setSelectedPlaylistName(null);
                setActivePage(p);
                setMobileNavOpen(false);
              }}
              onOpenSettings={() => window.dispatchEvent(new Event("krobi-show-settings"))}
            />
          </React.Suspense>
        )}
        <TrackInfoHost />
        <TrackTagsHost />
        <Overlays onOpenInfo={openTrackInfo} selectedTrack={selectedTrack} setVlcIp={setVlcIp} mode={mode} />
      </StatusProvider></OfflineLibraryProvider>
    </div>
  );
}

/**
 * Renders a browse route if one is on the stack, else its children.
 *
 * Kept as its own component so only *it* subscribes to the navigation store.
 * Subscribing from `AppContent` would re-render the sidebar, header and player
 * bar on every push and pop.
 */
function BrowseSlot({ children, activePage, albums, backendOnline }: { children?: React.ReactNode; activePage: string; albums: LibraryAlbums; backendOnline: boolean }) {
  // Must read the store, not test the element: `<BrowseRouter />` is always a
  // truthy React element regardless of what it renders, so branching on it
  // would show the browse slot forever.
  const hasRoute = useHasBrowseRoute();
  // Hide routed-under pages without unmounting so Back restores their filters, search and scroll state.
  return (
    <>
      <div className={hasRoute ? "hidden" : "contents"}>
        <SelectionBarLayout><div className="shell-page flex flex-col flex-1 min-h-0 min-w-0" data-page={activePage}>{children}</div></SelectionBarLayout>
      </div>
      {hasRoute && (
        <SelectionBarLayout>
          <div className="browse-slot flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 py-5">
            <BrowseRouter albums={albums} backendOnline={backendOnline} />
          </div>
        </SelectionBarLayout>
      )}
    </>
  );
}


function ScreenFallback() {
  const { t } = useTranslation();
  return <div className="flex-1 min-h-0" role="status" aria-label={t("Loading")} />;
}

export default function App() {
  if (isPlayerWindow()) {
    return (
      <React.Suspense fallback={<ScreenFallback />}>
        <PlayerWindowRoot />
      </React.Suspense>
    );
  }
  return (
    <AudioPlayerProvider>
      <PlayerWindowProvider>
        <LibraryProvider>
          <SettingsProvider>
            <AudioAnalyzerProvider>
              <PluginProviders>
                <AppContent />
              </PluginProviders>
            </AudioAnalyzerProvider>
          </SettingsProvider>
        </LibraryProvider>
      </PlayerWindowProvider>
    </AudioPlayerProvider>
  );
}
