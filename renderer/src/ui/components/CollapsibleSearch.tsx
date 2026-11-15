import React, { useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SEARCH_SHORTCUT_LABEL, useSearchShortcutTarget } from "../../library/tracks/searchShortcut";
import "./CollapsibleSearch.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  variant?: "bare" | "boxed";
  /** A replacement toolbar can hide the control while keeping ⌘K available. */
  suspended?: boolean;
  onActivate?: () => void;
};

/** Focus precedes expansion, including a held ⌘K request from another page. */
export default function CollapsibleSearch({ value, onChange, label, variant = "bare", suspended = false, onActivate }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const shown = open || value !== "";
  useSearchShortcutTarget(input);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <div className={`collapsible-search collapsible-search--${variant}`} data-open={shown || undefined} data-suspended={suspended || undefined} aria-hidden={suspended || undefined} role="search">
      <button ref={trigger} type="button" className="collapsible-search__trigger" aria-label={label}
        title={`${label} · ${SEARCH_SHORTCUT_LABEL}`} aria-expanded={shown} aria-controls={id} tabIndex={shown || suspended ? -1 : 0}
        onClick={() => input.current?.focus({ preventScroll: true })}>
        <Search size={16} aria-hidden />
      </button>
      <input ref={input} id={id} type="search" aria-label={label} placeholder={label} value={value}
        tabIndex={shown && !suspended ? 0 : -1} onFocus={() => { onActivate?.(); setOpen(true); }} onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (value) onChange(""); else close();
        }}
        onBlur={e => { if (e.relatedTarget !== clear.current && !value) setOpen(false); }} />
      <button ref={clear} type="button" className="collapsible-search__clear" aria-label={t("Close search")}
        title={t("Close search")} tabIndex={shown && !suspended ? 0 : -1} onMouseDown={e => e.preventDefault()}
        onClick={() => { onChange(""); close(); }}><X size={14} aria-hidden /></button>
    </div>
  );
}
