import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

type PillDropdownProps<T extends string> = {
  options: readonly { id: T; label: React.ReactNode; lang?: string }[];
  value: T;
  onChange: (value: T) => void;
  align?: "left" | "right";
  fallbackLabel?: React.ReactNode;
  labelClassName?: string;
  buttonLabelClassName?: string;
  menuStyle?: React.CSSProperties;
  ariaLabel?: string;
};

/** Share the waveform picker with Settings to keep dropdown styling consistent.
 * Right alignment keeps a picker at the end of a row inside its card. */
export default function PillDropdown<T extends string>({
  options,
  value,
  onChange,
  align = "left",
  fallbackLabel = "",
  labelClassName,
  buttonLabelClassName,
  menuStyle,
  ariaLabel,
}: PillDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node | null)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = options.find((o) => o.id === value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`waveform-btn ${open ? "waveform-btn--on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={buttonLabelClassName}>{current?.label ?? fallbackLabel}</span>
        {open ? <ChevronUp size={13} strokeWidth={2.5} aria-hidden /> : <ChevronDown size={13} strokeWidth={2.5} aria-hidden />}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className={`waveform-menu absolute top-full mt-1.5 z-20 ${align === "right" ? "right-0" : "left-0"}`}
          style={menuStyle}
        >
          {options.map((o) => {
            const selected = o.id === value;
            return (
              <li key={o.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  lang={o.lang}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                  className={`waveform-option ${selected ? "waveform-option--on" : ""}`}
                >
                  {selected && <Check size={12} strokeWidth={3} aria-hidden />}
                  <span className={labelClassName}>{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
