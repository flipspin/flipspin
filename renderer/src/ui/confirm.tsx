/** Settle pending confirmations with false on unmount or when no provider exists.
 * Callers await a decision; an abandoned dialog must neither hang them nor authorize an action. */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import PanelModal from './components/PanelModal'
import { useHeld } from './react/useHeld'

import { logger } from '../lib/logger'
import i18n from '../i18n'

export interface ConfirmOptions {
  title: string
  /** The consequence, in one sentence. This is where "no se puede undo" goes. */
  message?: string
  /** Defaults to "Confirm". Prefer a verb: "Delete", "Sign out". */
  confirmLabel?: string
  /** Defaults to "Cancel". */
  cancelLabel?: string
  /** Colours the confirm button as destructive and puts initial focus on "Cancel". */
  destructive?: boolean
}

interface ResolvedOptions {
  title: string
  message: string | null
  confirmLabel: string
  cancelLabel: string
  destructive: boolean
}

interface ConfirmRequest {
  id: string
  options: ResolvedOptions
  settle: (answer: boolean) => void
}

let sequence = 0
let host: ((request: ConfirmRequest) => void) | null = null

// Resolved when the dialog is requested, from a plain function, so the defaults
// come from the instance rather than a hook and follow the current language.
function resolveOptions(options: ConfirmOptions): ResolvedOptions {
  return {
    title: options.title,
    message: options.message ?? null,
    confirmLabel: options.confirmLabel ?? i18n.t("Confirm"),
    cancelLabel: options.cancelLabel ?? i18n.t("Cancel"),
    destructive: options.destructive ?? false,
  }
}

/** Resolve true only on confirmation; missing or unmounted providers resolve false. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const receive = host
  if (!receive) {
    logger.error('confirm requested with no dialog mounted; answering no', { title: options.title })
    return Promise.resolve(false)
  }

  sequence += 1
  const id = `confirm-${sequence}`
  return new Promise<boolean>((resolve) => {
    receive({ id, options: resolveOptions(options), settle: resolve })
  })
}

/** The hook form. Identical behaviour; exists so components read consistently. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirmAction
}

function ConfirmDialog({
  request,
  open,
  onSettle,
}: {
  request: ConfirmRequest
  open: boolean
  onSettle: (id: string, answer: boolean) => void
}): React.JSX.Element {
  const { title, message, confirmLabel, cancelLabel, destructive } = request.options
  const messageId = useId()

  const answer = useCallback(
    (value: boolean) => {
      onSettle(request.id, value)
    },
    [onSettle, request.id],
  )

  // The layer owns focus in, the Tab trap, focus back to the opener, the inert
  // background and innermost-wins Escape / backdrop press (both answer "no").
  // A destructive dialog is an alertdialog that opens on "Cancel", so a
  // reflexive Enter gives the safe answer.
  return (
    <PanelModal
      open={open}
      title={title}
      accent={destructive ? "var(--rose)" : "var(--yellow)"}
      width="max-w-md"
      onClose={() => answer(false)}
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-describedby={message ? messageId : undefined}
      scrimStyle={{ zIndex: 'calc(var(--z-modal) + 50)' }}
      footer={<>
        <button type="button" onClick={() => answer(false)} className="k-btn k-btn--text" data-autofocus={destructive ? '' : undefined}>
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => answer(true)}
          className={`k-btn k-btn--text ${destructive ? "k-btn--text-danger" : "k-btn--text-primary"}`}
          data-autofocus={destructive ? undefined : ''}
        >
          {confirmLabel}
        </button>
      </>}
    >
      {message && <p className="p-4 text-[14px]" id={messageId}>{message}</p>}
    </PanelModal>
  )
}

export function ConfirmProvider({ children }: { children?: ReactNode }): React.JSX.Element {
  const [queue, setQueue] = useState<readonly ConfirmRequest[]>([])
  // The queue as the unmount cleanup will see it. State captured in a cleanup's
  // closure is the state at the time the effect ran, which for an
  // empty-dependency effect is always the empty first render.
  const pending = useRef<readonly ConfirmRequest[]>([])

  useEffect(() => {
    pending.current = queue
  }, [queue])

  useEffect(() => {
    const receive = (request: ConfirmRequest): void => {
      // Queued, not replaced. Two destructive actions confirmed in quick
      // succession must both get an answer; dropping the second silently would
      // leave its caller awaiting a promise nobody will settle.
      setQueue((current) => [...current, request])
    }
    host = receive
    return () => {
      if (host === receive) host = null
    }
  }, [])

  useEffect(
    () => () => {
      // The leak guard. Every caller awaiting a dialog that is going away with
      // its provider gets `false` rather than nothing at all.
      const stranded = pending.current
      pending.current = []
      for (const request of stranded) request.settle(false)
    },
    [],
  )

  const settle = useCallback((id: string, value: boolean) => {
    // The promise is settled here and not inside the state updater. React may
    // invoke an updater more than once (strict mode does, deliberately), and an
    // updater that also resolves a promise is a side effect running twice.
    const request = pending.current.find((item) => item.id === id)
    request?.settle(value)
    setQueue((current) => current.filter((item) => item.id !== id))
  }, [])

  const current = queue[0]
  const held = useHeld(current)

  return (
    <>
      {children}
      {held && <ConfirmDialog key={held.id} open={current != null} request={held} onSettle={settle} />}
    </>
  )
}
