import { focusManager } from '@tanstack/react-query'
import { poll } from '../data/poll'
/** Read helper state through the shell; Rust owns provisioning and credentials.
 * Browser development has no local helper and must handle an absent bridge. */
import { useSyncExternalStore } from "react";
import i18next, { currentLanguage } from "../i18n";

import { bridge, hasBridge } from "../bridge";
import type { MacEngineStatus } from "../lib/ipc";

export interface MacState {
  available: boolean; // there is a shell to ask
  status: MacEngineStatus | null;
  lastError: string | null;
}

let state: MacState = { available: false, status: null, lastError: null };
const listeners = new Set<() => void>();

function emit(next: Partial<MacState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export function subscribeMac(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getMacState() {
  return state;
}

export async function refreshMac(): Promise<MacEngineStatus | null> {
  if (poll('idle') === false) return state.status;
  if (!hasBridge()) {
    emit({ available: false, status: null });
    return null;
  }
  try {
    const status = await bridge().invoke("lyrics:engine-status", undefined);
    emit({ available: true, status, lastError: null });
    return status;
  } catch (error) {
    emit({ available: true, lastError: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function installMacEngine(): Promise<void> {
  if (!hasBridge()) return;
  const before = await refreshMac();
  if (before?.agentRunning) await stopMacAgent();
  try {
    const result = await bridge().invoke("lyrics:engine-install", undefined);
    if (!result.started && result.reason) throw new Error(result.reason);
    await refreshMac();
  } catch (error) {
    if (before?.agentRunning) await startMacAgent();
    emit({ lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function repairMacEngine(): Promise<void> {
  if (!hasBridge()) return;
  const result = await bridge().invoke('lyrics:engine-repair', undefined);
  if (!result.started) throw new Error(result.reason);
  await refreshMac();
}

export async function startMacAgent(): Promise<boolean> {
  if (!hasBridge()) return false;
  const result = await bridge().invoke("lyrics:agent-start", undefined);
  if (!result.ok && result.reason) {
    emit({ lastError: result.reason });
  }
  void refreshMac();
  return result.ok;
}

export async function stopMacAgent(): Promise<void> {
  if (!hasBridge()) return;
  await bridge().invoke("lyrics:agent-stop", undefined);
  void refreshMac();
}

export async function setMacWorker(enabled: boolean): Promise<void> {
  try {
    const result = await bridge().invoke('lyrics:worker-set', { enabled });
    if (!result.ok) throw new Error(result.reason ?? 'No se pudo cambiar');
  } finally { await refreshMac(); }
}

export async function configureMacWorker(tray: boolean): Promise<void> {
  await bridge().invoke('lyrics:worker-configure', { tray });
  await refreshMac();
}

let booted = false;

/** Rust owns the persisted switch, provisioning, installation and package update. */
export function bootMacAgent(): () => void {
  if (booted || !hasBridge()) return () => {};
  booted = true;
  const resume = async () => {
    try { await bridge().invoke('lyrics:worker-resume', undefined); }
    catch (error) { emit({ lastError: error instanceof Error ? error.message : String(error) }); }
    await refreshMac();
  };
  const language = () => {
    void bridge().invoke('lyrics:worker-configure', { language: currentLanguage() });
  };
  language();
  i18next.on('languageChanged', language);
  const offProgress = bridge().on('lyrics:engine-progress', () => { void refreshMac(); });
  const offFocus = focusManager.subscribe(focused => { if (focused) void refreshMac(); });
  const offWorker = bridge().on('lyrics:worker-changed', () => { void refreshMac(); });
  const offAuth = bridge().on('auth:changed', () => {
    void stopMacAgent().then(resume);
  });
  void refreshMac();
  void resume();
  return () => {
    offProgress(); offWorker(); offAuth(); offFocus();
    i18next.off('languageChanged', language);
    booted = false;
  };
}

export function useMacEngine(): MacState {
  return useSyncExternalStore(subscribeMac, getMacState, getMacState);
}
