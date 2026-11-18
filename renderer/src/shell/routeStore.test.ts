import { afterEach, describe, expect, it } from "vitest";
import { _resetRouteForTest, getRoute, hashOf, initRouteFromLocation, navigate, openPlaylist, parseHash, setPlaylist, subscribeRoute } from "./routeStore";

afterEach(() => _resetRouteForTest());

describe("routeStore", () => {
  it("round-trips pages and playlist names through the hash", () => {
    expect(parseHash("")).toBeNull();
    expect(parseHash("#/albums")).toEqual({ page: "albums" });
    expect(parseHash("#/playlists")).toEqual({ page: "playlists", playlist: null });
    const named = hashOf({ page: "playlists", playlist: "Konbini / Wars ñ" });
    expect(parseHash(named)).toEqual({ page: "playlists", playlist: "Konbini / Wars ñ" });
    expect(hashOf({ page: "home", playlist: "kept" })).toBe("#/home");
  });

  it('resolves bookmarked settings hashes and old navigation callers', () => {
    expect(parseHash('#/ajustes')).toEqual({ page: 'settings' });
    expect(parseHash('#/settings')).toEqual({ page: 'settings' });
    expect(hashOf({ page: 'settings', playlist: null })).toBe('#/ajustes');
    window.history.replaceState(null, '', '#/ajustes');
    initRouteFromLocation();
    expect(getRoute().page).toBe('settings');
    navigate('ajustes');
    expect(window.location.hash).toBe('#/ajustes');
    const stop = subscribeRoute(() => {});
    navigate('albums');
    window.history.replaceState(null, '', '#/ajustes');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(getRoute().page).toBe('settings');
    stop();
  });

  it("starts from the address and writes each page into history", () => {
    window.history.replaceState(null, "", "#/playlists/echoes");
    initRouteFromLocation();
    expect(getRoute()).toEqual({ page: "playlists", playlist: "echoes" });
    const before = window.history.length;
    navigate("albums");
    expect(window.location.hash).toBe("#/albums");
    expect(window.history.length).toBe(before + 1);
  });

  it("remembers the open playlist while elsewhere, as Playlists used to", () => {
    initRouteFromLocation();
    navigate("home");
    setPlaylist("Falkor");
    expect(window.location.hash).toBe("#/home");
    navigate("playlists");
    expect(getRoute()).toEqual({ page: "playlists", playlist: "Falkor" });
    expect(window.location.hash).toBe("#/playlists/Falkor");
    setPlaylist(null);
    expect(window.location.hash).toBe("#/playlists");
    openPlaylist("echoes");
    expect(getRoute()).toEqual({ page: "playlists", playlist: "echoes" });
  });

  it("follows back and forward", () => {
    const stop = subscribeRoute(() => {});
    navigate("albums");
    navigate("dashboard");
    window.history.replaceState(null, "", "#/albums");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(getRoute().page).toBe("albums");
    stop();
  });
});
