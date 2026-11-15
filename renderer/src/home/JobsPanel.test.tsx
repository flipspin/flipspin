import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("../offline/useOffline", () => ({ useOutbox: () => [] }));
vi.mock("../offline/useOfflineStorage", () => ({ useOfflineStorage: () => ({ data: null }) }));
vi.mock("../downloads/acquisitionJobs", () => ({
  useAcquisitionJobs: () => ({ requests: [] }),
  withoutAcquisitionStages: () => [{ id: "job" }],
}));
vi.mock("../downloads/DownloadsMenu", () => ({
  ClearFinished: () => <button>Clear</button>,
  JobList: () => <article aria-label="Import">Importing</article>,
}));
import JobsPanel from "./JobsPanel";

it("keeps the count, rows and actions while the rail uses a plain heading", () => {
  const view = render(<JobsPanel frameless />);
  expect(screen.getByRole("region", { name: "Trabajos" })).toHaveClass("home-jobs--bare");
  expect(screen.getByRole("heading", { name: "Trabajos" })).toHaveTextContent("Trabajos");
  expect(view.container.querySelector(".home-jobs__count")).toHaveTextContent("1");
  expect(screen.getByRole("article", { name: "Import" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  view.rerender(<JobsPanel />);
  expect(screen.getByRole("region", { name: "Trabajos" })).toHaveClass("bg-panel", "border-2");
  expect(screen.getByRole("article", { name: "Import" })).toBeTruthy();
});
