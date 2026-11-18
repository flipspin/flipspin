import { installTestClock, clockUser, waitForClock as waitFor } from '../../test/test-clock'
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import BulkTagsWindow from "./BulkTagsWindow";
import { SongWindowHost } from "./SongWindowHost";
import { closeBulkTags, closeTagEditDetails, openBulkTags, useBulkTagPaths, type TagSong } from "./bulkTagStore";
import { useBulkTagMenu } from "./useBulkTagMenu";
import { songMenuItems } from "./songMenuItems";
import SelectionBar from "../../ui/components/SelectionBar";
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from "../../settings/test-support";
import type { SchemaTagView, SchemaTagEditDetail } from "../../api/generated/schema";

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined;
afterEach(() => { act(() => { closeBulkTags(); closeTagEditDetails(); }); vi.restoreAllMocks(); fake?.restore(); fake = undefined; localStorage.removeItem("krobi.tags.skipSingleConfirmation"); });
const paths = ["Orbit/One.mp3", "Other/Two.flac", "Other/Three.m4a"];
const songs = paths.map(relPath => ({ path: `/music/${relPath}`, relPath }));
const views: SchemaTagView[] = paths.map((_, idx) => ({ fields: { title: `Song ${idx + 1}`, artist: ["Ensemble", "Guest"], albumArtist: idx === 0 ? "Various Artists" : "Ensemble", album: idx === 0 ? "Orbit" : "Other", genre: idx === 0 ? null : idx === 1 ? "Electronic" : "Synthpop", year: idx === 0 ? null : 1981 }, format: idx === 0 ? "MP3" : idx === 1 ? "FLAC" : "M4A", rev: `"rev-${idx}"`, writable: true }));
const entry = (state = "applied"): SchemaTagEditDetail => ({ id: "edit-1", kind: "tags-batch", undoes: null, principal: "owner", state, plan_hash: "hash", created_at: 1, applied_at: 2, job_id: "job-1", expires_at: 9_999_999_999,
  rows: paths.map((relPath, idx) => ({ edit_id: "edit-1", idx, rel_before: relPath, rel_after: relPath, identity_before: views[idx].rev, identity_after: `"new-${idx}"`, fields_before: { genre: views[idx].fields.genre }, fields_after: { genre: "Synth-pop" }, recycle_path: null, state: "applied", reason: null, newer_edit_id: null })) });
