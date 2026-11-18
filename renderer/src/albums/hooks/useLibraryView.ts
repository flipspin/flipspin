import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useLibraryStems, libraryStemKey } from '../../stems/libraryStems';
import { camelotIndex } from "@lib/camelot";
import { msg } from "../../i18n";
import { useLyricStates, lyricFilterStateFor, matchesLyricFilter, lyricFilterCounts } from "../../lyrics/lyricStates";
import { prepareSearchDocument, scoreSearchDocument, searchWords, type SearchDocument } from "../../search/match";
import { sortTracks } from "../../ui/components/useTableSort";

/** Share filters and sort between song and album layouts so their results agree.
 * Filters reset on navigation; sort and layout persist as preferences. */

// Labels are `msg()` keys; these tables are built once at import, so the
// render site translates them with `t(option.label)`.
export const BPM_PRESET_OPTIONS = [
  { value: "all", label: msg("All BPMs"), min: "", max: "" },
  { value: "slow", label: msg("Slow (< 90)"), min: "", max: "89" },
  { value: "mid", label: msg("Medium (90-119)"), min: "90", max: "119" },
  { value: "dance", label: msg("Danceable (120-139)"), min: "120", max: "139" },
  { value: "fast", label: msg("Fast (140+)"), min: "140", max: "" },
];

// The mood names are the analyzer's own vocabulary (`track.mood` values), shown
// as the tag reads on the track; only the "all" entry is UI copy.
export const MOOD_FILTER_OPTIONS = [
  { value: "Todos", label: msg("All moods") },
  { value: "ambient", label: "Ambient" },
  { value: "calm", label: "Calm" },
  { value: "melancholic", label: "Melancholic" },
  { value: "romantic", label: "Romantic" },
  { value: "groovy", label: "Groovy" },
  { value: "upbeat", label: "Upbeat" },
  { value: "aggressive", label: "Aggressive" },
  { value: "dark", label: "Dark" },
];

// What can be sorted by, and which way each starts when picked: newest first,
// A→Z, slowest first, shortest first.
export const SORT_FIELDS = [
  { value: "date", label: msg("Just added"), dir: "desc" },
  { value: "title", label: msg("Title"), dir: "asc" },
  { value: "artist", label: msg("Artist"), dir: "asc" },
  { value: "album", label: msg("Album"), dir: "asc" },
  { value: "bpm", label: "BPM", dir: "asc" },
  { value: "key", label: msg("Key_tone"), dir: "asc" },
  { value: "duration", label: msg("Duration"), dir: "asc" },
];
export const LAYOUTS = ["list", "grid"];

const ALL = "Todos";
const VIEW_KEY = "krobi.libraryView";
// Migrate the legacy value shared by sorting and grouping.
const LEGACY_GROUP_KEY = "krobi.libraryGroupMode";
const DEFAULT_SORT = { field: "date", dir: "desc" };

function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (saved && SORT_FIELDS.some((f) => f.value === saved.sort?.field)) {
      return {
        sort: { field: saved.sort.field, dir: saved.sort.dir === "asc" ? "asc" : "desc" },
        layout: LAYOUTS.includes(saved.layout) ? saved.layout : "list",
        sortExplicit: saved.sortExplicit ?? (saved.sort.field !== "date" || saved.sort.dir !== "desc"),
      };
    }
    // Preserve the sort order represented by the saved grouping choice.
    const legacy = localStorage.getItem(LEGACY_GROUP_KEY);
    const fromLegacy = { album: "album", artist: "artist", bpm: "bpm", key: "key" }[legacy];
    if (fromLegacy) return { sort: { field: fromLegacy, dir: "asc" }, layout: "list", sortExplicit: true };
  } catch { /* localStorage unavailable or junk — use the defaults */ }
  return { sort: DEFAULT_SORT, layout: "list", sortExplicit: false };
}

const splitGenres = (g) =>
  (Array.isArray(g) ? g : typeof g === "string" ? [g] : [])
    .flatMap((x) => String(x).split(","))
    .map((x) => x.trim())
    .filter(Boolean);

const albumIdOf = (a) => a?.path || a?.album || "";

