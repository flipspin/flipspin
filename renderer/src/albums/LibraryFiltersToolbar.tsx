import React, { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutGrid, List as ListIcon, RotateCw } from "lucide-react";
import { SORT_FIELDS, type useLibraryView } from "./hooks/useLibraryView";
import { UploadButton } from "../uploads/UploadButton";
import Select from "../ui/components/Select";
import CollapsibleSearch from "../ui/components/CollapsibleSearch";
import PersonScope from "../acquisition/PersonScope";
import type { LibraryPerson } from "./hooks/useLibraryScope";
import { LibraryFiltersButton } from "./LibraryFilters";

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
 * Library keeps its boxed controls in the card; facets open from Filtros.
 */
export default function LibraryFiltersToolbar({ view, scoped, canScope, onScope, serverCount, mineCount, accountName, owner, people, selectedId, reloading, onReload }: Props) {
  const { t } = useTranslation();
  const { filters, sort, layout } = view;
  const searchQuery = filters.search;
  const [announcedCount, setAnnouncedCount] = useState<number | null>(null);
  useEffect(() => {
    setAnnouncedCount(null);
    const timer = window.setTimeout(() => setAnnouncedCount(view.tracks.length), 1400);
    return () => window.clearTimeout(timer);
  }, [searchQuery, view.tracks.length]);

  return (
    <div className="retro-table-toolbar library-toolbar shrink-0 flex flex-col gap-2 px-4 py-3 border-b-2 border-black" style={{ background: "var(--paper)" }}>
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
              boxShadow: !scoped ? "2px 2px 0 0 var(--dm-line, var(--line))" : "none",
            }}
          >
            {t("Nest · {{n}}", { n: serverCount })}
          </button>
          <PersonScope owner={owner} people={people} selectedId={selectedId} name={accountName} count={mineCount} disabled={!canScope} scoped={scoped} onSelect={onScope} />
        </div>

        <UploadButton signedIn={canScope} />
        <div className="ml-auto flex items-center">
          <span role="status" aria-live="polite" className="sr-only">{announcedCount === null ? "" : t("{{n}} songs", { n: announcedCount })}</span>
          <CollapsibleSearch variant="boxed" value={searchQuery} onChange={view.setSearch} label={t("Search the library")} />
        </div>

        <LibraryFiltersButton view={view} />

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

    </div>
  );
}
