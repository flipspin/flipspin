import { waitForPoll } from '../../data/poll'
import { msg } from '../../i18n';
import type { QueryClient } from "@tanstack/react-query";
import { announceLibraryChanged } from "@lib/libraryEvents";
import i18n from "../../i18n";
import { apiGet, apiPost, isApiError, type ApiData } from "../../data";
import { dismissNotification, notify } from "../../ui/notifications";
import { openTagEditDetails } from "./bulkTagStore";

export type TagEdit = ApiData<"/api/library/edits/{editId}", "get">;
export const readTagEdit = (editId: string) => apiGet("/api/library/edits/{editId}", { params: { path: { editId } } });
export const editRunning = (entry: TagEdit) => entry.state === "planned" || entry.state === "applying";

export function tagEditReason(reason: string | null | undefined) {
  const keys = {
    "changed-since": msg("Changed on the nest"), "no-change": "Sin cambios", "unsupported-format": msg("This format cannot be edited"),
    "unreadable": msg("Could not read the file_present"), "hardlinked": msg("The file has hard links"), "no-space": msg("Not enough space to write the file"),
    "write-failed": msg("Could not write the file"), "missing": msg("File not found"), "expired": msg("Undo has expired"),
    "newer-edit": msg("There is a newer edit"), "busy": msg("An edit is already running"), "interrupted": msg("Edit interrupted"), "unknown-state": msg("Could not check the change"),
  };
  return i18n.t(keys[reason || ""] || "Could not save the change");
}
export function tagEditError(error: unknown) {
  const detail = isApiError(error) && error.body && typeof error.body === "object" && "detail" in error.body ? error.body.detail : null;
  return tagEditReason(detail && typeof detail === "object" && "reason" in detail ? String(detail.reason) : error instanceof Error ? error.message : null);
}
export function refreshTagEdits(client: QueryClient) {
  announceLibraryChanged();
  for (const queryKey of [["library"], ["analysis"], ["song-tags"], ["tag-edit"]]) void client.invalidateQueries({ queryKey });
}
async function waitForEdit(editId: string): Promise<TagEdit> {
  for (;;) {
    const entry = await readTagEdit(editId);
    if (!editRunning(entry)) return entry;
    await waitForPoll(1000);
  }
}
const undoing = new Set<string>();
export async function undoBulkTags(editId: string, client: QueryClient) {
  if (undoing.has(editId)) return;
  undoing.add(editId);
  const id = `bulk-undo-${editId}`;
  notify({ id, sticky: true, message: i18n.t("Undoing…") });
  try {
    const undo = await apiPost("/api/library/edits/{editId}/undo", { params: { path: { editId } } });
    const entry = await waitForEdit(undo.editId);
    const changed = entry.rows.filter(row => row.state === "applied").length;
    const skipped = entry.rows.length - changed;
    refreshTagEdits(client);
    dismissNotification(`bulk-tags-${editId}`);
    notify({ id, level: skipped ? "warning" : "success", sticky: true,
      message: i18n.t("Undid edit of {{count}} songs", { count: changed }) + (skipped ? ` · ${i18n.t("{{count}} skipped", { count: skipped })}` : ""),
      action: { label: i18n.t("Details"), onSelect: () => openTagEditDetails(undo.editId) } });
  } catch (error) { notify({ id, level: "error", message: tagEditError(error) }); }
  finally { undoing.delete(editId); }
}

/** Observe the one server journal after acceptance, even if its sheet unmounts. */
export async function observeBulkTags(editId: string, names: string, client: QueryClient) {
  const id = `bulk-tags-${editId}`;
  const details = { label: i18n.t("Details"), onSelect: () => openTagEditDetails(editId), dismiss: false };
  notify({ id, sticky: true, message: i18n.t("Writing {{fields}}…", { fields: names }), action: details });
  try {
    const entry = await waitForEdit(editId);
    const changed = entry.rows.filter(row => row.state === "applied").length;
    const skipped = entry.rows.filter(row => row.state === "skipped" && row.reason !== "no-change").length;
    const failed = entry.rows.filter(row => row.state === "failed").length;
    refreshTagEdits(client);
    notify({ id, level: skipped || failed ? "warning" : changed ? "success" : "info", sticky: true,
      message: i18n.t("Changed {{fields}} of {{count}} songs", { fields: names, count: changed })
        + (skipped ? ` · ${i18n.t("{{count}} skipped", { count: skipped })}` : "")
        + (failed ? ` · ${i18n.t("{{count}} failed_feminine", { count: failed })}` : ""),
      action: details, secondaryAction: changed ? { label: i18n.t("Undo"), dismiss: false, onSelect: () => { void undoBulkTags(editId, client); } } : undefined });
  } catch {
    notify({ id, level: "warning", sticky: true, message: i18n.t("Could not check the change"), action: details });
  }
}
