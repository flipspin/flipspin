import { deliverChanges } from '../data/changeListeners'
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client";
import schema from "../../api-schema.json";
import i18n from "../i18n";
import DownloadsMenu from "./DownloadsMenu";
import {
  closeRetry, getState, reconcile, report, resetForIdentityChange, startReconciling,
  stopReconciling, track, type JobView,
} from "./downloadsStore";

vi.mock("../data/backend", async (original) => ({
  ...await original<typeof import("../data/backend")>(),
  getApiClient: () => Promise.resolve(createApiClient("http://jobs.test")),
}));

function row(id: string, overrides: Partial<JobView> = {}): JobView {
  return { id, label: id, kind: "download", state: "running", total: 12, succeeded: 3,
    failed: 0, skipped: 0, percent: 25, phase: "downloading", item: "Crescendolls",
    waitingOn: null, startedAt: 100, endedAt: null, attempt: 1, failedCount: 0,
    canCancel: true, canRetry: false, ...overrides };
}
const terminal = { state: "succeeded", canCancel: false, percent: 100 } as const;
const failure = { ...terminal, state: "partial", failedCount: 2, failed: 2, canRetry: true } as const;
const waiting = { state: "waiting", waitingOn: { name: "big_chip", state: "asleep" } } as const;
let rows: JobView[];
let degraded: string[];
let requests: Request[];
let unchanged: boolean;
let refuse: boolean;
const failures = [{ idx: 4, attempt: 1, item: "Gosh", rel_path: null, state: "failed", reason: "no-results",
  detail: { title: "Gosh", artist: "Jamie xx", query: "Gosh Jamie xx", durationS: 293,
    kind: "no-results", suggestions: ["Gosh Jamie xx", "Gosh"], retriedAs: null } }];

beforeEach(async () => {
  rows = []; requests = []; degraded = []; unchanged = false; refuse = false;
  vi.stubGlobal("fetch", vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const input = resource instanceof Request ? resource : new Request(new URL(String(resource), "http://jobs.test"), init);
    requests.push(input);
    const url = new URL(input.url);
    if (url.pathname === "/api/acquisition/requests") return Response.json({ requests: [] });
    if (refuse) return Response.json({ detail: "not-cancellable" }, { status: 409 });
    if (url.pathname === "/api/jobs" && input.method === "GET") {
      return unchanged ? new Response(null, { status: 304 })
        : Response.json({ jobs: rows, degraded }, { headers: { ETag: '"v1"' } });
    }
    if (url.pathname.endsWith("/items")) return Response.json({ items: failures });
    if (url.pathname === "/api/jobs/clear") rows = rows.filter((job) => job.canCancel);
    else if (url.pathname.endsWith("/clear")) rows = rows.filter((job) => job.id !== url.pathname.split("/").at(-2));
    return Response.json({ id: "job", attempt: 2, cleared: 1 });
  }));
  resetForIdentityChange();
  await reconcile();
  requests = [];
});
afterEach(() => {
  stopReconciling(); closeRetry(); vi.useRealTimers(); vi.unstubAllGlobals();
  void i18n.changeLanguage("es");
});
async function show(jobs: JobView[]) {
  rows = jobs;
  await act(() => reconcile());
  render(<DownloadsMenu />);
}

it.each([
  { name: "idle", rows: [], label: "Trabajos · Nada en curso", ring: false, tone: null, count: 0 },
  { name: "running", rows: [row("dl")], label: "Trabajos · 1 en curso", ring: true, tone: null, count: 0 },
  { name: "waiting", rows: [row("le", waiting)], label: "Trabajos · 1 esperando ayuda", ring: false, tone: "waiting", count: 1 },
  { name: "failed", rows: [row("dl", failure)], label: "Trabajos · 1 con fallos", ring: false, tone: "failed", count: 1 },
  { name: "worst wins", rows: [row("run"), row("wait", waiting), row("fail", failure)], label: "Trabajos · 1 con fallos · 1 esperando ayuda · 1 en curso", ring: true, tone: "failed", count: 1 },
  { name: "queued without helper", rows: [row("queue", { state: "queued" })], label: "Trabajos · 1 en cola", ring: false, tone: null, count: 0 },
  { name: "finished", rows: [row("done", terminal)], label: "Trabajos · Nada en curso", ring: false, tone: null, count: 0 },
])("$name button has the right state and accessible label", async ({ rows, label, ring, tone, count }) => {
  await show(rows);
  expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  expect(!!screen.queryByTestId("jobs-ring")).toBe(ring);
  if (tone) {
    expect(screen.getByTestId("jobs-count")).toHaveAttribute("data-tone", tone);
    expect(screen.getByTestId("jobs-count")).toHaveTextContent(String(count));
  } else expect(screen.queryByTestId("jobs-count")).toBeNull();
});