//  album order in the grid: the same field, read for a whole album
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Infinity);
const mostCommon = (xs) => {
  if (!xs.length) return Infinity;
  const counts = new Map();
  xs.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
};
const lower = (s) => (s || "").toString().toLowerCase();
const ALBUM_KEYS = {
  date: (a) => Math.max(0, ...a.tracks.map((t) => Number(t.dateAdded ?? 0))),
  title: (a) => lower(a.album),
  album: (a) => lower(a.album),
  artist: (a) => lower(a.artist),
  bpm: (a) => mean(a.tracks.map((t) => Number(t.bpm)).filter((n) => Number.isFinite(n) && n > 0)),
  key: (a) => mostCommon(a.tracks.map((t) => camelotIndex(t?.analysis?.camelot)).filter(Number.isFinite)),
  duration: (a) => a.tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0),
};
function sortAlbums(albums, { field, dir }) {
  const key = ALBUM_KEYS[field] || ALBUM_KEYS.date;
  const mul = dir === "desc" ? -1 : 1;
  const cmp = (va, vb) => (typeof va === "string" ? va.localeCompare(vb) : va === vb ? 0 : va < vb ? -1 : 1);
  return [...albums].sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    // Albums missing the value (no BPM analysed yet) stay last either way.
    if (va === Infinity || vb === Infinity) return va === vb ? 0 : va === Infinity ? 1 : -1;
    return cmp(va, vb) * mul || lower(a.artist).localeCompare(lower(b.artist)) || lower(a.album).localeCompare(lower(b.album));
  });
}

