import type { BrowseAcquisition } from "../browse/acquisition.types";
import type { CatalogCard } from "../browse/cards.types";
import type { ApiData } from "../data";
import type { BrowseTrack } from "../browse/browse.types";
import { isBrowseTrack } from "../browse/browseApi";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, Music, RefreshCw } from "lucide-react";
import { legacyErrorText } from "@lib/legacyErrorText";
import { apiGet } from "../data";
import { push, routeFor } from "../browse/navigationStore";
import { CardCell, MediaCard as LegacyMediaCard } from "../ui/components/MediaCard";
import { ArtistTag, EntityList, EntityRow, ExplorePanel, FillGrid, GenreCircle, ShowMoreButton, TagWrap, useShowMore } from "../browse/ExplorePanel";
import { TrackList } from "../browse/TrackList";
import { AcquireBar } from "../browse/AcquireBar";
import { useAcquisition } from "../browse/useAcquisition";
import { openExternal } from "../ui/components/cardArt";
import { useTranslation } from "react-i18next";
import i18n, { msg } from "../i18n";
import { registerExploreRefresh } from "../library/search/topSearchState";

// The legacy component supports percentage sizes; its default infers number.
const MediaCard = LegacyMediaCard as CatalogCard;

/** Name each row's provider and show stale cache age so provenance stays clear.
 * Render failures per row so one provider error does not blank the dashboard. */
// Translate known provider row ids at render time; retain unknown titles so new rows remain usable.
const ROW_LABELS: Record<string, string> = {
  "top-playlists": msg("Featured playlists"),
  "top-artists": msg("Featured artists"),
  "top-albums": msg("Featured albums"),
  "top-tracks": msg("Trending songs"),
  "new-releases": msg("New releases"),
  genres: msg("Genres"),
  podcasts: msg("Podcasts"),
  "more-from-your-artists": msg("More from your artists"),
};

// A row whose emptiness means something other than "the provider sent
// nothing". "More from your artists" starts from the library, so an empty row is
// a new library or artists whose catalog you already own; not an outage.
const ROW_EMPTY: Record<string, string> = {
  "more-from-your-artists": msg("Nothing to suggest yet: the catalog has no albums by your artists that you don't already have."),
};

// Row accent, by position; same bounded accent set the sidebar and the home
// panels use, so the page reads as part of Flipspin and not as a new palette.
const ROW_ACCENTS = ["var(--coral)", "var(--blue)", "var(--teal)", "var(--purple)", "var(--green)", "var(--yellow)"];

// Dashboard row kinds -> browse route kinds. A "track" row has no page of its
// own to open, so those cards stay unclickable rather than pretending.
const ROUTE_KIND: Record<string, string> = {
  playlist: "playlist",
  artist: "artist",
  album: "album",
};

const KIND_EMPTY_LABEL: Record<string, string> = {
  genre: msg("genres"),
  podcast: msg("podcasts"),
  playlist: msg("playlists"),
  artist: msg("artists"),
  album: msg("albums"),
  track: msg("songs"),
};

// The dashboard body is unknown in OpenAPI; narrow each field as it enters
// the existing camelCase/snake_case normalization path.
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** First non-empty value among the given keys; the payload may be camelCase or snake_case. */
function pick(source: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record(source)?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

/** An error can arrive as a string, as `{message}`, or as FastAPI's `{detail}`. */
function errorText(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  return text(pick(raw, "message", "detail", "reason")) || i18n.t("Unknown error");
}

/** A provider is either a plain name or a `{id, name}` descriptor row. */
function providerName(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  return text(pick(raw, "name", "id"));
}

function normalizeItem(raw: unknown, rowId: string, index: number) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(pick(raw, "title", "name") || "").trim();
  // A card with no name is noise on a chart row; drop it rather than render a
  // "Untitled" ghost between two real entries.
  if (!title) return null;
  const id = pick(raw, "id");
  const track = record(raw)?.track;
  return {
    key: String(id ?? `${rowId}-${index}`),
    // The provider's own id, kept separate from `key` (which falls back to a
    // positional placeholder). Half of the coordinate a card navigates by, so
    // it must not be conflated with the render key.
    id: id === null ? null : String(id),
    title,
    subtitle: String(pick(raw, "subtitle", "artist", "description") || "").trim(),
    imageUrl: text(pick(raw, "imageUrl", "image_url", "image", "cover")),
    providerUrl: text(pick(raw, "providerUrl", "provider_url", "link", "url")),
    // Top songs only: the browse track this card would be saved as.
    track: isBrowseTrack(track) ? track : null,
  };
}