it("opens an empty panel and closes with Escape, restoring focus", async () => {
  const user = userEvent.setup(); await show([]);
  const trigger = screen.getByRole("button", { name: /Trabajos/ });
  expect(trigger).toHaveClass("topbar-control", "topbar-control--jobs");
  expect(trigger).not.toHaveClass("border-2", "shadow-[var(--shadow-pop-sm)]");
  await user.click(trigger);
  const panel = screen.getByRole("dialog", { name: "Trabajos" });
  expect(panel).toHaveTextContent("Nada en curso");
  expect(panel).toHaveClass("w-[380px]", "border-2", "border-black", "shadow-[var(--shadow-pop)]");
  expect(panel.querySelector('svg')?.parentElement).toHaveClass("border-2", "border-black");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
});

it("keeps server order, kind tiles, words, section counts, progress and permitted actions", async () => {
  const user = userEvent.setup();
  await show([
    row("import-first", { kind: "import", phase: null }),
    row("download-second"), row("lyrics-third", { kind: "lyrics-search", phase: null, canCancel: false }),
    row("helper-fourth", { kind: "lyrics-helper", ...waiting }),
    row("stems-fifth", { kind: "stems", state: "queued" }),
    row("scan-sixth", { kind: "scan", ...terminal }),
    row("interrupted-seventh", { ...terminal, state: "interrupted", canRetry: true }),
    row("failed-eighth", failure),
  ]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  expect(screen.getAllByRole("article").map((el) => el.getAttribute("aria-label"))).toEqual(rows.map((job) => job.label));
  for (const [id, tile, tooltip, word, action] of [
    ["import-first", "IM", "Importación", "Importando", "Cancelar"],
    ["download-second", "DL", "Descarga", "Descargando", "Cancelar"],
    ["lyrics-third", "LE", "Letras", "Buscando letras", null],
    ["helper-fourth", "LE", "Letras", "Esperando a big_chip", "Cancelar"],
    ["stems-fifth", "SP", "Separar canciones", "Esperando un ayudante", "Cancelar"],
    ["scan-sixth", "BI", "Revisar biblioteca", "Listo", null],
    ["interrupted-seventh", "DL", "Descarga", "Interrumpido", "Reintentar"],
    ["failed-eighth", "DL", "Descarga", "2 de 12 fallaron", "Ver 2"],
  ]) {
    const scope = within(screen.getByRole("article", { name: id! }));
    expect(scope.getByTitle(tooltip!)).toHaveTextContent(tile!);
    expect(scope.getByText(word!)).toBeInTheDocument();
    const finished = ["succeeded", "partial", "interrupted"].includes(rows.find(row => row.id === id)!.state);
    expect(scope.queryAllByRole("button")).toHaveLength((action ? 1 : 0) + (finished ? 1 : 0));
    if (action) expect(scope.getByRole("button", { name: action })).toBeInTheDocument();
  }
  expect(screen.getByText("dormida", { exact: false })).toBeInTheDocument();
  expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "25");
  expect(screen.getByText("En curso").parentElement).toHaveTextContent("3");
  expect(screen.getByText("En espera").parentElement).toHaveTextContent("2");
  expect(screen.getByText("Terminados").parentElement).toHaveTextContent("3");
});

