import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, () => void>() }));
vi.mock("../bridge", () => ({ hasBridge: () => true, bridge: () => ({ invoke: mocks.invoke, on: (event: string, callback: () => void) => { mocks.events.set(event, callback); return () => mocks.events.delete(event); } }) }));
import { bootMacAgent, installMacEngine } from "./macEngine";
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


describe('desktop helper boot', () => {
  it('resumes on startup and after auth changes for any nest, then removes listeners', async () => {
    const dispose = bootMacAgent();
    try {
      expect(mocks.invoke).toHaveBeenCalledWith('lyrics:worker-resume', undefined);
      mocks.invoke.mockClear();
      mocks.events.get('auth:changed')!();
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('lyrics:worker-resume', undefined));
      const channels = mocks.invoke.mock.calls.map(([channel]) => channel);
      expect(channels.indexOf('lyrics:agent-stop')).toBeLessThan(channels.indexOf('lyrics:worker-resume'));
    } finally { dispose(); }
    expect(mocks.events.size).toBe(0);
  });
});
