import { Tag, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TagValue } from "../../library/tracks/songTags";

import { NUMBERS, type Field } from "../../library/tracks/songTagFields";

export function TagField({ id, field, label, value, original, changed, manual = false, editable, saving, unavailable, mixed = false, originalText, tooltip, onChange, onOriginal }: {
  id: string; field: Field; label: string; value: string; original?: TagValue; changed: boolean; manual?: boolean;
  editable: boolean; saving: boolean; unavailable?: string; mixed?: boolean; originalText?: string; tooltip?: string;
  onChange: (value: string) => void; onOriginal: () => void;
}) {
  const { t } = useTranslation();
  const source = t(manual || changed ? "Corrected by hand" : "File tag");
  return <div className={changed ? "song-field song-field--changed" : "song-field"}>
    {field === "compilation" ? <select id={id} aria-label={label} className="song-input" value={mixed && !changed ? "mixed" : value} disabled={!editable} title={unavailable || tooltip} onChange={event => onChange(event.target.value)}>
      {mixed && !changed ? <option value="mixed" disabled>{t("Mixed")}</option> : null}
      <option value="">{t("Not tagged")}</option><option value="true">{t("Yes")}</option><option value="false">{t("No")}</option>
    </select> : <input id={id} aria-label={label} className="song-input" type={NUMBERS.has(field) ? "number" : "text"} min={NUMBERS.has(field) ? 0 : undefined} max={NUMBERS.has(field) ? field === "year" ? 9999 : 999 : undefined} step={NUMBERS.has(field) ? 1 : undefined} maxLength={NUMBERS.has(field) ? undefined : 1000} value={value} readOnly={!editable}
      title={unavailable || tooltip || (NUMBERS.has(field) && original != null ? `${label} · ${source}` : value || undefined)} placeholder={t(mixed ? "Mixed" : "Not tagged")} onChange={event => onChange(event.target.value)} />}
    {original != null || changed ? <span className="song-source" role="img" aria-label={source} title={source}>{manual || changed ? <Pencil size={14} aria-hidden /> : <Tag size={14} aria-hidden />}</span> : null}
    {changed && originalText ? <span className="bulk-original" title={tooltip}>{t("was {{value}}", { value: originalText })}</span> : null}
    {changed ? <button type="button" className="song-original" disabled={saving} aria-label={t("Use original {{field}} value", { field: label.toLocaleLowerCase() })} onClick={onOriginal}>{t("Use original value")}</button> : null}
  </div>;
}
