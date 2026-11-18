import { useEffect, useState } from 'react'
import { bridge, hasBridge } from '../bridge'

export function useDeviceName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!hasBridge()) return
    let alive = true
    bridge()
      .invoke('app:get-device-name', undefined)
      .then(
        (answer) => {
          if (alive) setName(answer.name)
        },
        () => undefined,
      )
    return () => {
      alive = false
    }
  }, [])
  return name
}
