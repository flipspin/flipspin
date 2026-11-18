import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { replace, searchRoute } from "../../browse/navigationStore";
import { rememberScopedSearch, type SearchScope } from "../../browse/catalogSearchHistory";
import { searchLibrary } from "./librarySearch";
import { useTopSearchIndex } from "./topSearchState";
import "./library-search.css";

export default function SearchScopeSwitch({ scope, query, libraryCount }: { scope: SearchScope; query: string; libraryCount?: number }) {
  const { t } = useTranslation();
  const index = useTopSearchIndex();
  const count = useMemo(() => {
    if (libraryCount !== undefined) return libraryCount;
    return Object.values(searchLibrary(index, query)).reduce((sum, rows) => sum + rows.length, 0);
  }, [index, query, libraryCount]);
  return <div className="search-scope" role="group" aria-label={t("Search scope")}>
    <button type="button" aria-pressed={scope === "library"} onClick={() => {
      if (scope !== "library") { rememberScopedSearch(query, "library"); replace({ kind: "library-search", query, title: "" }); }
    }}>{t("Library")} <span className="search-scope__count">{count}</span></button>
    <button type="button" aria-pressed={scope === "explore"} onClick={() => {
      if (scope !== "explore") { rememberScopedSearch(query, "explore"); replace(searchRoute(query)); }
    }}>{t("Explore")}</button>
  </div>;
}
