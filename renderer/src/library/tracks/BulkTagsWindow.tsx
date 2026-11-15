import { TagField } from "../../ui/components/TagField";
import { Fragment, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, isApiError, useCurrentUser } from "../../data";
import { useOffline } from "../../offline/useOffline";
import { useHeld } from "../../ui/react/useHeld";
import PanelModal from "../../ui/components/PanelModal";
import { FIELDS, tagText, tagValue, type Field } from "./songTagFields";
import type { TagValue } from "./songTags";
import { observeBulkTags, tagEditError, tagEditReason } from "./bulkTags";
import "./song-window.css";
import "./bulk-tags.css";

const BULK_FIELDS = FIELDS.slice(1, 6);
async function readSelection(paths: string[], signal: AbortSignal) {
  const result = new Array<Awaited<ReturnType<typeof readSong>>>(paths.length);
  let cursor = 0;
  async function readSong(relPath: string) { return apiGet("/api/library/tags/{relPath}", { params: { path: { relPath } }, signal }); }
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, async () => {
    while (cursor < paths.length) { const idx = cursor++; result[idx] = await readSong(paths[idx]); }
  }));
  return result;
}

export default function BulkTagsWindow({ paths, onClose }: { paths: string[] | null; onClose: () => void }) {
  const held = useHeld(paths);
  return held ? <BulkEditor key={JSON.stringify(held)} paths={held} open={!!paths} onClose={onClose} /> : null;
}

function BulkEditor({ paths, open, onClose }: { paths: string[]; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const offline = useOffline();
  const client = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const receipt = useRef({ body: "", key: "" });
  const owner = me.data?.role === "owner";
  const allowed = owner && !offline && paths.length >= 1 && paths.length <= 500;
  const query = useQuery({ queryKey: ["bulk-song-tags", id, paths], queryFn: ({ signal }) => readSelection(paths, signal), enabled: open && allowed,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const baseline = query.data;
  const originals = (field: Field) => [...new Map((baseline || []).map(view => [JSON.stringify(view.fields[field] ?? null), view.fields[field] ?? null])).values()];
  const display = (value: TagValue | undefined) => typeof value === "boolean" ? t(value ? "Yes" : "No") : tagText(value) || t("Empty");
  const mixed = (field: Field) => originals(field).length > 1;
  const original = (field: Field) => mixed(field) ? t("Mixed") : display(originals(field)[0]);
  const tooltip = (field: Field) => originals(field).map(display).join(" · ");
  const patch: Record<string, TagValue> = {};
  for (const [field] of BULK_FIELDS) {
    if (baseline && field in draft && !baseline.every(view => tagText(view.fields[field]) === draft[field] || tagText(view.fields[field]) === draft[field]!.trim())) patch[field] = tagValue(field, draft[field]!);
  }
  const changed = Object.keys(patch);
  const names = changed.map(field => t(FIELDS.find(([key]) => key === field)![1]).toLocaleLowerCase()).join(", ");
  const fileReason = baseline?.find(view => !view.writable)?.reason;
  const unavailable = offline ? t("Editing tags requires the nest") : fileReason ? tagEditReason(fileReason) : undefined;
  const editable = allowed && !!baseline && baseline.every(view => view.writable) && !query.isFetching && !saving;
  const writeLabel = t("Write {{fields}} to {{count}} files", { fields: names, count: paths.length });
  const write = async () => {
    if (!editable || !baseline || !changed.length || pending.current) return;
    pending.current = true; setSaving(true); setMessage("");
    try {
      const body = { items: paths.map((relPath, idx) => ({ relPath, rev: baseline[idx].rev })), set: patch, id3Version: 4 };
      const signature = JSON.stringify(body);
      if (receipt.current.body !== signature) receipt.current = { body: signature, key: crypto.randomUUID() };
      const result = await apiPost("/api/library/tags/batch", { headers: { "Idempotency-Key": receipt.current.key }, body });
      void observeBulkTags(result.editId, names, client);
      setConfirm(false);
      onClose();
    } catch (error) {
      // A refused request is receipted too. A deliberate retry needs a new key;
      // a lost network response must reuse its key to find the accepted journal.
      if (isApiError(error) && error.kind === "http") receipt.current = { body: "", key: "" };
      setConfirm(false); setMessage(tagEditError(error));
    }
    finally { pending.current = false; setSaving(false); }
  };
  return <>
    <PanelModal open={open} className="song-window bulk-tags" title={t("Edit {{count}} songs", { count: paths.length })} width="max-w-2xl" accent="var(--teal)" onClose={onClose} dismissible={!saving}
      headerExtra={baseline ? <span className="song-format">{[...new Set(baseline.map(view => view.format))].join(" · ")}</span> : null}
      footer={<>
        <span className="song-change-count">{changed.length ? `${names} · ${t("{{n}} songs", { n: paths.length, count: paths.length })}` : t("{{n}} changes", { n: 0, count: 0 })}</span>
        <button type="button" className="k-btn k-btn--text" disabled={saving} onClick={onClose}>{t("Cancel")}</button>
        {owner ? <button type="submit" form={id} className="k-btn song-write" disabled={!editable || !changed.length} title={unavailable}>{saving ? t("Saving…") : changed.length ? writeLabel : t("Write to files")}</button> : null}
      </>}>
      <form id={id} className="song-body" onSubmit={event => { event.preventDefault(); if (editable && changed.length) setConfirm(true); }}>
        <dl className="song-fields">
          <dt>{t("Title")}</dt><dd><span className="bulk-mixed" title={t("Each song keeps its own title")}>{t("{{count}} different", { count: baseline ? originals("title").length : paths.length })}</span></dd>
          {BULK_FIELDS.map(([field, label]) => <Fragment key={field}>
            <dt><label htmlFor={`${id}-${field}`}>{t(label)}</label></dt>
            <dd><TagField id={`${id}-${field}`} field={field} label={t(label)} value={draft[field] ?? (mixed(field) ? "" : tagText(originals(field)[0]))}
              changed={field in patch} editable={editable} saving={saving} unavailable={unavailable} mixed={mixed(field)} originalText={original(field)} tooltip={tooltip(field)}
              onChange={next => setDraft(previous => ({ ...previous, [field]: next }))}
              onOriginal={() => setDraft(previous => { const next = { ...previous }; delete next[field]; return next; })} /></dd>
          </Fragment>)}
        </dl>
        {query.isPending && allowed ? <span role="status">{t("Loading…")}</span> : null}
        {query.isError ? <div role="alert">{t("Could not read tags")} <button type="button" className="k-btn k-btn--text" onClick={() => void query.refetch()}>{t("Retry")}</button></div> : null}
        {message ? <div role="alert">{message}</div> : null}
      </form>
    </PanelModal>
    {confirm ? <PanelModal open={open} role="alertdialog" title={t("Write {{fields}} to {{count}} files?", { fields: names, count: paths.length })} onClose={() => setConfirm(false)} dismissible={!saving} width="max-w-lg"
      footer={<><button type="button" className="k-btn k-btn--text" disabled={saving} onClick={() => setConfirm(false)}>{t("Cancel")}</button><button type="button" className="k-btn song-write" disabled={saving || !editable} onClick={() => void write()}>{writeLabel}</button></>}>
      <div className="song-confirm"><ul>{changed.map(field => <li key={field}><b>{t(FIELDS.find(([key]) => key === field)![1])}:</b> <span title={tooltip(field as Field)}>{original(field as Field)}</span> → {display(patch[field])}</li>)}</ul></div>
    </PanelModal> : null}
  </>;
}