function Opened() { const current = useBulkTagPaths(); return <BulkTagsWindow paths={current} onClose={closeBulkTags} />; }
function Menu({ selection }: { selection: TagSong[] }) {
  const items = songMenuItems({ onPlay() {}, onPlayNext() {}, onQueue() {}, tagItems: useBulkTagMenu()(selection) });
  return <>{items.map((item, idx) => "label" in item && item.label === "Editar etiquetas" ? <button key={idx} disabled={item.disabled} title={item.tooltip} onClick={item.onClick}>{item.label}</button> : null)}</>;
}
function setup({ member = false, offline = false, respond, selection = songs, host = false, menu = false, bar = false }: { member?: boolean; offline?: boolean; respond?: (request: RecordedRequest) => ResponseSpec | undefined; selection?: TagSong[]; host?: boolean; menu?: boolean; bar?: boolean } = {}) {
  fake = installFakeSettings({ forcedOffline: offline, respond: request => {
    const response = respond?.(request); if (response) return response;
    const path = decodeURIComponent(request.pathname);
    if (path === "/api/me") return { status: 200, json: { role: member ? "member" : "owner", isOwner: !member } };
    if (path === "/api/library/tags/batch") return { status: 202, json: { editId: "edit-1", progressId: "job-1" } };
    const idx = paths.findIndex(key => path === `/api/library/tags/${key}`);
    if (idx >= 0) return { status: 200, json: views[idx] };
    if (path === "/api/library/edits/edit-1") return { status: 200, json: entry() };
    if (path === "/api/library/edits/edit-1/undo") return { status: 202, json: { editId: "undo-1" } };
    if (path === "/api/library/edits/undo-1") return { status: 200, json: { ...entry(), id: "undo-1", kind: "undo", undoes: "edit-1" } };
    return { status: 404, json: {} };
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (offline) client.setQueryData(["me", "profile"], { role: "owner", isOwner: true });
  const view = render(<QueryClientProvider client={client}>
    {menu ? <Menu selection={selection} /> : bar ? <SelectionBar tracks={selection} count={selection.length} onPlay={vi.fn()} onPlayNext={vi.fn()} onQueue={vi.fn()} playlistItems={[]} onClear={vi.fn()} /> : null}
    {host ? <SongWindowHost /> : <Opened />}
  </QueryClientProvider>);
  if (!menu && !bar) act(() => openBulkTags(selection));
  return { client, ...view };
}
const batches = () => fake!.requests.filter(request => request.method === "POST" && request.pathname === "/api/library/tags/batch");
async function edit(label = "Género", value = "Synth-pop") { const input = await waitFor(() => screen.getByLabelText(label)); await waitFor(() => expect(input).not.toHaveAttribute("readonly")); fireEvent.change(input, { target: { value } }); return input; }
async function preview() { await user.click(screen.getByRole("button", { name: "Escribir género en 3 archivos" })); return waitFor(() => screen.getByRole("alertdialog")); }
async function save() { await edit(); const dialog = await preview(); await user.click(within(dialog).getByRole("button", { name: "Escribir género en 3 archivos" })); }

it("shows shared multivalues, Mixed with every original value in tooltips, and read-only titles", async () => {
  setup(); await waitFor(() => expect(screen.getByLabelText("Artista")).toHaveValue("Ensemble; Guest"));
  expect(screen.getByText("3 diferentes")).toHaveAttribute("title", "Cada canción conserva su título");
  expect(screen.queryByLabelText("Título")).toBeNull();
  expect(screen.getByLabelText("Género")).toHaveAttribute("placeholder", "Mixto");
  expect(screen.getByLabelText("Género")).toHaveAttribute("title", "Vacío · Electronic · Synthpop");
  expect(screen.getByLabelText("Año")).toHaveAttribute("title", "Vacío · 1981");
  expect(screen.getByLabelText("Artista del álbum")).toHaveAttribute("title", "Various Artists · Ensemble");
  expect(screen.getByRole("button", { name: "Escribir en los archivos" })).toBeDisabled();
  expect(batches()).toHaveLength(0);
});

it("always confirms by field and count, even with the single-song preference; cancel keeps drafts", async () => {
  localStorage.setItem("krobi.tags.skipSingleConfirmation", "true"); setup(); await edit();
  const dialog = await preview();
  expect(dialog).toHaveAccessibleName("¿Escribir género en 3 archivos?");
  expect(dialog).toHaveTextContent("Género: Mixto → Synth-pop");
  expect(within(dialog).queryByRole("checkbox")).toBeNull(); expect(batches()).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  expect(screen.getByLabelText("Género")).toHaveValue("Synth-pop"); expect(batches()).toHaveLength(0);
});

it("writes just touched fields once through the batch route, with each revision and one idempotency key", async () => {
  setup(); const headers: string[] = []; const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => { const request = input instanceof Request ? input : new Request(input, init); if (request.method === "POST" && request.url.endsWith("/tags/batch")) headers.push(request.headers.get("idempotency-key") || ""); return fetch(input, init); });
  await save(); expect(await waitFor(() => screen.getByText("Se cambió género en 3 canciones"))).toBeInTheDocument();
  expect(batches().map(request => request.body)).toEqual([{ items: paths.map((relPath, idx) => ({ relPath, rev: views[idx].rev })), set: { genre: "Synth-pop" }, id3Version: 4 }]);
  expect(headers).toHaveLength(1); expect(headers[0]).not.toBe("");
  expect(fake!.requests.some(request => request.method === "PUT" || request.pathname === "/api/update-tags")).toBe(false);
});

it("Use original value removes a touched field, retains Mixed, and preserves untouched arrays", async () => {
  setup(); await edit(); await user.click(screen.getByRole("button", { name: "Usar valor original de género" }));
  expect(screen.getByLabelText("Género")).toHaveValue(""); expect(screen.getByLabelText("Género")).toHaveAttribute("placeholder", "Mixto");
  expect(screen.getByRole("button", { name: "Escribir en los archivos" })).toBeDisabled();
  await edit("Artista", "Changed"); await user.click(screen.getByRole("button", { name: "Usar valor original de artista" }));
  await save(); await waitFor(() => screen.getByText("Se cambió género en 3 canciones"));
  expect((batches()[0].body as { set: unknown }).set).toEqual({ genre: "Synth-pop" });
});

it("sends explicit clearing as null and a typed year, while title is absent", async () => {
  setup(); await edit(); await edit("Género", ""); await edit("Año", "1982");
  await user.click(screen.getByRole("button", { name: "Escribir género, año en 3 archivos" }));
  const dialog = await waitFor(() => screen.getByRole("alertdialog")); expect(dialog).toHaveTextContent("Mixto → Vacío");
  await user.click(within(dialog).getByRole("button", { name: "Escribir género, año en 3 archivos" }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect((batches()[0].body as { set: unknown }).set).toEqual({ genre: null, year: 1982 });
});

it("counts nest conflicts and failures in the toast, Details lists diffs and reasons, and Details retains Undo", async () => {
  const partial = entry("partial"); partial.rows[1] = { ...partial.rows[1], state: "skipped", reason: "changed-since", fields_before: null };
  partial.rows[2] = { ...partial.rows[2], state: "failed", reason: "no-space" };
  setup({ host: true, respond: request => request.pathname === "/api/library/edits/edit-1" ? { status: 200, json: partial } : undefined });
  await save(); expect(await waitFor(() => screen.getByText("Se cambió género en 1 canción · 1 omitidas · 1 fallidas"))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Detalles" }));
  const details = await waitFor(() => screen.getByRole("dialog", { name: "Detalles de la edición" }));
  expect(await waitFor(() => within(details).getByText(paths[0]))).toBeInTheDocument();
  expect(within(details).getByText("Cambió en el nido")).toBeInTheDocument();
  expect(within(details).getByText("No hay espacio para escribir el archivo")).toBeInTheDocument();
  expect(details).toHaveTextContent("Vacío → Synth-pop");
  expect(within(screen.getByRole("list", { name: "Alertas" })).getByRole("button", { name: "Deshacer" })).toBeInTheDocument();
});

it("Undo reverses the one journal, reports a partial undo truthfully, and refreshes the library", async () => {
  const undo = entry("partial"); undo.rows[2].state = "undo-skipped"; undo.rows[2].reason = "changed-since";
  setup({ respond: request => request.pathname === "/api/library/edits/undo-1" ? { status: 200, json: undo } : undefined });
  await save(); await user.click(await waitFor(() => screen.getByRole("button", { name: "Deshacer" })));
  expect(await waitFor(() => screen.getByText("Edición deshecha en 2 canciones · 1 omitidas"))).toBeInTheDocument();
  expect(fake!.requests.filter(request => request.method === "POST" && request.pathname.endsWith("/undo"))).toHaveLength(1);
});

it("does not offer Undo when every row was skipped", async () => {
  const partial = entry("partial"); partial.rows.forEach(row => { row.state = "skipped"; row.reason = "changed-since"; });
  setup({ respond: request => request.pathname === "/api/library/edits/edit-1" ? { status: 200, json: partial } : undefined }); await save();
  expect(await waitFor(() => screen.getByText("Se cambió género en 0 canciones · 3 omitidas"))).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
});

it("keeps drafts on busy and disables writing if any file cannot be read or edited", async () => {
  const first = setup({ respond: request => request.pathname === "/api/library/tags/batch" ? { status: 409, json: { detail: { reason: "busy" } } } : undefined }); await save();
  expect(await waitFor(() => screen.getByRole("alert"))).toHaveTextContent("Ya hay una edición en curso"); expect(screen.getByLabelText("Género")).toHaveValue("Synth-pop"); first.unmount(); fake!.restore();
  setup({ respond: request => decodeURIComponent(request.pathname).endsWith(paths[1]) ? { status: 200, json: { ...views[1], writable: false, reason: "unsupported-format" } } : undefined });
  await waitFor(() => expect(screen.queryByText("Cargando…")).toBeNull()); expect(screen.getByLabelText("Género")).toHaveAttribute("readonly"); expect(batches()).toHaveLength(0);
});

it("has a read Retry and never writes a selection with incomplete snapshots", async () => {
  let fail = true;
  setup({ respond: request => decodeURIComponent(request.pathname).endsWith(paths[1]) && fail ? { status: 500, json: {} } : undefined });
  await waitFor(() => screen.getByRole("button", { name: "Reintentar" })); expect(screen.getByLabelText("Género")).toHaveAttribute("readonly"); fail = false;
  await user.click(screen.getByRole("button", { name: "Reintentar" })); await edit(); expect(batches()).toHaveLength(0);
});

it.each(["menu", "bar"])("opens the shared bulk host from the %s and deduplicates repeated playlist songs", async source => {
  setup({ menu: source === "menu", bar: source === "bar", host: true, selection: [...songs, songs[0]] });
  await user.click(await waitFor(() => screen.getByRole("button", { name: "Editar etiquetas" })));
  expect(await waitFor(() => screen.getByRole("dialog", { name: "Editar 3 canciones" }))).toBeInTheDocument();
});

it("hides bulk actions for members and single songs; disables them offline and above 500 without chunking", async () => {
  const member = setup({ menu: true, member: true }); await waitFor(() => expect(fake!.requests.some(request => request.pathname === "/api/me")).toBe(true)); expect(screen.queryByRole("button", { name: "Editar etiquetas" })).toBeNull(); member.unmount(); fake!.restore();
  const single = setup({ menu: true, selection: [songs[0]] }); expect(screen.queryByRole("button", { name: "Editar etiquetas" })).toBeNull(); single.unmount(); fake!.restore();
  const offline = setup({ menu: true, offline: true }); expect(await waitFor(() => screen.getByRole("button", { name: "Editar etiquetas" }))).toBeDisabled(); offline.unmount(); fake!.restore();
  setup({ menu: true, selection: Array.from({ length: 501 }, (_, idx) => ({ relPath: `Album/${idx}.mp3` })) });
  expect(await waitFor(() => screen.getByRole("button", { name: "Editar etiquetas" }))).toBeDisabled(); expect(screen.getByRole("button", { name: "Editar etiquetas" })).toHaveAttribute("title", "Selecciona hasta 500 canciones"); expect(batches()).toHaveLength(0);
});

it("includes the approved English copy without extraction", () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, "../../../locales/en/translation.json"), "utf8"));
  expect(catalog.Mixed).toBe("Mixed"); expect(catalog["Write {{fields}} to {{count}} files"]).toBe("Write {{fields}} to {{count}} files");
  expect(catalog["Changed {{fields}} of {{count}} songs"]).toBe("Changed {{fields}} of {{count}} songs");
});

it.each(["busy", "network"])("retries %s safely with a new key for refusal and the same key for a lost response", async failure => {
  let attempts = 0;
  setup({ respond: request => request.pathname === "/api/library/tags/batch" && ++attempts === 1 ? failure === "busy" ? { status: 409, json: { detail: { reason: "busy" } } } : { networkError: "Response lost" } : undefined });
  const headers: string[] = []; const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => { const request = input instanceof Request ? input : new Request(input, init); if (request.method === "POST" && request.url.endsWith("/tags/batch")) headers.push(request.headers.get("idempotency-key") || ""); return fetch(input, init); });
  await save(); await waitFor(() => screen.getByRole("alert"));
  const confirmation = await preview(); await user.click(within(confirmation).getByRole("button", { name: "Escribir género en 3 archivos" }));
  await waitFor(() => screen.getByText("Se cambió género en 3 canciones"));
  expect(headers).toHaveLength(2);
  expect(headers[0] === headers[1]).toBe(failure === "network");
});

it("waits for the terminal journal and continues after the sheet closes", async () => {
  let reads = 0;
  setup({ respond: request => request.pathname === "/api/library/edits/edit-1" ? { status: 200, json: entry(++reads === 1 ? "applying" : "applied") } : undefined });
  await save(); await waitFor(() => screen.getByText("Escribiendo género…"));
  expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
  expect(await waitFor(() => screen.getByText("Se cambió género en 3 canciones", {}))).toBeInTheDocument();
});

it("opens the bulk editor for a single song selected by Library health", async () => {
  setup({ selection: [songs[0]] });
  const input = await edit();
  expect(input).toBeEnabled();
  expect(screen.getByRole("dialog", { name: "Editar 1 canción" })).toBeInTheDocument();
});
