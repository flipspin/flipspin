import { useEffect, useMemo, useSyncExternalStore } from "react";
import { bakeLyricsOffset, readLyricsOffset } from "./lrc";
import { saveLyrics, saveLyricsOffset, type LyricsDoc } from "./lyricsStore";
import { SAVE_AFTER_MS } from "./overlayModel";

export interface LyricOffset {
  /** Unsaved correction relative to the document, in seconds (+ sooner). */
  offset: number;
  shown: number;
  saveState: string;
  setShown: (target: number) => void;
  nudge: (delta: number) => void;
  reset: () => void;
  saveShown: (target: number) => Promise<void>;
  bake: () => Promise<void>;
}

interface Entry {
  path: string;
  doc: LyricsDoc | null;
  saved: number;
  snapshot: { shown: number; saveState: string };
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
  baking?: boolean;
}
const entries = new Map<string, Entry>();
function create(path: string, doc: LyricsDoc | null, text?: string): Entry {
  const saved = (doc?.offsetMs ?? readLyricsOffset(doc?.text ?? text)) / 1000;
  return { path, doc, saved, snapshot: { shown: saved, saveState: "idle" }, listeners: new Set() };
}
function publish(entry: Entry, patch: Partial<Entry["snapshot"]>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach(fn => fn());
}
function flush(entry: Entry): Promise<void> {
  clearTimeout(entry.timer);
  if (entry.baking) return entry.saving ?? Promise.resolve();
  if (entry.saving) return entry.saving;
  if (!entry.doc || entry.snapshot.shown === entry.saved) return Promise.resolve();
  entry.saving = (async () => {
    // Serialize writes and use the returned revision for changes made in flight.
    while (entry.doc && entry.snapshot.shown !== entry.saved) {
      const target = entry.snapshot.shown;
      publish(entry, { saveState: "saving" });
      try {
        const saved = await saveLyricsOffset(entry.path, Math.round(target * 1000), entry.doc);
        entry.doc = saved;
        entry.saved = target;
        publish(entry, { saveState: "saved" });
      } catch {
        publish(entry, { saveState: "error" });
        break;
      }
    }
  })().finally(() => { entry.saving = undefined; });
  return entry.saving;
}
export function flushLyricOffsets(): Promise<void> {
  return Promise.all([...entries.values()].map(flush)).then(() => {});
}
function change(entry: Entry, target: number) {
  if (entry.baking) return;
  publish(entry, { shown: Math.max(-600, Math.min(600, Math.round(target * 1000) / 1000)), saveState: entry.saving ? "saving" : "idle" });
  clearTimeout(entry.timer);
  if (entry.doc) entry.timer = setTimeout(() => void flush(entry), SAVE_AFTER_MS);
}

/** One current entry per song; catalog previews have a separate, local entry. */
export function useLyricOffset(relPath: string, doc: LyricsDoc | null, synced: boolean, _localEnabled: boolean, sessionKey = relPath, previewText?: string): LyricOffset {
  const entry = useMemo(() => {
    if (!doc) return create(relPath, null, previewText);
    let current = entries.get(relPath);
    if (!current) { current = create(relPath, doc); entries.set(relPath, current); }
    return current;
    // A current lyric is keyed only by song. Preview choices each start locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath, Boolean(doc), doc ? "current" : sessionKey]);
  const snapshot = useSyncExternalStore(
    fn => { entry.listeners.add(fn); return () => { entry.listeners.delete(fn); }; },
    () => entry.snapshot,
  );
  useEffect(() => {
    if (!doc || doc === entry.doc || entry.saving) return;
    const pending = entry.snapshot.shown !== entry.saved;
    entry.doc = doc;
    entry.saved = (doc.offsetMs ?? readLyricsOffset(doc.text)) / 1000;
    if (!pending) publish(entry, { shown: entry.saved, saveState: "idle" });
  }, [entry, doc]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") void flush(entry); };
    const leave = () => { void flush(entry); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
      void flush(entry);
    };
  }, [entry]);
  return {
    offset: snapshot.shown - entry.saved, shown: snapshot.shown, saveState: snapshot.saveState,
    setShown: target => { if (synced) change(entry, target); },
    nudge: delta => { if (synced) change(entry, entry.snapshot.shown + delta); },
    reset: () => { if (synced) change(entry, 0); },
    saveShown: async target => { if (synced) { change(entry, target); await flush(entry); } },
    bake: async () => {
      if (!synced || !entry.doc || entry.baking) return;
      entry.baking = true;
      clearTimeout(entry.timer);
      try {
        await entry.saving;
        const before = entry.doc;
        const saved = await saveLyrics(entry.path, {
          kind: before.kind, text: bakeLyricsOffset(before.text, Math.round(entry.snapshot.shown * 1000)).text,
          source: before.source, providerRef: before.providerRef, edited: before.edited,
          force: Boolean(before.edited), expectedRevision: before.revision ?? "",
          restore: { fetchedAt: before.fetchedAt, title: before.title, artist: before.artist,
            lineConfidence: before.lineConfidence, lowLines: before.lowLines, result: before.result },
        });
        entry.doc = saved; entry.saved = 0;
        publish(entry, { shown: 0, saveState: "saved" });
      } finally { entry.baking = false; }
    },
  };
}

export function __resetOffsetsForTest() {
  entries.forEach(entry => clearTimeout(entry.timer));
  entries.clear();
}
