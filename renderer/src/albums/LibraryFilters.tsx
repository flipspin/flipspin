import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ListFilter, X } from "lucide-react";
import { Popover } from "../ui/react/components/Popover";
import Select from "../ui/components/Select";
import { genreLabel } from "./genreLabel";
import { BPM_PRESET_OPTIONS, MOOD_FILTER_OPTIONS } from "./hooks/useLibraryView";
import { LYRIC_FILTERS } from "../lyrics/lyricStates";
import { STEM_FILTERS } from "../stems/libraryStems";
import type { LibraryView } from "./LibraryToolbar";
import "../stems/library-stems.css";
import "./LibraryFilters.css";

// Search keeps its own visible field; this surface counts the eight facets.
function activeFilters(view: LibraryView, t: ReturnType<typeof useTranslation>["t"], language: string) {
  const { filters: f, ALL } = view;
  const bpm = BPM_PRESET_OPTIONS.find(option => option.value === f.bpmPreset);
  return [
    { id: "artist", name: t("Artist"), value: f.artist, active: f.artist !== ALL, clear: () => view.setArtist(ALL) },
    { id: "album", name: t("Album"), value: view.albumList.find(album => album.id === f.album)?.name || f.album, active: f.album !== ALL, clear: () => view.setAlbum(ALL) },
    { id: "genre", name: t("Genre"), value: genreLabel(f.genre, language), active: f.genre !== ALL, clear: () => view.setGenre(ALL) },
    { id: "mood", name: t("Mood"), value: t(MOOD_FILTER_OPTIONS.find(option => option.value === f.mood)?.label || f.mood), active: f.mood !== ALL, clear: () => view.setMood(ALL) },
    { id: "bpm", name: t("BPM"), value: bpm?.min && bpm.max ? `${bpm.min}–${bpm.max}` : bpm?.min ? `${bpm.min}+` : bpm?.max ? `≤ ${bpm.max}` : "", active: f.bpmPreset !== "all", clear: () => view.setBpmPreset("all") },
    { id: "key", name: t("Key_tone"), value: f.key, active: f.key !== ALL, clear: () => view.setKey(ALL) },
    { id: "lyric", name: t("Lyrics"), value: t(LYRIC_FILTERS.find(option => option.value === f.lyric)?.label || "All"), active: f.lyric !== "all", clear: () => view.setLyric("all") },
    { id: "stems", name: t("Stems"), value: t(STEM_FILTERS.find(option => option.value === f.pistas)?.label || "All"), active: f.pistas !== "all", clear: () => view.setPistas("all") },
  ].filter(filter => filter.active);
}

export function LibraryFiltersButton({ view }: { view: LibraryView }) {
  const { t, i18n } = useTranslation();
  const { filters } = view;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const count = activeFilters(view, t, i18n.resolvedLanguage || i18n.language).length;
  return (
    <>
      <button type="button" ref={anchorRef} className="library-icon-btn library-icon-btn--text"
        aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
        title={t("Artist · Album · Genre · Mood · BPM · Key · Lyrics · Stems")}>
        <ListFilter size={14} aria-hidden />
        <span>{t("Filters")}</span>
        {count > 0 && <span className="lb-count">{count}</span>}
        <ChevronDown size={14} aria-hidden />
      </button>
      <Popover open={open} anchorRef={anchorRef} id={id} aria-label={t("Filters")}
        className="library-filters-popover"
        onClose={() => {
          // Select's existing panels portal to body outside the dismiss stack.
          // Let that inner panel handle the first outside press / Escape.
          if (!document.querySelector(".krobi-select-panel")) setOpen(false);
        }}>
        <div className="library-filters-grid">
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
          label={t("BPM")}
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
          label={t("Stems")}
          value={filters.pistas}
          active={filters.pistas !== "all"}
          onChange={view.setPistas}
          className="lb-stems"
          options={STEM_FILTERS.map(f => ({ value: f.value, label: t(f.label), hint: String(view.stems.counts[f.value]) }))}
          display={<>{t(STEM_FILTERS.find(f => f.value === filters.pistas)?.label || "All")} <span className="lb-count">{view.stems.counts[filters.pistas]}</span></>}
        />
        </div>
      </Popover>
    </>
  );
}

export function LibraryFiltersActive({ view, count, total }: { view: LibraryView; count: number; total: number }) {
  const { t, i18n } = useTranslation();
  const filters = activeFilters(view, t, i18n.resolvedLanguage || i18n.language);
  if (!filters.length) return null;
  return (
    <div className="library-active-filters" role="group" aria-label={t("Active filters")}>
      {filters.map(filter => (
        <span className="library-active-filter" key={filter.id}>
          <span>{filter.name}</span><b>{filter.value}</b>
          <button type="button" className="library-filter-clear" onClick={filter.clear}
            aria-label={t("Remove {{nombre}} filter", { nombre: filter.name })} title={t("Remove filter")}>
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <button type="button" className="library-filter-clear" onClick={view.clearFilters} title={t("Remove all filters")}>{t("Clear")}</button>
      <span className="library-filter-results" style={{ opacity: view.searchStale ? 0.5 : 1 }}>{t("{{n}} of {{total}}", { n: count, total })}</span>
    </div>
  );
}
