/** The Plugins sheet uses one shared open/close signal. */
import { useSyncExternalStore } from 'react'
let location: string | null = null
const listeners = new Set<() => void>()
export function openPluginInstaller(value = '') { location = value; listeners.forEach(listener => listener()) }
export function closePluginInstaller() { location = null; listeners.forEach(listener => listener()) }
export function usePluginInstaller() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => location)
}
