/**
 * The vocabulary of device pairing, and the port the UI talks through.
 *
 * Nothing here imports React or the HTTP client on purpose: every component in
 * this feature is written against `PairingGateway`, so a test can drive the real
 * components with a fake transport and another workstream can wire the real one
 * without editing a component.
 */

/** Keep owner and member distinct: only owners can manage household access. */
export type Role = 'owner' | 'member'

/** A row of the server's user table. Metadata only; never a token. */
export interface PairedDevice {
  id: string
  label: string
  role: Role
  /** ISO-8601, as the server writes it. */
  createdAt: string
  /**
   * `null` for a device that has never called. Coarse even when set: the server
   * flushes it on an interval, so it usually predates the request reading it.
   */
  lastSeenAt: string | null
}

/** The server keeps a digest, so capture this token before dismissal.
 * Never persist it or include it in diagnostics. */
export interface MintedAccess {
  device: PairedDevice
  token: string
}

/**
 * The failure kinds the UI branches on.
 *
 * Deliberately a closed set rather than the server's `detail` string. The
 * backend answers in English and this UI is Spanish, so surfacing server prose
 * would leak untranslated text into the panel; worse, `detail` is free-form and
 * a component that renders it is a component whose copy the backend can change.
 */
export type PairingFailureKind =
  /** 403; the caller holds a member token. Listing and minting are owner-only. */
  | 'forbidden'
  /** 404; the row is already gone. Revoking a device somebody else revoked. */
  | 'missing'
  /** 422 on a revoke; the last owner. The server refuses to lock everyone out. */
  | 'lastOwner'
  /** 422 elsewhere; a label, role, username or password the server would not take. */
  | 'rejected'
  /** 409 on creating an account; the username already belongs to someone. */
  | 'taken'
  /** The response was not the shape this client reads. */
  | 'malformed'
  /** No answer at all, or a status with no better name. */
  | 'unreachable'

/**
 * `message` is for a developer reading a stack trace and is never rendered.
 * The Spanish a person sees is chosen by the component from `kind`, because only
 * the component knows which sentence makes sense where it is standing.
 */
export class PairingError extends Error {
  readonly kind: PairingFailureKind

  constructor(kind: PairingFailureKind, message: string) {
    super(message)
    this.name = 'PairingError'
    this.kind = kind
  }
}

export function isPairingError(value: unknown): value is PairingError {
  return value instanceof PairingError
}

/**
 * The three calls this feature makes. An implementation is free to be HTTP, a
 * fake, or an IPC hop through the main process; the components cannot tell.
 */
export interface PairingGateway {
  /** Throws `forbidden` for a member token. An empty array means empty. */
  listDevices(signal?: AbortSignal): Promise<PairedDevice[]>
  /** The one call that returns a token. See `MintedAccess`. */
  mintDevice(input: { label: string; role: Role; username?: string; password?: string }, signal?: AbortSignal): Promise<MintedAccess>
  revokeDevice(id: string, signal?: AbortSignal): Promise<void>
}
