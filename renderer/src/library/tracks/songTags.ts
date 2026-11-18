import { waitForPoll } from '../../data/poll'
import { apiGet, apiPost, type ApiData } from "../../data";

export type TagView = ApiData<"/api/library/tags/{relPath}", "get">;
export type TagValue = TagView["fields"][string];

export function isTagView(value: unknown): value is TagView {
  return !!value && typeof value === "object" && "rev" in value && typeof value.rev === "string"
    && "writable" in value && typeof value.writable === "boolean" && "fields" in value
    && !!value.fields && typeof value.fields === "object";
}

/** Undo is accepted asynchronously. Only a completed journal row means it worked. */
export async function undoSongTags(editId: string) {
  const undo = await apiPost("/api/library/edits/{editId}/undo", { params: { path: { editId } } });
  for (let attempt = 0; attempt < 120; attempt++) {
    const entry = await apiGet("/api/library/edits/{editId}", { params: { path: { editId: undo.editId } } });
    if (!entry || typeof entry !== "object" || !("state" in entry)) throw new Error("undo-failed");
    if (entry.state === "applied") return;
    if (entry.state !== "applying" && entry.state !== "planned") {
      const rows = "rows" in entry && Array.isArray(entry.rows) ? entry.rows : [];
      const reason = rows.find(row => row.reason)?.reason;
      throw new Error(typeof reason === "string" ? reason : "undo-failed");
    }
    await waitForPoll(500);
  }
  throw new Error("undo-pending");
}
