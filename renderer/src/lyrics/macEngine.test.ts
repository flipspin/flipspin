import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../bridge", () => ({ hasBridge: () => true, bridge: () => ({ invoke: mocks.invoke }) }));
import { installMacEngine } from "./macEngine";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (channel) => {
    if (channel === "lyrics:engine-status") return { installed: true, agentRunning: true };
    if (channel === "lyrics:engine-install") return { started: true };
    return { ok: true };
  });
});
describe("Mac engine upgrade", () => {
  it("stops the old process before upgrading so it cannot keep claiming as 0.4.0", async () => {
    await installMacEngine();
    const calls = mocks.invoke.mock.calls.map(([channel]) => channel);
    expect(calls.indexOf("lyrics:agent-stop")).toBeLessThan(calls.indexOf("lyrics:engine-install"));
  });
  it("restores the previous agent and reports an installation refusal", async () => {
    mocks.invoke.mockImplementation(async (channel) => {
      if (channel === "lyrics:engine-status") return { installed: true, agentRunning: true };
      if (channel === "lyrics:engine-install") return { started: false, reason: "no-worker-source" };
      return { ok: true };
    });
    await expect(installMacEngine()).rejects.toThrow("no-worker-source");
    expect(mocks.invoke).toHaveBeenCalledWith("lyrics:agent-start", undefined);
  });
});
