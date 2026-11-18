import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));



vi.mock("../data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data")>()),
  apiPost: mocks.apiPost,
  // track() reconciles with GET /api/jobs at once. Unmocked, it reached
  // whatever listened on localhost:8000 (a dev backend), whose job list
  // replaced this test's job; "unchanged" keeps the test off the network.
  getApiClient: async () => ({ GET: async () => ({ data: undefined, response: { status: 304 } }) }),
}));

import i18n from "../i18n";

import DownloadRetryModal from "./DownloadRetryModal";
import FailedSongs from "./FailedSongs";
import { closeRetry, dismiss, getState, report, track } from "./downloadsStore";

const FAILURE = {
  index: 0,
  item: "Gosh",
  title: "Gosh",
  artist: "Jamie xx",
  album: "In Colour",
  durationS: 293,
  query: "Gosh Jamie xx",
  kind: "no-results",
  reason: "Could not resolve YouTube URL: no YouTube results for 'Gosh Jamie xx'",
  suggestions: ["Gosh Jamie xx", "Gosh Jamie xx lyrics", "Jamie xx Gosh audio", "Gosh Jamie", "Gosh"],
  retriedAs: null,
};

function failedSnapshot() {
  return {
    progress_id: "job-1",
    total: 1,
    completed: 1,
    percentage: 100,
    status: "Downloaded 0/1 tracks (1 failed)",
    terminal: true,
    succeeded: 0,
    failed: 1,
    active: {},
    failures: [FAILURE],
  };
}

const job = () => getState().jobs.find((j: { id: string }) => j.id === "job-1");

describe("retrying a failed song", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    track({ id: "job-1", label: "Gosh", total: 1 });
  });

  afterEach(() => {
    closeRetry();
    vi.useRealTimers();
    getState().jobs.forEach((j: { id: string }) => dismiss(j.id));
  });

  it.each(['en', 'es'])('points an authentication failure to Sources → YouTube in %s', async language => {
    await i18n.changeLanguage(language);
    const snapshot = failedSnapshot();
    snapshot.failures[0] = { ...FAILURE, kind: 'auth' };
    report("job-1", snapshot);
    render(<><FailedSongs jobId="job-1" failures={job()!.failures} /><DownloadRetryModal /></>);
    await userEvent.click(screen.getByRole('button', { name: /Search another way|Buscar de otra forma/ }));
    expect(screen.getByText(language === 'en'
      ? "YouTube asked to confirm you're not a robot. Check Settings → Sources → YouTube."
      : "YouTube pidió confirmar que no eres un robot. Revisa Ajustes → Fuentes → YouTube.")).toBeVisible();
    await i18n.changeLanguage('es');
  });

  it("keeps a failed job until it is dismissed by hand", () => {
    vi.useFakeTimers();
    report("job-1", failedSnapshot());
    vi.advanceTimersByTime(60_000);
    expect(job()?.failures).toHaveLength(1);
  });

  it("searches only when asked, and downloads only the video the person picks", async () => {
    const user = userEvent.setup();
    report("job-1", failedSnapshot());
    render(
      <>
        <FailedSongs jobId="job-1" failures={job()!.failures} />
        <DownloadRetryModal />
      </>,
    );

    await user.click(screen.getByRole("button", { name: /Buscar de otra forma/ }));
    // Opening the sheet searches nothing.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/YouTube no devolvió ningún resultado para «Gosh Jamie xx»/)).toBeTruthy();

    mocks.apiPost.mockResolvedValueOnce({
      query: "Gosh Jamie",
      results: [
        { id: "a", url: "https://www.youtube.com/watch?v=a", title: "Jamie xx - Gosh (Live)", duration: 412, uploader: "x" },
        { id: "b", url: "https://www.youtube.com/watch?v=b", title: "Jamie xx - Gosh", duration: 293, uploader: "Jamie xx" },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Gosh Jamie" }));
    expect(mocks.apiPost).toHaveBeenCalledWith("/api/downloads/youtube-search", {
      body: { query: "Gosh Jamie", limit: 10 },
    });
    await screen.findByText("Jamie xx - Gosh");
    expect(screen.getByText("±0 s")).toBeTruthy();
    expect(screen.getByText("+119 s")).toBeTruthy();

    mocks.apiPost.mockResolvedValueOnce({ success: true, status: "started", progress_id: "job-2", total: 1, label: "Gosh" });
    await user.click(screen.getAllByRole("button", { name: /Descargar/ })[1]);

    expect(mocks.apiPost).toHaveBeenLastCalledWith("/api/downloads/retry", {
      body: { progress_id: "job-1", index: 0, youtube_url: "https://www.youtube.com/watch?v=b" },
    });
    await waitFor(() => expect(getState().retry).toBeNull());
    expect(job()?.failures[0].retriedAs).toBe("job-2");
    expect(getState().jobs.some((j: { id: string }) => j.id === "job-2")).toBe(true);
  });

  it("explains a server that forgot the job", async () => {
    const user = userEvent.setup();
    report("job-1", failedSnapshot());
    render(
      <>
        <FailedSongs jobId="job-1" failures={job()!.failures} />
        <DownloadRetryModal />
      </>,
    );
    await user.click(screen.getByRole("button", { name: /Buscar de otra forma/ }));
    mocks.apiPost.mockResolvedValueOnce({
      query: "Gosh",
      results: [{ id: "b", url: "https://www.youtube.com/watch?v=b", title: "Gosh", duration: 293, uploader: null }],
    });
    await user.click(screen.getByRole("button", { name: "Gosh" }));
    await screen.findByText("±0 s");

    const { ApiError } = await import("../data");
    mocks.apiPost.mockRejectedValueOnce(
      new ApiError({ kind: "http", message: "404", status: 404, method: "POST", path: "/api/downloads/retry", body: { detail: "El servidor ya no recuerda esta descarga" } } as never),
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Descargar/ }));
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(getState().retry).not.toBeNull();
  });
});