export function useLibraryView(albums) {
  const lyricStates = useLyricStates();
  const stems = useLibraryStems(albums);
  const [pistas, setPistas] = useState("all");
  const [lyric, setLyric] = useState("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const words = useMemo(() => searchWords(deferredSearch), [deferredSearch]);
  const documents = useMemo(() => {
    const prepared: { track: object; document: SearchDocument }[] = [];
    for (const a of albums) for (const t of a.tracks) {
      prepared.push({ track: t, document: prepareSearchDocument({ title: t.title, artist: t.artist || a.artist, album: a.album }) });
    }
    return prepared;
  }, [albums]);
  const scores = useMemo(() => {
    const matches = new Map<object, number>();
    if (words.length) for (const { track, document } of documents) {
      const score = scoreSearchDocument(document, words);
      if (score >= 0) matches.set(track, score);
    }
    return matches;
  }, [documents, words]);
  const [artist, setArtist] = useState(ALL);
  const [album, setAlbum] = useState(ALL);
  const [genre, setGenre] = useState(ALL);
  const [mood, setMood] = useState(ALL);
  const [bpmPreset, setBpmPreset] = useState("all");
  const [key, setKey] = useState(ALL);
  const [{ sort, layout, sortExplicit }, setView] = useState(loadView);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, layout, sortExplicit })); } catch { /* ignore */ }
  }, [sort, layout, sortExplicit]);

  const setLayout = (next) => setView((v) => ({ ...v, layout: next }));
  const setSortField = (field) => {
    const start = SORT_FIELDS.find((f) => f.value === field)?.dir || "asc";
    setView((v) => ({ ...v, sort: { field, dir: start }, sortExplicit: true }));
  };
  const toggleSortDir = () => setView((v) => ({ ...v, sort: { ...v.sort, dir: v.sort.dir === "asc" ? "desc" : "asc" }, sortExplicit: true }));
  // A column header: the same field again flips the direction.
  const sortByColumn = (field) => (field === sort.field ? toggleSortDir() : setSortField(field));

  //  the facets' options, from the whole library (not the filtered one,
  // so picking one artist does not empty the artist list)
  const artistList = useMemo(
    () => Array.from(new Set<string>(albums.map((a) => a.artist).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [albums],
  );
  const albumList = useMemo(
    () =>
      albums
        .filter((a) => artist === ALL || a.artist === artist)
        .map((a) => ({ id: albumIdOf(a), name: a.album || "", artist: a.artist || "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [albums, artist],
  );
  const genreList = useMemo(
    () => Array.from(new Set<string>(albums.flatMap((a) => splitGenres(a.genre)))).sort((a, b) => a.localeCompare(b)),
    [albums],
  );
  const keyList = useMemo(() => {
    const map = new Map();
    albums.forEach((a) =>
      a.tracks.forEach((t) => {
        const cam = t?.analysis?.camelot;
        if (cam && !map.has(cam)) map.set(cam, t.key || "");
      }),
    );
    return Array.from(map.entries())
      .map(([camelot, keyName]) => ({ camelot, keyName }))
      .sort((x, y) => camelotIndex(x.camelot) - camelotIndex(y.camelot));
  }, [albums]);

  //  filtering: albums keep only the songs that pass
  const lyricCandidates = useMemo(() => {
    const preset = BPM_PRESET_OPTIONS.find((o) => o.value === bpmPreset) || BPM_PRESET_OPTIONS[0];
    const min = preset.min === "" ? null : Number(preset.min);
    const max = preset.max === "" ? null : Number(preset.max);
    const bpmOk = (t) => {
      if (min === null && max === null) return true;
      const bpm = Number(t?.bpm);
      if (!Number.isFinite(bpm)) return false;
      return (min === null || bpm >= min) && (max === null || bpm <= max);
    };

    return albums
      .map((a) => {
        if (album !== ALL && albumIdOf(a) !== album) return null;
        if (artist !== ALL && a.artist !== artist) return null;
        if (genre !== ALL && !splitGenres(a.genre).includes(genre)) return null;
        const tracks = a.tracks.filter(
          (t) =>
            (!words.length || scores.has(t)) &&
            bpmOk(t) &&
            (mood === ALL || t?.mood === mood) &&
            (key === ALL || t?.analysis?.camelot === key) &&
            (pistas === "all" || stems.keys.has(libraryStemKey(t)) === (pistas === "ready")),
        );
        return tracks.length ? { ...a, tracks, totalTracks: a.tracks.length } : null;
      })
      .filter(Boolean);
  }, [albums, scores, words, artist, album, genre, mood, bpmPreset, key, pistas, stems.keys]);

  // Each count answers how many songs choosing that option would show, with
  // the current scope, Stems and all other filters still applied.
  const lyricCounts = useMemo(() => lyricFilterCounts(lyricCandidates.flatMap(a => a.tracks), lyricStates), [lyricCandidates, lyricStates]);
  const filteredAlbums = useMemo(() => lyricCandidates.map(a => ({
    ...a, tracks: a.tracks.filter(t => matchesLyricFilter(lyricFilterStateFor(t, lyricStates), lyric)),
  })).filter(a => a.tracks.length), [lyricCandidates, lyricStates, lyric]);

  //  the two layouts' orders
  // Date-desc is the existing default order. Explicit column sorts always win.
  const rank = words.length > 0 && !sortExplicit;
  const tracks = useMemo(() => {
    const rows = filteredAlbums.flatMap(a => a.tracks.map(t => ({ track: { ...t, album: a }, score: scores.get(t) || 0 })));
    const ordered = sortTracks(rows.map(r => r.track), sort.field, sort.dir);
    if (!rank) return ordered;
    const byTrack = new Map<object, number>(rows.map(r => [r.track, r.score]));
    return ordered.sort((a, b) => byTrack.get(b) - byTrack.get(a));
  }, [filteredAlbums, sort, rank, scores]);
  const sortedAlbums = useMemo(() => {
    const ordered = sortAlbums(filteredAlbums, sort);
    if (!rank) return ordered;
    const best = new Map<object, number>(ordered.map(a => [a, a.tracks.reduce((max, t) => Math.max(max, scores.get(t) || 0), 0)]));
    return ordered.sort((a, b) => best.get(b) - best.get(a));
  }, [filteredAlbums, sort, rank, scores]);

  //  what is narrowing the view, for chips and "Clear"
  const filters = { search, artist, album, genre, mood, bpmPreset, key, lyric, pistas };
  const activeCount =
    (search ? 1 : 0) +
    (artist !== ALL ? 1 : 0) +
    (album !== ALL ? 1 : 0) +
    (genre !== ALL ? 1 : 0) +
    (mood !== ALL ? 1 : 0) +
    (bpmPreset !== "all" ? 1 : 0) +
    (key !== ALL ? 1 : 0) + (lyric !== "all" ? 1 : 0) + (pistas !== "all" ? 1 : 0);
  const clearFilters = () => {
    setSearch("");
    setArtist(ALL);
    setAlbum(ALL);
    setGenre(ALL);
    setMood(ALL);
    setBpmPreset("all");
    setKey(ALL);
    setLyric("all");
    setPistas("all");
  };
  // Picking another artist drops an album that is not theirs.
  const pickArtist = (value) => {
    setArtist(value);
    if (value !== ALL && album !== ALL) {
      const a = albums.find((x) => albumIdOf(x) === album);
      if (a && a.artist !== value) setAlbum(ALL);
    }
  };

  return {
    ALL,
    filters,
    deferredSearch,
    searchStale: search !== deferredSearch,
    setSearch,
    setArtist: pickArtist,
    setAlbum,
    setGenre,
    setMood,
    setBpmPreset,
    setKey,
    setLyric,
    lyricStates,
    lyricCounts,
    stems,
    setPistas,
    activeCount,
    clearFilters,
    sort,
    setSortField,
    toggleSortDir,
    sortByColumn,
    layout,
    setLayout,
    artistList,
    albumList,
    genreList,
    keyList,
    filteredAlbums,
    tracks,
    sortedAlbums,
    albumIdOf,
  };
}
