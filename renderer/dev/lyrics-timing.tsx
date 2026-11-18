/** Review harness: real renderer components, synthetic network only. Never contacts a nest. */
import React from "react";
import { setFakeBridgeForTest } from "../src/bridge";
import { startSync } from "../src/lyrics/syncRunStore";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "../src/index.css";
import "../src/i18n";
import { AudioPlayerProvider } from "../src/state/AudioPlayerContext";
import LyricsOverlay from "../src/lyrics/LyricsOverlay";
import LyricsModal from "../src/lyrics/LyricsModal";
import { closeLyricsModal, openLyrics, openLyricsModal, useLyricsModalRelPath } from "../src/lyrics/lyricsStore";

const scenario = new URLSearchParams(location.search).get("state") || "empty";
const path = "Fixture/La ventana.mp3";
const words = "La luz se queda en la ventana\nLa calle empieza a despertar\nGuardo una nota en el bolsillo\nY salgo lento a caminar";
const lrc = words.split("\n").map((line, i) => `[00:${String(i * 8 + 4).padStart(2, "0")}.00]${line}`).join("\n");
let doc = ["empty", "search"].includes(scenario) ? null : {
  relPath: path, kind: ["aligned", "catalog", "manual"].includes(scenario) ? "synced" : "plain",
  text: ["aligned", "catalog", "manual"].includes(scenario) ? lrc : words,
  source: scenario === "aligned" ? "aligned:mms-fa" : scenario === "catalog" ? "lrclib" : "manual",
  edited: scenario === "manual", lowLines: scenario === "aligned" ? [1, 3] : [],
};
const engine = {
  ready: !["missing", "offline", "installing"].includes(scenario), mode: "agent", supported: false,
  installed: false, version: null, hint: scenario === "offline" ? "agent-needed" : "agent-online",
  queue: { online: scenario !== "offline", queued: 0, leased: 0, agents: scenario === "offline" ? [] : [{ name: "Mac", platform: "darwin", version: scenario === "outdated" ? "0.4.0" : "0.5.0", busy: false, lastSeenAt: Date.now() / 1000 }] },
};
if (scenario === "missing" || scenario === "installing") Object.assign(engine, { mode: "local", supported: true, hint: scenario === "missing" ? "not-installed" : "installing", installing: scenario === "installing" ? { phase: "modelos", percent: 35 } : null });
// Intercept every request, including unexpected ones: no real library mutations.
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  let body: unknown = {};
  let status = 200;
  if (url.pathname === "/api/lyrics/jobs") body = { engine, pending: [], pendingCount: 0, providers: ["lrclib"] };
  else if (url.pathname === "/api/lyrics/transcribe") body = { progressId: "fixture-run", total: 1 };
  else if (url.pathname.startsWith("/api/download-progress/")) body = { terminal: false, active: { song: { phase: "alineando", percent: 42 } } };
  else if (url.pathname === "/api/lyrics/search") body = { query: {}, providers: ["lrclib"], candidates: [{ provider: "lrclib", providerRef: "fixture:1", title: "La ventana", artist: "Sesión de prueba", durationSeconds: 180, durationDeltaSeconds: 0, withinTolerance: true, kind: "synced", preview: [words.split("\n")[0]], text: lrc }] };
  else if (url.pathname.startsWith("/api/lyrics/Fixture/")) {
    if (req.method === "PUT") doc = { ...doc, ...await req.json() };
    body = doc ?? { detail: "not found" }; status = doc ? 200 : 404;
  }
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};
localStorage.setItem("playerNowPlaying", JSON.stringify({ path, title: "La ventana", artist: "Sesión de prueba", album: "Fixture" }));
localStorage.setItem("krobi.lyricsBackdrop", "solid");
function Harness() {
  const modal = useLyricsModalRelPath();
  return <AudioPlayerProvider><LyricsOverlay onOpenModal={openLyricsModal} /><LyricsModal open={Boolean(modal)} relPath={modal} track={{ title: "La ventana", artist: "Sesión de prueba" }} onClose={closeLyricsModal} /></AudioPlayerProvider>;
}
setFakeBridgeForTest({
  invoke: (async (channel: string) => {
    if (channel === "log:write") return;
    if (channel === "app:get-backend-origin") return { origin: "http://lyrics-fixture.test" };
    if (channel === "auth:get") return { hasToken: false, userId: null, label: null, role: null };
    if (channel === "server:get-status") return { instanceId: "lyrics-fixture" };
    if (channel === "lyrics:engine-status") return {
      enabled: false, eligible: false, tray: true, workerId: null,
      hardware: { name: "", chip: "", memoryBytes: null },
      version: null, sizeBytes: null, local: null, worker: null, workerError: null,
      supported: false, installed: false, agentRunning: false,
      installing: null, installError: null, uv: false, workerSource: null,
      toolsDir: "", modelsDir: "",
    };
    throw new Error(`Unexpected harness command: ${channel}`);
  }) as never,
  on: () => () => {},
});
createRoot(document.getElementById("root")!).render(<Harness />);
openLyrics(path);
if (scenario === "running") void startSync(path, words);
if (scenario === "search") openLyricsModal(path);
