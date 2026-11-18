/** Inject the gateway and address at the feature boundary so mounting and tests need no internal wiring changes. */

import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'

import type { PairingGateway } from './types'

/** Return a boolean from clipboard operations so failures cannot propagate an exception containing the token. */
export type CopyText = (text: string) => Promise<boolean>

const copyThroughClipboard: CopyText = async (text) => {
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export interface PairingContextValue {
  gateway: PairingGateway
  /**
   * The address the *phone* must reach, which is not always the address this
   * desktop uses. A nest this app hosts answers it on `127.0.0.1`, and a
   * loopback address in a QR code sends the phone to its own machine. Whoever
   * mounts this panel passes `routableAddress(status)` (the LAN address when
   * there is one); `buildAccessLink` refuses a loopback one regardless.
   */
  serverUrl: string
  copyText: CopyText
}

const PairingContext = createContext<PairingContextValue | null>(null)

export interface PairingProviderProps {
  gateway: PairingGateway
  serverUrl: string
  copyText?: CopyText
  children: ReactNode
}

export function PairingProvider({
  gateway,
  serverUrl,
  copyText = copyThroughClipboard,
  children,
}: PairingProviderProps): React.JSX.Element {
  const value = useMemo<PairingContextValue>(
    () => ({ gateway, serverUrl, copyText }),
    [gateway, serverUrl, copyText],
  )
  return <PairingContext.Provider value={value}>{children}</PairingContext.Provider>
}

/** Throw when the provider is missing so a stub cannot misrepresent a broken integration as an empty device list. */
export function usePairing(): PairingContextValue {
  const value = useContext(PairingContext)
  if (value === null) {
    throw new Error('usePairing must be used inside a PairingProvider')
  }
  return value
}
