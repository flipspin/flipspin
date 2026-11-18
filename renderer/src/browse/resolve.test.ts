import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("../ui", () => ({ confirmAction: mocks.confirmAction }));

import { confirmReplace, foldTitle, moveTrack, ownedElsewhere, replacementLanded, rowControl } from "./resolve";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mocks.confirmAction.mockClear();
});

function answer(status: number, json: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("foldTitle", () => {
  it("folds case, accents and a bracketed tail", () => {
    expect(foldTitle("Tête Brûlée (Deluxe Edition)")).toBe("tete brulee");
    expect(foldTitle("Discovery [Remastered]")).toBe(foldTitle("discovery"));
    expect(foldTitle(null)).toBe("");
  });
});

describe("ownedElsewhere", () => {
  const verdict = (album: string, path: string) => ({ owned: true, match: { title: "One More Time", album, path } });

  it("names the file when it is tagged and filed under another album", () => {
    const v = verdict("One More Time (Single)", "/music/One_More_Time/01.mp3");
    expect(ownedElsewhere(v, "Discovery")).toBe(v.match);
  });

  it("is null when the tag or the folder is already this album", () => {
    expect(ownedElsewhere(verdict("Discovery (Deluxe)", "/music/Single/01.mp3"), "Discovery")).toBeNull();
    // A moved FLAC keeps its single's tag; its folder now says where it is.
    expect(ownedElsewhere(verdict("One More Time", "/music/Discovery/01.flac"), "Discovery")).toBeNull();
  });

  it("is null for a song that is not owned, or a page with no album", () => {
    expect(ownedElsewhere({ owned: false, nearMatch: { path: "/music/x/1.mp3" } }, "Discovery")).toBeNull();
    expect(ownedElsewhere(verdict("Single", "/music/Single/01.mp3"), "")).toBeNull();
  });
});

describe("moveTrack", () => {
  it("posts the path, the target and the track number", async () => {
    const fetchMock = answer(200, { success: true, path: "/music/Discovery/01.mp3" });
    await expect(moveTrack({ path: "/music/Single/01.mp3", albumDir: "Discovery", albumTitle: "Discovery", trackNumber: 1 })).resolves.toEqual({
      success: true,
      path: "/music/Discovery/01.mp3",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/library\/move-track$/);
    expect(JSON.parse(String(init.body))).toEqual({ path: "/music/Single/01.mp3", albumDir: "Discovery", albumTitle: "Discovery", trackNumber: 1 });
  });

  it("keeps a 409's sentence as the message", async () => {
    answer(409, { detail: "«Discovery» ya tiene un archivo con ese nombre." });
    await expect(moveTrack({ path: "/music/Single/01.mp3", albumTitle: "Discovery" })).rejects.toMatchObject({
      message: "«Discovery» ya tiene un archivo con ese nombre.",
      status: 409,
    });
  });
});

describe("confirmReplace", () => {
  it("asks, naming the length of the version that goes", async () => {
    await expect(confirmReplace({ path: "/music/x/1.mp3", durationSeconds: 290 })).resolves.toBe(true);
    expect(mocks.confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "¿Cambiar por esta versión?",
        message: "Se borrará tu versión de 4:50.",
        confirmLabel: "Cambiar",
        cancelLabel: "Cancelar",
        destructive: true,
      }),
    );
  });

  it("still asks when the length is unknown", async () => {
    await confirmReplace({ path: "/music/x/1.mp3", durationSeconds: null });
    expect(mocks.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Se borrará tu versión." }));
  });
});

describe("replacementLanded", () => {
  it("is true only for a terminal, unfailed job that carried a replacement", () => {
    const asked = [{ replaces: "/music/x/1.mp3" }];
    expect(replacementLanded({ terminal: true, failed: 0 }, asked)).toBe(true);
    expect(replacementLanded({ terminal: true, failed: 1 }, asked)).toBe(false);
    expect(replacementLanded(null, asked)).toBe(false);
    expect(replacementLanded({ terminal: true, failed: 0 }, [{}])).toBe(false);
  });
});

// The shared "resolver" cases: the same file the iPhone and Android suites read.
// contracts/ sits at the repo root, five levels up from this folder.
import contract from "../../../contracts/resolver.json";

describe("contracts/resolver.json", () => {
  it.each(contract.fold)("folds «$in»", ({ in: input, out }) => {
    expect(foldTitle(input)).toBe(out);
  });
  it.each(contract.ownedElsewhere)("$case", ({ verdict, albumTitle, move }) => {
    expect(ownedElsewhere(verdict, albumTitle) !== null).toBe(move);
  });
  it.each(contract.rowControl)("row: $case", ({ verdict, albumTitle, control }) => {
    expect(rowControl(verdict, albumTitle)).toBe(control);
  });
  it.each(contract.confirmDetail)("confirm: $case", async ({ nearMatch, text }) => {
    await confirmReplace(nearMatch);
    expect(mocks.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ message: text }));
  });
});