function normalizeRow(raw: unknown, index: number, fallbackProvider: string | null) {
  const id = String(pick(raw, "id") ?? `row-${index}`);
  const rawItems = record(raw)?.items;
  const items = Array.isArray(rawItems)
    ? rawItems.map((item: unknown, i: number) => normalizeItem(item, id, i)).filter((item) => item !== null)
    : [];
  return {
    id,
    title: ROW_LABELS[id] || String(pick(raw, "title") || id),
    kind: String(pick(raw, "kind") || "album"),
    provider: providerName(pick(raw, "providerName", "provider_name", "provider")) || fallbackProvider,
    // The registry id (e.g. "deezer"), which is what a route needs. The display
    // name ("Deezer") is for the chip and is not interchangeable with it.
    providerId: String(pick(raw, "provider", "providerId", "provider_id") || "deezer"),
    items,
    error: errorText(pick(raw, "error", "errorMessage", "error_message")),
    stale: Boolean(pick(raw, "stale")),
  };
}

/** Pass the clock in so cached-data age keeps advancing while the page is open. */
function relativeTime(iso: string, now: number, locale: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.348],
    ["month", 12],
  ];
  let value = seconds;
  let unit: Intl.RelativeTimeFormatUnit = "year";
  for (const [name, size] of units) {
    if (Math.abs(value) < size) {
      unit = name;
      break;
    }
    value = Math.round(value / size);
  }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */

/** The provider attribution, small, in the panel header. Always rendered —
 *  including on a failed panel: a Deezer chart is Deezer's editorial. */
function ProviderNote({ name }: { name?: string | null }) {
  const { t } = useTranslation();
  if (!name) return null;
  return (
    <span className="text-[11px] font-semibold text-[var(--ink-3)] whitespace-nowrap" title={t("Data provided by {{name}}", { name })}>
      {t("via {{name}}", { name })}
    </span>
  );
}

/** How many entries a panel shows before "See all", by kind. */
const VISIBLE: Record<string, number> = { album: 10, playlist: 8, track: 8, artist: 20, podcast: 5 };

/** Which column a row's kind lives in, and in what order inside it: cover
 *  grids and the genre circles where there is room, lists beside them. */
const WIDE_KINDS = ["genre", "album"];
// Rows placed by id ahead of their kind's order: "More from your artists" comes
// right under the genres, before Deezer's own album rows.
const WIDE_ORDER = ["genre", "more-from-your-artists", "album"];
const NARROW_KINDS = ["track", "playlist", "artist", "podcast"];
// An unknown kind sorts after every known one rather than before them.
const rank = (kinds: string[], kind: string) => (kinds.includes(kind) ? kinds.indexOf(kind) : kinds.length);
const byKind = (kinds: string[]) => (a: { row: ReturnType<typeof normalizeRow> }, b: { row: ReturnType<typeof normalizeRow> }) =>
  rank(kinds, kinds.includes(a.row.id) ? a.row.id : a.row.kind) -
  rank(kinds, kinds.includes(b.row.id) ? b.row.id : b.row.kind);

/** Where a dashboard item navigates to, if anywhere. */
function opener(row: ReturnType<typeof normalizeRow>, item: NonNullable<ReturnType<typeof normalizeItem>>) {
  const routeKind = ROUTE_KIND[row.kind];
  if (!item.id || !routeKind) return undefined;
  return () => push({ kind: routeKind, provider: row.providerId, id: item.id!, title: item.title });
}

/**
 * The chart's songs as a real tracklist: ownership marks, ▶ for what the server
 * already has, "+" to save; the same rows as an album page, because each card
 * carries the browse track it would be saved as (`item.track`).
 */
