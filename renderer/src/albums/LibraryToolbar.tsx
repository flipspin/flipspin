import { STEM_FILTERS } from '../stems/libraryStems';
import '../stems/library-stems.css';
import React, { type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutGrid, List as ListIcon, RotateCw, Search, X } from "lucide-react";
import { BPM_PRESET_OPTIONS, MOOD_FILTER_OPTIONS, SORT_FIELDS, type useLibraryView } from "./hooks/useLibraryView";
import { LYRIC_FILTERS } from "../lyrics/lyricStates";
import { UploadButton } from "../uploads/UploadButton";
import Select from "../ui/components/Select";
import { SEARCH_SHORTCUT_LABEL } from "../library/tracks/searchShortcut";
import PersonScope from "../acquisition/PersonScope";
import type { LibraryPerson } from "./hooks/useLibraryScope";
import { genreLabel } from "./genreLabel";

export type LibraryView = ReturnType<typeof useLibraryView>;

type Props = {
  view: LibraryView;
  /** "Nest · n" / "<cuenta> · n": whose list this is. */
  scoped: boolean;
  canScope: boolean;
  onScope: (scope: string) => void;
  serverCount: number;
  mineCount: number;
  accountName: string;
  owner?: boolean;
  people?: LibraryPerson[];
  selectedId?: string;
  reloading: boolean;
  onReload: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
};

/**
 * The Library's toolbar. The whole filter surface lives here; search plus one
 * dropdown per facet; instead of in a rail beside the table, so the songs get
 * the full width of the page.
 */
