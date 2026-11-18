/** Ask the shell for a device name so account lists can distinguish computers.
 * Keep null on failure and let callers fall back; naming must not block sign-in. */
import { useEffect, useState } from 'react'

import { bridge, hasBridge } from '../bridge'

export async function readDeviceName(): Promise<string | null> {
  if (!hasBridge()) return null
  try {
    const answer = await bridge().invoke('app:get-device-name', undefined)
    const name = typeof answer?.name === 'string' ? answer.name.trim() : ''
    return name === '' ? null : name
  } catch {
    return null
  }
}

export function useDeviceName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void readDeviceName().then((found) => {
      if (alive) setName(found)
    })
    return () => {
      alive = false
    }
  }, [])
  return name
}