// Read the wire enum, so additions cannot silently escape the rendering test.
it.each(schema.components.schemas.JobView.properties.kind.enum)("renders server kind %s with its running fallback", async kind => {
  const user = userEvent.setup();
  await show([row(kind, { kind: kind as JobView["kind"], phase: null })]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  const article = within(screen.getByRole("article", { name: kind }));
  expect(article.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  expect(article.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  expect(article.queryByTitle("Trabajo")).toBeNull();
});

it.each(["future-plugin", "toString", "__proto__"])("renders a safe default for unknown kind %s", async kind => {
  const user = userEvent.setup();
  await show([row("future", { kind: kind as JobView["kind"], phase: null })]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  const article = within(screen.getByRole("article", { name: "future" }));
  expect(article.getByTitle("Trabajo")).toHaveTextContent("TR");
  expect(article.getByText("Procesando")).toBeInTheDocument();
  expect(article.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  expect(article.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
});

it.each(["analysis", "lyrics-helper", "stems", "future-plugin"])("shows progress, helper names and unnamed waiting for %s", async kind => {
  await i18n.changeLanguage("en");
  const user = userEvent.setup();
  await show([row("work", { kind: kind as JobView["kind"], ...waiting, failed: 1, skipped: 2 })]);
  await user.click(screen.getByRole("button", { name: /Jobs/ }));
  const article = within(screen.getByRole("article", { name: "work" }));
  expect(article.getByText(/ · 6 of 12 songs$/)).toBeInTheDocument();
  if (kind === "analysis") expect(article.getByText("Analysis · 6 of 12 songs")).toBeInTheDocument();
  expect(article.getByText("Waiting for big_chip")).toBeInTheDocument();
  // Unknown plugin kinds still use the helper information supplied on the wire.
  if (kind === "future-plugin") return;
  rows = [row("work", { kind: kind as JobView["kind"], state: "queued", phase: null })];
  await act(() => reconcile());
  expect(article.getByText("Waiting for a helper")).toBeInTheDocument();
  expect(screen.getByTestId("jobs-count")).toHaveAttribute("data-tone", "waiting");
  rows = [row("work", { kind: kind as JobView["kind"], state: "waiting", phase: null })];
  await act(() => reconcile());
  expect(article.getByText("Waiting for a helper")).toBeInTheDocument();
});

it("loads failed items only behind Ver N and opens today's alternate search sheet", async () => {
  const user = userEvent.setup(); await show([row("failed", failure)]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  expect(requests.some((req) => req.url.includes("/items"))).toBe(false);
  expect(screen.queryByText("Gosh")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Ver 2" }));
  await screen.findByRole("list", { name: "Canciones que fallaron" });
  expect(requests.find((req) => req.url.includes("/items"))?.url).toBe("http://jobs.test/api/jobs/failed/items?state=failed");
  await user.click(screen.getByRole("button", { name: "Buscar de otra forma" }));
  expect(await screen.findByRole("dialog", { name: "Buscar de otra forma" })).toBeInTheDocument();
  expect(screen.getByText(/YouTube no devolvió ningún resultado para «Gosh Jamie xx»/)).toBeInTheDocument();
  expect(requests.some((req) => req.method === "POST")).toBe(false);
});

it("cancels, retries with the row's attempt, and clears terminal jobs through the ledger routes", async () => {
  const user = userEvent.setup();
  await show([row("running"), row("interrupted", { ...terminal, state: "interrupted", canRetry: true, attempt: 4 })]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  await user.click(screen.getByRole("button", { name: "Cancelar" }));
  await waitFor(() => expect(requests.some((req) => new URL(req.url).pathname === "/api/jobs/running/cancel")).toBe(true));
  await user.dblClick(screen.getByRole("button", { name: "Reintentar" }));
  const retries = requests.filter((req) => req.url.endsWith("/retry"));
  expect(retries.length).toBeGreaterThan(0);
  for (const retry of retries) {
    expect(retry.method).toBe("POST");
    expect(retry.url).toBe("http://jobs.test/api/jobs/interrupted/retry");
    expect(await retry.clone().json()).toEqual({ attempt: 4 });
  }
  await user.click(screen.getByRole("button", { name: "Limpiar" }));
  await waitFor(() => expect(screen.queryByRole("article", { name: "interrupted" })).toBeNull());
  expect(requests.find((req) => req.url.endsWith("/clear"))?.method).toBe("POST");
  expect(requests.some((req) => req.url.endsWith("/api/acquisition/requests/clear"))).toBe(false);
});

it("retains failures on refused actions and displays the error", async () => {
  const user = userEvent.setup(); await show([row("running")]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  refuse = true;
  await user.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo completar la acción");
  expect(screen.getByRole("article", { name: "running" })).toBeInTheDocument();
});

it("keeps the snapshot on 304 and sends If-None-Match", async () => {
  rows = [row("server-job")]; await reconcile();
  const previous = getState(); unchanged = true; await reconcile();
  expect(getState()).toBe(previous);
  expect(requests.at(-1)?.headers.get("If-None-Match")).toBe('"v1"');
});

it("shows precisely the jobs returned for a member, including jobs started elsewhere", async () => {
  await show([row("other-device"), row("helper", waiting), row("old-success", { ...terminal, endedAt: 1 })]);
  expect(getState().jobs.map((job) => job.id)).toEqual(rows.map((job) => job.id));
  rows = [row("member-visible")]; await act(() => reconcile());
  expect(getState().jobs.map((job) => job.id)).toEqual(["member-visible"]);
  resetForIdentityChange(); await act(() => reconcile());
  expect(requests.at(-1)?.headers.has("If-None-Match")).toBe(false);
});

it("uses job nudges without idle timers and retains rows until the server removes them", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  rows = [row("job")]; startReconciling(); await reconcile();
  requests = []; await vi.advanceTimersByTimeAsync(120_000); expect(requests).toHaveLength(0);
  rows = [row("success", { ...terminal, endedAt: 1 })];
  deliverChanges(new Set(['jobs'])); await vi.advanceTimersByTimeAsync(0);
  expect(getState().jobs[0].id).toBe("success");
  requests = []; await vi.advanceTimersByTimeAsync(120_000); expect(requests).toHaveLength(0);
  expect(getState().jobs[0].id).toBe("success");
  rows = []; deliverChanges(new Set(['jobs'])); await vi.advanceTimersByTimeAsync(0);
  expect(getState().jobs).toEqual([]);
});

it("keeps acquisition/import entry points and self-streamed percent working", async () => {
  track({ id: "new-acquisition", label: "Album", source: "YT", selfStreamed: true });
  rows = [row("new-acquisition", { label: "Server album", kind: "import" })]; await reconcile();
  report("new-acquisition", { active: { Song: { phase: "downloading", percent: 73 } } });
  expect(getState().jobs[0]).toMatchObject({ kind: "import", label: "Server album", percent: 73, item: "Song" });
});

it("reports degraded sources without hiding the available jobs", async () => {
  degraded = ["stems"]; const user = userEvent.setup(); await show([row("available")]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Separar canciones");
  expect(screen.getByRole("article", { name: "available" })).toBeInTheDocument();
});

it("retries a failed helper batch from its expanded detail using its current attempt", async () => {
  const user = userEvent.setup();
  await show([row("lyrics-failure", { ...failure, kind: "lyrics-helper", attempt: 3 })]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  await user.click(screen.getByRole("button", { name: "Ver 2" }));
  expect(await screen.findByRole("list", { name: "Canciones que fallaron" })).toHaveTextContent("Gosh");
  expect(screen.queryByRole("button", { name: "Buscar de otra forma" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Reintentar" }));
  const request = requests.find((req) => req.url.endsWith("/retry"));
  expect(request?.url).toBe("http://jobs.test/api/jobs/lyrics-failure/retry");
  expect(await request!.clone().json()).toEqual({ attempt: 3 });
});

it("discards an old identity's delayed response and self-owned SSE messages", async () => {
  let finishOld!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }));
  const old = reconcile();
  await waitFor(() => expect(finishOld).toBeTypeOf("function"));
  rows = [row("member-only")];
  resetForIdentityChange(); await reconcile();
  finishOld(Response.json({ jobs: [row("foreign")], degraded: [] }, { headers: { ETag: '"foreign"' } }));
  await old;
  report("foreign", { active: { Private: { percent: 50 } } });
  expect(getState().jobs.map((job) => job.id)).toEqual(["member-only"]);
  await reconcile();
  expect(requests.at(-1)?.headers.get("If-None-Match")).toBe('"v1"');
});

it("adopts only running SSE streams, recovers after a drop on 304, and closes on completion", async () => {
  const sources: FakeSource[] = [];
  class FakeSource {
    close = vi.fn();
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { sources.push(this); }
  }
  vi.stubGlobal("EventSource", FakeSource);
  rows = [row("running"), row("waiting", waiting), row("finished", terminal)];
  await reconcile();
  expect(sources).toHaveLength(1);
  expect(sources[0].url).toContain("/api/download-progress-stream/running");
  sources[0].onmessage?.({ data: JSON.stringify({ active: { Song: { phase: "downloading", percent: 68 } } }) });
  expect(getState().jobs[0]).toMatchObject({ percent: 68, item: "Song", state: "running" });
  sources[0].onerror?.();
  unchanged = true; await reconcile();
  expect(sources[0].close).toHaveBeenCalled();
  expect(sources).toHaveLength(2);
  unchanged = false; rows = [row("running", terminal)]; await reconcile();
  expect(sources[1].close).toHaveBeenCalled();
  sources[1].onmessage?.({ data: JSON.stringify({ active: { Stale: { percent: 1 } } }) });
  expect(getState().jobs[0]).toMatchObject({ state: "succeeded", percent: 100 });
});


it("labels matching as reviewed matches and preserves old import rows", async () => {
  const user = userEvent.setup();
  await show([
    row("matching", { kind: "match", phase: "resolving" }),
    row("matched", { ...terminal, kind: "match", succeeded: 12 }),
    row("old-import", { ...terminal, kind: "import", succeeded: 12 }),
    row("stopped-match", { ...terminal, state: "cancelled", kind: "match", succeeded: 2, skipped: 10 }),
  ]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  const active = within(screen.getByRole("article", { name: "matching" }));
  expect(active.getByTitle("Coincidencias")).toHaveTextContent("CO");
  expect(active.getByText("Buscando coincidencias")).toBeInTheDocument();
  const matched = within(screen.getByRole("article", { name: "matched" }));
  expect(matched.getByText("Revisión terminada")).toBeInTheDocument();
  expect(matched.getByTitle("12 coincidencias revisadas")).toBeInTheDocument();
  expect(matched.queryByTitle("12 canciones")).toBeNull();
  const stopped = within(screen.getByRole("article", { name: "stopped-match" }));
  expect(stopped.getByText("Cancelado")).toBeInTheDocument();
  expect(stopped.queryByTitle("12 coincidencias revisadas")).toBeNull();
  expect(within(screen.getByRole("article", { name: "old-import" })).getByTitle("12 canciones")).toBeInTheDocument();
});

it("clears one finished row with a keyboard reachable button and keeps the others", async () => {
  const user = userEvent.setup();
  await show([row("first", terminal), row("second", terminal), row("live")]);
  await user.click(screen.getByRole("button", { name: /Trabajos/ }));
  const clear = within(screen.getByRole("article", { name: "first" })).getByRole("button", { name: "Quitar de la lista" });
  expect(clear).toHaveAttribute("title", "Quitar de la lista");
  clear.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("article", { name: "first" })).toBeNull());
  expect(requests.find(req => req.url.endsWith("/api/jobs/first/clear"))?.method).toBe("POST");
  expect(screen.getByRole("article", { name: "second" })).toBeInTheDocument();
  expect(screen.getByRole("article", { name: "live" })).toBeInTheDocument();
  expect(within(screen.getByRole("article", { name: "live" })).queryByRole("button", { name: "Quitar de la lista" })).toBeNull();
});
