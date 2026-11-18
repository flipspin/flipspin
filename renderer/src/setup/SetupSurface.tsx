/**
 * Flipspin's first-run UI island. Tokens stay on .krobi-setup so the surrounding
 * app keeps its own theme. Pages use night; inline keeps the personal profile.
 */
import type { ReactNode } from 'react'

import '../ui/tokens/base.css'
import '../ui/tokens/personal.css'
import '../ui/primitives.css'
import '../ui/react/styles/components.css'
import './setup.css'

export interface SetupSurfaceProps {
  /**
   * `page`: a whole window before the app exists (the default).
   * `inline`: an island inside another screen; the nest picker in Settings.
   */
  variant?: 'page' | 'inline'
  labelledBy?: string
  children: ReactNode
}

export function SetupSurface({ variant = 'page', labelledBy, children }: SetupSurfaceProps): React.JSX.Element {
  const shared = {
    'data-profile': 'personal',
  }
  if (variant === 'inline') {
    return (
      <div className="krobi-setup z-root krobi-setup--inline" {...shared}>
        {children}
      </div>
    )
  }
  return (
    <main className="krobi-setup z-root krobi-setup--page" aria-labelledby={labelledBy} data-profile="night">
      <div className="krobi-setup__column">{children}</div>
    </main>
  )
}
