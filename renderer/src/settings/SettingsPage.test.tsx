import { screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import i18n from '../i18n'
import { ME_ADMIN, renderPage } from './page-test-support'

it.each(['es', 'en'])('preserves Settings text content in %s', async language => {
  await i18n.changeLanguage(language)
  const view = renderPage({
    me: { ...ME_ADMIN, label: 'Listener', username: 'listener' },
    respond: r => r.pathname === '/api/users' ? { status: 200, json: [] } : undefined,
  })
  await within(screen.getByRole('navigation')).findByRole('button', { name: language === 'es' ? 'Seguridad' : 'Security' })
  expect(view.container.textContent).toMatchSnapshot()
})
