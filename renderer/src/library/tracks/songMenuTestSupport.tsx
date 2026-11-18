import type { ReactNode } from 'react'
import { render as renderUi } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/** The song menus now use the app's query cache. Keep unrelated surface tests offline. */
export function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(['me', 'profile'], { role: 'member', isOwner: false })
  return renderUi(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
