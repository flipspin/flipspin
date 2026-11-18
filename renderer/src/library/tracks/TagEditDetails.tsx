import { poll } from '../../data/poll'
import { msg } from '../../i18n';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../data";
import { useOffline } from "../../offline/useOffline";
import { useHeld } from "../../ui/react/useHeld";
import PanelModal from "../../ui/components/PanelModal";
import { FIELDS, tagText } from "./songTagFields";
import { editRunning, readTagEdit, tagEditReason, undoBulkTags } from "./bulkTags";
import "./song-window.css";
import "./bulk-tags.css";

export default function TagEditDetails({ editId, onClose }: { editId: string | null; onClose: () => void }) {
  const held = useHeld(editId);
  return held ? <Details key={held} editId={held} open={!!editId} onClose={onClose} /> : null;
}
function Details({ editId, open, onClose }: { editId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const offline = useOffline();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["tag-edit", editId], queryFn: () => readTagEdit(editId), enabled: open && me.data?.role === "owner" && !offline,
    refetchInterval: query => poll('active', !!query.state.data && editRunning(query.state.data), 1000, false) });
  const entry = query.data;
  const states = { applied: msg("Changed"), skipped: msg("Skipped"), failed: msg("Failed_adjective"), planned: msg("Pending"), "undo-skipped": msg("Skipped"), undone: msg("Edit undone") };
  const undoable = entry && ["applied", "partial"].includes(entry.state) && entry.rows.some(row => row.state === "applied") && entry.expires_at * 1000 > Date.now();
  return <PanelModal open={open} title={t("Edit details")} className="bulk-tags" onClose={onClose} footer={<>
    {undoable ? <button type="button" className="k-btn k-btn--text" disabled={offline} onClick={() => { onClose(); void undoBulkTags(editId, client); }}>{t("Undo")}</button> : null}
    <button type="button" className="k-btn k-btn--text" onClick={onClose}>{t("Close")}</button>
  </>}>
    <div className="song-body">
      {entry?.rows.map(row => <section className="bulk-edit-row" key={row.idx}>
        <b className="song-path">{row.rel_after}</b>
        <span>{row.reason ? tagEditReason(row.reason) : t(states[row.state] || "Pending")}</span>
        <ul>{Object.entries(row.fields_after || {}).map(([field, value]) => <li key={field}><b>{t(FIELDS.find(([key]) => key === field)?.[1] || field)}:</b> {row.fields_before ? <>{tagText(row.fields_before[field]) || t("Empty")} → </> : null}{tagText(value) || t("Empty")}</li>)}</ul>
      </section>)}
      {query.isPending ? <span role="status">{t("Loading…")}</span> : null}
      {query.isError ? <div role="alert">{t("Could not check the change")} <button type="button" className="k-btn k-btn--text" onClick={() => void query.refetch()}>{t("Retry")}</button></div> : null}
    </div>
  </PanelModal>;
}
