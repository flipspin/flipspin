import { installTestClock, clockUser, waitForClock as waitFor } from '../../test/test-clock'
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SongWindow from "./SongWindow";
import { TrackInfoHost } from "./TrackInfoModal";
import { TrackTagsHost } from "./TrackTagsHost";
import { closeTrackInfo, openTrackInfo } from "./trackInfoStore";
import { openTrackTags } from "./trackTagsStore";
import { openSongWindow } from "./songWindowStore";
import { trackFileItems } from "./trackMenuItems";
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from "../../settings/test-support";
import type { SchemaAnalysisView, SchemaTagView } from "../../api/generated/schema";

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined;
afterEach(() => { act(() => closeTrackInfo()); vi.restoreAllMocks(); fake?.restore(); fake = undefined; localStorage.removeItem("krobi.tags.skipSingleConfirmation"); });
const track = { title: "Amber (Remastered)", artist: "Ensemble", album: { album: "Orbit" }, path: "/music/Orbit/04 Amber.flac", relPath: "Orbit/04 Amber.flac", duration: 240 };
const initial = (): SchemaTagView => ({ fields: { title: track.title, artist: track.artist, album: "Orbit", albumArtist: "Ensemble", year: 1979, genre: "Pop", trackNumber: 4, trackTotal: 10, discNumber: 1, discTotal: 2, compilation: false }, format: "FLAC", writable: true, rev: '"rev-1"' });
const analysis: SchemaAnalysisView = { key: { value: "3A", estimated: true, source: "computed" }, bpm: { value: 94, estimated: true, source: "computed" }, computed: { key: "3A", bpm: 94, keyEstimated: true, bpmEstimated: true }, fixed: { key: null, bpm: null }, rev: 1, state: "analyzed", keyConfidence: .7, bpmConfidence: .8, mood: null, energy: null, brightness: null, pulse: null };
function setup({ member = false, writable = true, format = "flac", fields, respond, hosts = false, onMatch }: { member?: boolean; writable?: boolean; format?: string; fields?: SchemaTagView["fields"]; respond?: (request: RecordedRequest) => ResponseSpec | undefined; hosts?: boolean; onMatch?: () => void } = {}) {
  let current = { ...initial(), fields: fields ?? initial().fields, writable, format: format.toUpperCase() };
  let before = current;
  const song = { ...track, path: track.path.replace(/flac$/, format), relPath: track.relPath.replace(/flac$/, format) };
  const revisions: string[] = [];
  fake = installFakeSettings({ respond: request => {
    const response = respond?.(request);
    if (response) return response;
    const path = decodeURIComponent(request.pathname);
    if (path === "/api/me") return { status: 200, json: { role: member ? "member" : "owner", isOwner: !member } };
    if (path === `/api/library/tags/${song.relPath}`) {
      if (request.method === "PUT") {
        before = current;
        const patch = request.body as { set: SchemaTagView["fields"] };
        current = { ...current, fields: { ...current.fields, ...patch.set }, rev: '"rev-2"' };
        return { status: 200, json: { changed: true, editId: "edit-1", rev: current.rev } };
      }
      return { status: 200, json: current };
    }
    if (path.startsWith("/api/analysis/")) return { status: 200, json: analysis };
    if (path === "/api/library/edits/edit-1/undo") { current = { ...before, rev: '"rev-3"' }; return { status: 202, json: { editId: "undo-1" } }; }
    if (path === "/api/library/edits/undo-1") return { status: 200, json: { state: "applied", rows: [{ state: "applied" }] } };
    return { status: 404, json: {} };
  } });
  // Capture real outbound If-Match as well as the fake server's parsed requests.
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && request.url.includes("/library/tags/")) revisions.push(request.headers.get("if-match") || "");
    return fetch(input, init);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = hosts ? <><TrackInfoHost /><TrackTagsHost /></> : <SongWindow open track={song} onClose={() => {}} onMatch={onMatch} />;
  const view = render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return { client, song, revisions, ...view };
}
const puts = () => fake!.requests.filter(request => request.method === "PUT");
async function edit(label = "Título", next = "Amber") {
  const input = await waitFor(() => screen.getByLabelText(label));
  await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
  fireEvent.change(input, { target: { value: next } });
  return input;
}
async function preview() {
  await user.click(screen.getByRole("button", { name: "Escribir en el archivo" }));
  return waitFor(() => screen.getByRole("alertdialog"));
}
async function confirmWrite() {
  const dialog = await preview();
  await user.click(within(dialog).getByRole("button", { name: /^Escribir / }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

it("aliases Info, Edit tags, and review to one opener and renders exactly one host", async () => {
  expect(openTrackInfo).toBe(openSongWindow);
  expect(openTrackTags).toBe(openSongWindow);
  const { song } = setup({ hosts: true });
  act(() => openTrackInfo(song));
  expect(await waitFor(() => screen.getByRole("dialog", { name: "Canción" }))).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue(track.title));
  const dialog = screen.getByRole("dialog");
  await user.click(screen.getByRole("button", { name: "Editar etiquetas" }));
  expect(screen.getByLabelText("Título")).toHaveFocus();
  expect(screen.getByRole("dialog")).toBe(dialog);
  const item = trackFileItems({ track: song, count: 1 }).find(item => "label" in item && item.label === "Editar etiquetas");
  act(() => { if (item && "onClick" in item) item.onClick?.(); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(puts()).toHaveLength(0);
  const app = readFileSync(resolve(__dirname, "../../shell/App.tsx"), "utf8");
  expect(app).toMatch(/openEstimateTags:[\s\S]*?openTrackTags\(track\)/);
});

it.each(["mp3", "flac", "ogg", "m4a"])("reads and edits %s through tag routes with one named confirmation, revision and sticky Undo", async format => {
  const { revisions, song } = setup({ format });
  await edit(); await edit("Género", "Synth-pop");
  expect(screen.getByText("2 cambios")).toBeInTheDocument();
  expect(screen.getByLabelText("Título").closest(".song-field")).toHaveClass("song-field--changed");
  expect(screen.getByRole("button", { name: "Usar valor original de título" })).toBeInTheDocument();
  expect(puts()).toHaveLength(0);
  const dialog = await preview();
  expect(dialog).toHaveAccessibleName("¿Escribir título, género en 1 archivo?");
  expect(dialog).toHaveTextContent("Amber (Remastered) → Amber");
  await user.click(within(dialog).getByRole("button", { name: "Escribir título, género" }));
  await waitFor(() => expect(puts().map(request => [decodeURIComponent(request.pathname), request.body])).toEqual([[`/api/library/tags/${song.relPath}`, { set: { title: "Amber", genre: "Synth-pop" }, id3Version: 4 }]]));
  expect(revisions).toEqual(['"rev-1"']);
  expect(await waitFor(() => screen.getByText("Se escribió título, género en 1 archivo"))).toBeInTheDocument();
  expect(screen.getByText("0 cambios")).toBeInTheDocument();
  vi.useFakeTimers(); await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(screen.getByRole("button", { name: "Deshacer" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Deshacer" }));
  expect(await waitFor(() => screen.getByText("Edición deshecha"))).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue(track.title));
  expect(fake!.requests.some(request => request.pathname === "/api/library/edits/edit-1/undo")).toBe(true);
  expect(fake!.requests.some(request => request.pathname === "/api/update-tags")).toBe(false);
});

it("restores original values, clears frames with null, and preserves typed pairs and compilation", async () => {
  setup();
  await edit();
  await user.click(screen.getByRole("button", { name: "Usar valor original de título" }));
  expect(screen.getByLabelText("Título")).toHaveValue(track.title);
  expect(screen.getByText("0 cambios")).toBeInTheDocument();
  await edit("Artista del álbum", ""); await edit("Nº canción", "5"); await edit("Total de canciones", "11");
  await edit("Nº disco", "2"); await edit("Total de discos", "3"); await edit("Año", "1980");
  fireEvent.change(screen.getByLabelText("Compilación"), { target: { value: "true" } });
  const confirmation = await preview();
  expect(confirmation).toHaveTextContent("Compilación: No → Sí");
  await user.click(within(confirmation).getByRole("button", { name: /^Escribir / }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].body).toEqual({ set: { albumArtist: null, trackNumber: 5, trackTotal: 11, discNumber: 2, discTotal: 3, year: 1980, compilation: true }, id3Version: 4 });
});

it("cancels the confirmation without writing or recording the device preference", async () => {
  setup(); await edit(); const dialog = await preview();
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  expect(puts()).toHaveLength(0);
  expect(localStorage.getItem("krobi.tags.skipSingleConfirmation")).toBeNull();
  expect(screen.getByLabelText("Título")).toHaveValue("Amber");
});

it("remembers single-song confirmation on this device only after a successful write", async () => {
  const first = setup(); await edit(); const dialog = await preview();
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(within(dialog).getByRole("button", { name: "Escribir título" }));
  await waitFor(() => screen.getByText("Se escribió título en 1 archivo"));
  expect(localStorage.getItem("krobi.tags.skipSingleConfirmation")).toBe("true");
  first.unmount(); fake!.restore();
  setup(); await edit();
  await user.click(screen.getByRole("button", { name: "Escribir en el archivo" }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("reloads a 409 field with the new nest value and keeps unrelated unsaved changes", async () => {
  const conflict = { ...initial(), fields: { ...initial().fields, title: "Nest title" }, rev: '"rev-9"' };
  setup({ respond: request => request.method === "PUT" ? { status: 409, json: { detail: { reason: "changed-since", current: conflict } } } : undefined });
  await edit(); await edit("Género", "Synth-pop"); await confirmWrite();
  expect(await waitFor(() => screen.getByRole("alert"))).toHaveTextContent("El valor cambió en el nido");
  expect(screen.getByLabelText("Título")).toHaveValue("Nest title");
  expect(screen.getByLabelText("Género")).toHaveValue("Synth-pop");
  expect(screen.getByText("1 cambio")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
});

it.each(["no-space", "write-failed", "hardlinked"])("keeps drafts after %s and does not offer Undo", async reason => {
  setup({ respond: request => request.method === "PUT" ? { status: reason === "no-space" ? 507 : reason === "hardlinked" ? 409 : 500, json: { detail: { reason } } } : undefined });
  await edit(); await confirmWrite();
  expect(await waitFor(() => screen.getByRole("alert"))).toBeInTheDocument();
  expect(screen.getByLabelText("Título")).toHaveValue("Amber");
  expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
});

it("reports an asynchronously refused Undo without claiming success", async () => {
  setup({ respond: request => request.pathname === "/api/library/edits/undo-1" ? { status: 200, json: { state: "partial", rows: [{ state: "undo-skipped", reason: "changed-since" }] } } : undefined });
  await edit(); await confirmWrite(); await user.click(await waitFor(() => screen.getByRole("button", { name: "Deshacer" })));
  expect(await waitFor(() => screen.getByText("El archivo cambió en el nido. No se deshizo la edición."))).toBeInTheDocument();
  expect(screen.queryByText("Edición deshecha")).toBeNull();
});

it("gives members the same field values and analysis with no write controls", async () => {
  setup({ member: true });
  await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue(track.title));
  expect(screen.getByLabelText("Título")).toHaveAttribute("readonly");
  expect(screen.getByLabelText("Compilación")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Editar etiquetas" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Escribir en el archivo" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Confirmar|Duplicar|Reducir/ })).toBeNull();
  expect(puts()).toHaveLength(0);
});

it("honors a read-only file, exposes Retry for a failed read, and never enables writing from the listing", async () => {
  const view = setup({ writable: false });
  await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue(track.title));
  expect(screen.getByLabelText("Título")).toHaveAttribute("readonly");
  expect(await waitFor(() => screen.getByRole("button", { name: "Escribir en el archivo" }))).toBeDisabled();
  view.unmount(); fake!.restore();
  setup({ respond: request => request.pathname.includes("/library/tags/") ? { status: 500, json: {} } : undefined });
  expect(await waitFor(() => screen.getByRole("button", { name: "Reintentar" }))).toBeInTheDocument();
  expect(screen.getByLabelText("Título")).toHaveAttribute("readonly");
});

it("keeps provenance, confidence, Key/BPM controls, and optional Match in the shared window", async () => {
  const match = vi.fn(); const { song } = setup({ onMatch: match });
  await waitFor(() => screen.getByRole("button", { name: "Confirmar 94" }));
  expect(screen.getByRole("button", { name: "Duplicar BPM a 188" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Reducir BPM a la mitad: 47" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^Confirmar tono 3A/ })).toBeEnabled();
  expect(screen.getAllByText(/c = 0.700|p = 0.80/)).toHaveLength(2);
  expect(screen.getAllByRole("img", { name: "Etiqueta del archivo" })).toHaveLength(11);
  await user.click(screen.getByRole("button", { name: "Buscar coincidencia…" }));
  expect(match).toHaveBeenCalledWith(song);
  expect(puts()).toHaveLength(0);
});

it("hides Match when its callback is absent and includes English copy by hand", () => {
  setup(); expect(screen.queryByRole("button", { name: "Match…" })).toBeNull();
  const catalog = JSON.parse(readFileSync(resolve(__dirname, "../../../locales/en/translation.json"), "utf8"));
  expect(catalog["Write to file"]).toBe("Write to file");
  expect(catalog["Write {{fields}} to 1 file?"]).toBe("Write {{fields}} to 1 file?");
  expect(catalog["Match…"]).toBe("Match…");
});


it("preserves untouched whitespace and multivalue tags and restores their exact original values", async () => {
  const fields = { ...initial().fields, artist: "  Ensemble  ", genre: ["Pop", " Funk "] };
  setup({ fields });
  await waitFor(() => expect(screen.getByLabelText("Título")).not.toHaveAttribute("readonly"));
  expect(screen.getByText("0 cambios")).toBeInTheDocument();
  await edit("Artista", "Revised artist");
  await user.click(screen.getByRole("button", { name: "Usar valor original de artista" }));
  expect(screen.getByLabelText("Artista")).toHaveValue(fields.artist);
  expect(screen.getByText("0 cambios")).toBeInTheDocument();
  await edit(); await confirmWrite();
  expect(puts()[0].body).toEqual({ set: { title: "Amber" }, id3Version: 4 });
  expect(screen.getByLabelText("Artista")).toHaveValue(fields.artist);
  expect(screen.getByLabelText("Género")).toHaveValue("Pop;  Funk ");
});
