// Must come first: Node's own (empty) `localStorage` global shadows jsdom's,
// and `i18n` below reads the stored language while it evaluates.
import './test-storage'

import { afterEach, beforeEach, expect } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Register DOM matchers once so individual tests do not depend on per-file setup.
import '@testing-library/jest-dom/vitest'

// Pin the simulated system language to Spanish for copy assertions.
// Leave storage untouched so language-preference tests start without an explicit choice.
import './test-system-language'

// The UI language module, so `useTranslation` has an instance.
import '../i18n'

// Unmount after each test so queries cannot see the previous test's tree.
afterEach(() => {
  cleanup()
  // Start each test on Home so route state cannot leak between cases.
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
})

// The app always has the one notification surface mounted (UiProvider), and
// Settings' toast and the legacy useStatus() draw through it. A test that
// renders a piece on its own gets one too, so a toast it raises is on screen;
// it is torn down and emptied after each test so nothing leaks into the next.
let notifications: { root: Root; host: HTMLElement } | null = null
beforeEach(async () => {
  // The channel's own tests mount their provider.
  if (/notifications\.test\.tsx?$/.test(expect.getState().testPath ?? '')) return
  const { NotificationsProvider } = await import('../ui/notifications')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(NotificationsProvider)))
  notifications = { root, host }
})
afterEach(async () => {
  const { dismissAllNotifications } = await import('../ui/notifications')
  if (notifications) {
    const { root, host } = notifications
    act(() => root.unmount())
    host.remove()
    notifications = null
  }
  dismissAllNotifications()
})