function TopSongs({ items }: { items: NonNullable<ReturnType<typeof normalizeItem>>[] }) {
  const [ownershipKey, setOwnershipKey] = useState(0);
  const acquisition = useAcquisition(() => setOwnershipKey((k) => k + 1)) as BrowseAcquisition;
  const tracks = useMemo(() => items.map((item) => item.track).filter((track) => track !== null), [items]);
  const openAlbum = (track: BrowseTrack) => {
    const route = routeFor({ ref: track.albumRef, title: track.albumTitle }, "album");
    if (route) push(route);
  };
  return (
    <div className="-mx-4 -mt-4 flex flex-col">
      <div className="px-4 pt-3 empty:hidden"><AcquireBar acquisition={acquisition} /></div>
      <TrackList
        tracks={tracks}
        showArtist
        showDuration={false}
        ownershipKey={ownershipKey}
        onAcquire={(track) => acquisition.acquire([track])}
        onOpenAlbum={openAlbum}
      />
    </div>
  );
}

/**
 * One provider row, as a panel. Albums are a cover grid; playlists and songs a
 * ranked list; artists a wrap of tags. A row that failed keeps its header and
 * replaces only its own body, so one dead row never blanks the page.
 */
function DashboardPanel({ row, accent, onRetry, retrying }: { row: ReturnType<typeof normalizeRow>; accent: string; onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  const more = useShowMore(row.items, VISIBLE[row.kind] ?? 10);
  const title = t(row.title);
  const kindLabel = t(KIND_EMPTY_LABEL[row.kind] || msg("items"));

  let body;
  if (row.error) {
    body = (
      <div className="dec-error items-start">
        <AlertTriangle size={16} />
        <span className="min-w-0 flex-1">
          {row.provider
            ? t("Couldn't load “{{title}}” from {{provider}}.", { title, provider: row.provider })
            : t("Couldn't load “{{title}}”.", { title })}{" "}
          {row.error}
        </span>
        <button type="button" onClick={onRetry} disabled={retrying} className="explore-button shrink-0">
          <RefreshCw size={13} className={retrying ? "animate-spin" : undefined} />
          <span>{t("Retry")}</span>
        </button>
      </div>
    );
  } else if (row.items.length === 0) {
    body = (
      <p className="m-0 text-center text-sm text-[var(--ink-3)] py-4">
        {ROW_EMPTY[row.id] ? t(ROW_EMPTY[row.id]) : t("The provider returned no {{kind}} for this section.", { kind: kindLabel })}
      </p>
    );
  } else if (row.kind === "album") {
    body = (
      <FillGrid
        items={row.items}
        renderItem={(item) => (
          <CardCell width={undefined} key={item.key}>
            <MediaCard title={item.title} subtitle={item.subtitle} imageUrl={item.imageUrl} kind="album" size="100%" onOpen={opener(row, item)} />
          </CardCell>
        )}
      />
    );
  } else if (row.kind === "track") {
    body = <TopSongs items={more.visible} />;
  } else if (row.kind === "genre") {
    body = (
      <FillGrid
        items={row.items}
        min={96}
        gap={12}
        renderItem={(item) => (
          <GenreCircle
            key={item.key}
            name={item.title}
            imageUrl={item.imageUrl}
            onOpen={item.id ? () => push({ kind: "genre", provider: row.providerId, id: item.id!, title: item.title }) : undefined}
          />
        )}
      />
    );
  } else if (row.kind === "podcast") {
    // A podcast has no page here and nothing to save: its row opens Deezer.
    body = (
      <EntityList>
        {more.visible.map((item) => (
          <EntityRow
            key={item.key}
            title={item.title}
            subtitle={item.subtitle}
            imageUrl={item.imageUrl}
            external
            onOpen={item.providerUrl ? () => openExternal(item.providerUrl) : undefined}
          />
        ))}
      </EntityList>
    );
  } else if (row.kind === "artist") {
    body = (
      <TagWrap>
        {more.visible.map((item) => (
          <ArtistTag key={item.key} name={item.title} imageUrl={item.imageUrl} onOpen={opener(row, item)} />
        ))}
      </TagWrap>
    );
  } else {
    body = (
      <EntityList>
        {more.visible.map((item, i) => (
          <EntityRow key={item.key} rank={i + 1} title={item.title} subtitle={item.subtitle} imageUrl={item.imageUrl} onOpen={opener(row, item)} />
        ))}
      </EntityList>
    );
  }

  return (
    <ExplorePanel
      title={title}
      accent={accent}
      count={!row.error && row.items.length ? row.items.length : null}
      right={
        <>
          {row.stale && !row.error ? <span className="text-[11px] font-semibold text-[var(--ink-3)]">{t("cached")}</span> : null}
          <ProviderNote name={row.provider} />
        </>
      }
      bodyClassName="p-4 flex flex-col"
    >
      {body}
      {/* The cover and genre grids count their own rows (FillGrid); the lists use a fixed count. */}
      {!row.error && row.kind !== "album" && row.kind !== "genre" ? <ShowMoreButton state={more} /> : null}
    </ExplorePanel>
  );
}

/** Loading placeholder shaped like a panel, so the page doesn't jump. */
function SkeletonPanel({ accent, tall = false }: { accent: string; tall?: boolean }) {
  return (
    <ExplorePanel title={<span className="inline-block h-4 w-36 rounded bg-[var(--paper-2)] animate-pulse align-middle" />} accent={accent}>
      <div className={`${tall ? "h-[320px]" : "h-[180px]"} rounded-panel bg-[var(--paper-2)] animate-pulse`} aria-hidden />
    </ExplorePanel>
  );
}

/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const { t, i18n: i18nInstance } = useTranslation();
  const [rows, setRows] = useState<ReturnType<typeof normalizeRow>[] | null>(null); // null = never loaded yet
  const [meta, setMeta] = useState<{ cachedAt: string | null; stale: boolean }>({ cachedAt: null, stale: false });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Bypass the provider cache only for explicit refresh or retry to preserve its request quota.
  const load = useCallback(async (force = false) => {
    setLoading(true);
    let data: ApiData<"/api/dashboard", "get">;
    try {
      data = await apiGet("/api/dashboard", {
        params: { query: force ? { refresh: true } : {} },
      });
    } catch (err) {
      if (!aliveRef.current) return;
      // Keep displayed rows after a failed refresh so the error notice does not discard usable data.
      setError(legacyErrorText(err) || t("Couldn't reach the backend."));
      setLoading(false);
      return;
    }
    if (!aliveRef.current) return;
    const fallbackProvider = providerName(pick(data || {}, "providerName", "provider_name", "provider"));
    const rawRows = record(data)?.rows;
    const list: unknown[] = Array.isArray(rawRows) ? rawRows : [];
    setRows(list.map((row, i) => normalizeRow(row, i, fallbackProvider)));
    setMeta({
      cachedAt: text(pick(data || {}, "cachedAt", "cached_at")),
      stale: Boolean(pick(data || {}, "stale")),
    });
    setError(null);
    setNow(Date.now());
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // Age the "actualizado hace…" label while the page stays open.
  useEffect(() => {
    if (!meta.cachedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [meta.cachedAt]);

  const cachedLabel = useMemo(
    () => (meta.cachedAt ? relativeTime(meta.cachedAt, now, i18nInstance.language) : null),
    [meta.cachedAt, now, i18nInstance.language],
  );

  useEffect(() => registerExploreRefresh({ loading, when: cachedLabel, run: () => { void load(true); } }), [loading, cachedLabel, load]);

  const failedRows = useMemo(() => (rows || []).filter((row) => row.error).length, [rows]);
  const firstLoad = loading && rows === null;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full p-6 overflow-y-auto min-[1180px]:overflow-y-hidden min-[1180px]:pb-0 slim-scrollbar">
      <header className="flex flex-wrap items-center gap-3 mb-5 shrink-0">
        {/* The subtitle sits beside the title, on its baseline; it wraps under
            it only when the row runs out of room. */}
        <div className="min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1
            className="font-bold text-[22px] leading-tight tracking-tight m-0"
            style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}
          >
            {t("Explore")}
          </h1>
          <p className="text-[13px] text-[var(--ink-3)] m-0">
            {t("Playlists and new releases from the connected providers.")}
            {cachedLabel && !meta.stale ? <> · {t("Updated {{when}}.", { when: cachedLabel })}</> : null}
          </p>
        </div>
      </header>

      {/* The provider failed and the backend fell back to its cache. Say so. */}
      {meta.stale && (
        <div
          className="flex items-start gap-2.5 mb-4 px-3.5 py-2.5 rounded-xl border-2 border-black bg-[var(--yellow-tint)] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] shrink-0"
          role="status"
        >
          <Clock size={16} className="mt-[2px] shrink-0" style={{ color: "var(--fg-yellow)" }} />
          <p className="text-[13px] leading-snug m-0" style={{ color: "var(--fg-yellow)" }}>
            <span className="font-bold">{t("Cached data.")}</span>{" "}
            {cachedLabel
              ? t("The provider couldn't be reached, so this is the last saved copy (updated {{when}}). It may be out of date.", { when: cachedLabel })
              : t("The provider couldn't be reached, so this is the last saved copy. It may be out of date.")}
          </p>
        </div>
      )}

      {/* A refresh that failed outright, with rows still on screen underneath. */}
      {error && (
        <div className="dec-error items-start mb-4 shrink-0">
          <AlertTriangle size={16} />
          <span className="min-w-0 flex-1">
            {rows?.length
              ? t("Couldn't refresh: {{reason}}", { reason: error })
              : t("The panel couldn't be loaded: {{reason}}", { reason: error })}
          </span>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading}
            className="explore-button shrink-0"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
            <span>{t("Retry")}</span>
          </button>
        </div>
      )}

      {/* Some rows made it, some didn't; the page renders what it has. */}
      {failedRows > 0 && !error && (
        <p className="text-[12.5px] text-[var(--ink-3)] m-0 mb-4 shrink-0">
          {t("{{n}} sections could not be loaded; the rest is up to date.", { count: failedRows, n: failedRows })}
        </p>
      )}

      {firstLoad ? (
        <div className="explore-columns">
          <div className="explore-column slim-scrollbar flex flex-col gap-6 min-w-0">
            <SkeletonPanel accent={ROW_ACCENTS[0]} tall />
            <SkeletonPanel accent={ROW_ACCENTS[1]} />
          </div>
          <div className="explore-column slim-scrollbar flex flex-col gap-6 min-w-0">
            <SkeletonPanel accent={ROW_ACCENTS[2]} />
            <SkeletonPanel accent={ROW_ACCENTS[3]} tall />
          </div>
        </div>
      ) : rows && rows.length > 0 ? (
        // Two columns: the cover grids where there is room for them, the
        // ranked lists and the artist tags in a narrower one beside them.
        <div className="explore-columns">
          <div className="explore-column slim-scrollbar flex flex-col gap-6 min-w-0">
            {rows.map((row, i) => ({ row, i })).filter(({ row }) => WIDE_KINDS.includes(row.kind)).sort(byKind(WIDE_ORDER)).map(({ row, i }) => (
              <DashboardPanel key={row.id} row={row} accent={ROW_ACCENTS[i % ROW_ACCENTS.length]} onRetry={() => load(true)} retrying={loading} />
            ))}
          </div>
          <div className="explore-column slim-scrollbar flex flex-col gap-6 min-w-0">
            {/* Anything of an unknown kind lands here last, as a ranked list. */}
            {rows.map((row, i) => ({ row, i })).filter(({ row }) => !WIDE_KINDS.includes(row.kind)).sort(byKind(NARROW_KINDS)).map(({ row, i }) => (
              <DashboardPanel key={row.id} row={row} accent={ROW_ACCENTS[i % ROW_ACCENTS.length]} onRetry={() => load(true)} retrying={loading} />
            ))}
          </div>
        </div>
      ) : !error ? (
        <div className="rounded-xl border-2 border-dashed border-[var(--ink-4)] bg-panel/60 px-6 py-12 flex flex-col items-center gap-2 text-center">
          <Music size={26} className="text-[var(--ink-4)]" aria-hidden />
          <p className="text-sm font-bold m-0">{t("Nothing to explore yet.")}</p>
          <p className="text-[13px] text-[var(--ink-3)] m-0 max-w-[38ch]">
            {t("No dashboard provider is on. Turn one on in Settings → Sources.")}
          </p>
        </div>
      ) : null}

    </div>
  );
}
