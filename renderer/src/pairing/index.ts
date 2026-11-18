/**
 * The feature's public surface.
 *
 * Import from here rather than from a file inside: everything else is free to be
 * rearranged, and the shell that mounts pairing should not have to know that the
 * reveal and the form are two components rather than one.
 */

export { PairingPanel } from './PairingPanel'
export { PairingProvider, usePairing } from './PairingProvider'
export type { CopyText, PairingContextValue, PairingProviderProps } from './PairingProvider'
export { PairDeviceFlow } from './PairDeviceFlow'
export type { PairDeviceFlowProps } from './PairDeviceFlow'
export { MintedAccessReveal } from './MintedAccessReveal'
export type { MintedAccessRevealProps } from './MintedAccessReveal'
export { DeviceList } from './DeviceList'
export type { DeviceListProps } from './DeviceList'
export { QrCode, buildQrGeometry } from './QrCode'
export type { QrCodeProps, QrGeometry } from './QrCode'
export { createPairingGateway } from './gateway'
export { buildAccessLink, describeAccessLink, isLoopbackServer, normalizeServer } from './accessLink'
export { ACCESS_ACTION, ACCESS_SCHEME, SERVER_KEY, TOKEN_KEY } from './accessLink'
export { DEFAULT_ROLE, ROLE_EXPLANATIONS, ROLE_NAMES, formatMoment } from './messages'
export { PairingError, isPairingError } from './types'
export type {
  MintedAccess,
  PairedDevice,
  PairingFailureKind,
  PairingGateway,
  Role,
} from './types'
