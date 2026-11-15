import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, ChevronDown } from "lucide-react";

/**
 * A clickable column-header cell. Rendered as a div (not a button) to dodge the
 * app's global `button {}` styling. Shows a faint up-chevron to signal sortability
 * and a solid up/down chevron on the active column. (SVG icons, not ▲/▼ glyphs,
 * which render off-center inside the font line-box.)
 */
type SortHeaderProps<T extends string> = {
  field: T;
  label: string;
  sortField?: string | null;
  sortDir?: string;
  onSort?: (field: T) => void;
  className?: string;
  align?: "left" | "center" | "right";
};

export function SortHeader<T extends string>({ field, label, sortField, sortDir, onSort, className = "", align = "left" }: SortHeaderProps<T>) {
  const { t } = useTranslation();
  if (!onSort) return <div className={`${className}${align === "center" ? " text-center" : align === "right" ? " text-right" : ""}`}><span data-column-label>{label}</span></div>;
  const active = sortField === field;
  const justify = align === "center" ? "justify-center" : align === "right" ? "justify-end" : "justify-start";
  return (
    <div
      data-sort-header
      data-sorted={active || undefined}
      className={`${className} flex items-center gap-1 ${justify} cursor-pointer select-none hover:text-black`}
      onClick={() => onSort(field)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(field); } }}
      title={t("Sort by {{column}}", { column: label })}
    >
      <span data-column-label className="truncate">{label}</span>
      <span className="song-sort-arrow grid place-items-center shrink-0" aria-hidden>
        {active && sortDir === "desc"
          ? <ChevronDown size={13} strokeWidth={3} />
          : <ChevronUp size={13} strokeWidth={3} />}
      </span>
    </div>
  );
}
