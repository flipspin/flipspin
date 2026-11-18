import { apiUrl } from "@lib/api";

/** File deletion from song tables. Throws with the server's detail. */

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
}

/** Delete the track's file from disk, for the whole household. Irreversible. */
export function deleteTrackFile(path: string): Promise<void> {
  return post("/api/delete-track", { path });
}