export default function LibraryToolbar({ view, scoped, canScope, onScope, serverCount, mineCount, accountName, owner, people, selectedId, reloading, onReload, searchRef }: Props) {
  const { t, i18n } = useTranslation();
  const { filters, sort, layout } = view;
  const searchQuery = filters.search;

  return (
    <div className="retro-table-toolbar shrink-0 flex flex-col gap-2 px-4 py-3 border-b-2 border-black" style={{ background: "var(--paper)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        {/* First control on the row, and deliberately so: it answers
            "whose list is this" before anything answers "what is in it". */}
        <div
          className="retro-table-segment flex items-center gap-1 border-2 border-black p-0.5"
          style={{ background: "var(--paper-2)" }}
          role="group"
          aria-label={t("Scope")}
        >
          <button
            type="button"
            aria-pressed={!scoped}
            onClick={() => onScope("all")}
            className="retro-table-segment__button border-0 px-3 py-0.5 text-xs font-bold"
            style={{
              minHeight: 0,
              background: !scoped ? "var(--coral)" : "transparent",
              color: !scoped ? "var(--dm-night, var(--ink))" : "var(--ink)",
              boxShadow: !scoped ? "2px 2px 0 0 var(--dm-line, #151515)" : "none",
            }}
          >
            {t("Nest · {{n}}", { n: serverCount })}
          </button>
          <PersonScope owner={owner} people={people} selectedId={selectedId} name={accountName} count={mineCount} disabled={!canScope} scoped={scoped} onSelect={onScope} />
        </div>

        <UploadButton signedIn={canScope} />
        <div className="relative ml-auto flex-1 min-w-[170px] max-w-[300px]">
          <Search
            size={14}
            aria-hidden
            className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-70"
          />
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => view.setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
            placeholder={t("title · artist · album")}
            aria-label={t("Search the library")}
            aria-keyshortcuts="Meta+K Control+K"
            className="retro-table-field album-toolbar-row-control w-full pl-8 pr-7"
          />
          {!searchQuery && <kbd className="search-shortcut-hint" aria-hidden>{SEARCH_SHORTCUT_LABEL}</kbd>}
          {searchQuery && (
            <button
              type="button"
              onClick={() => view.setSearch("")}
              aria-label={t("Clear the search")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 bg-transparent border-0 p-0 cursor-pointer opacity-70"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Sort: one field and a direction. The column headers write the
            same state, so the two can never disagree. */}
        <div className="flex items-center gap-1.5">
          <Select
            fill={false}
            ariaLabel={t("Sort by")}
            value={sort.field}
            onChange={view.setSortField}
            options={SORT_FIELDS.map((f) => ({ value: f.value, label: t(f.label) }))}
            display={
              <span>
                <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>{t("Sort:")} </span>
                {t(SORT_FIELDS.find((f) => f.value === sort.field)?.label || "")}
              </span>
            }
          />
          <button
            type="button"
            onClick={view.toggleSortDir}
            className="library-icon-btn"
            title={sort.dir === "asc" ? t("Ascending — reverse") : t("Descending — reverse")}
            aria-label={sort.dir === "asc" ? t("Ascending order; reverse") : t("Descending order; reverse")}
          >
            {sort.dir === "asc" ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
          </button>
        </div>

        {/* Layout: the same songs as rows, or folded into albums. */}
        <div className="library-segment" role="group" aria-label={t("View_noun")}>
          <button
            type="button"
            aria-pressed={layout === "list"}
            onClick={() => view.setLayout("list")}
            title={t("Song playlist")}
            aria-label={t("Song playlist")}
          >
            <ListIcon size={15} />
          </button>
          <button
            type="button"
            aria-pressed={layout === "grid"}
            onClick={() => view.setLayout("grid")}
            title={t("Album grid")}
            aria-label={t("Album grid")}
          >
            <LayoutGrid size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={onReload}
          disabled={reloading}
          aria-busy={reloading}
          className="library-icon-btn"
          title={t("Reload the library")}
          aria-label={t("Reload the library")}
        >
          <RotateCw size={14} className={reloading ? "animate-spin" : undefined} />
        </button>
      </div>

      {/* Filters: each narrows the songs; both layouts read the result.
          A filter that is narrowing turns yellow, so a collapsed
          dropdown still says the list below it is filtered. */}
      <div className="lb-filters">
        <Select
          label={t("Artist")}
          value={filters.artist}
          active={filters.artist !== view.ALL}
          onChange={view.setArtist}
          options={[{ value: view.ALL, label: t("All_masculine") }, ...view.artistList.map((a) => ({ value: a, label: a }))]}
        />
        <Select
          label={t("Album")}
          value={filters.album}
          active={filters.album !== view.ALL}
          onChange={view.setAlbum}
          options={[
            { value: view.ALL, label: t("All_masculine") },
            ...view.albumList.map((a) => ({ value: a.id, label: a.name, hint: filters.artist === view.ALL ? a.artist : undefined })),
          ]}
        />
        <Select
          label={t("Genre")}
          value={filters.genre}
          active={filters.genre !== view.ALL}
          onChange={view.setGenre}
          options={[{ value: view.ALL, label: t("All_masculine") }, ...view.genreList.map((g) => ({ value: g, label: genreLabel(g, i18n.resolvedLanguage || i18n.language) }))]}
        />
        <Select
          label={t("Mood")}
          value={filters.mood}
          active={filters.mood !== view.ALL}
          onChange={view.setMood}
          options={MOOD_FILTER_OPTIONS.map((m) => ({ value: m.value, label: t(m.label) }))}
        />
        <Select
          label="BPM"
          value={filters.bpmPreset}
          active={filters.bpmPreset !== "all"}
          onChange={view.setBpmPreset}
          options={BPM_PRESET_OPTIONS.map((b) => ({ value: b.value, label: t(b.label) }))}
        />
        <Select
          label={t("Key_tone")}
          value={filters.key}
          active={filters.key !== view.ALL}
          onChange={view.setKey}
          options={[
            { value: view.ALL, label: t("All keys") },
            ...view.keyList.map((k) => ({ value: k.camelot, label: k.keyName ? `${k.camelot} · ${k.keyName}` : k.camelot })),
          ]}
        />
        <Select
          label={t("Lyrics")}
          value={filters.lyric}
          active={filters.lyric !== "all"}
          onChange={view.setLyric}
          options={LYRIC_FILTERS.map((f) => ({ value: f.value, label: t(f.label), hint: String(view.lyricCounts[f.value]) }))}
          display={<>{t(LYRIC_FILTERS.find(f => f.value === filters.lyric)?.label || "All")} <span className="lb-count">{view.lyricCounts[filters.lyric]}</span></>}
        />
        <Select
          label={t("Stems_tracks")}
          value={filters.pistas}
          active={filters.pistas !== "all"}
          onChange={view.setPistas}
          className="lb-stems"
          options={STEM_FILTERS.map(f => ({ value: f.value, label: t(f.label), hint: String(view.stems.counts[f.value]) }))}
          display={<>{t(STEM_FILTERS.find(f => f.value === filters.pistas)?.label || "All")} <span className="lb-count">{view.stems.counts[filters.pistas]}</span></>}
        />
        <button
          type="button"
          onClick={view.clearFilters}
          disabled={view.activeCount === 0}
          className="library-icon-btn library-icon-btn--text"
          title={t("Remove all filters")}
        >
          <X size={13} />
          <span>{view.activeCount > 0 ? t("Clear ({{n}})", { n: view.activeCount }) : t("Clear")}</span>
        </button>
      </div>
    </div>
  );
}
