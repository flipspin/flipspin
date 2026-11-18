import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ME_NORMAL, fakePlugin, renderPage } from './page-test-support'
import type { SchemaExtension } from '../api/generated/schema'

function extension(overrides: Partial<SchemaExtension> = {}): SchemaExtension {
  return {
    id: 'example', kind: 'feature', name: 'Example', version: '1.2.3',
    protocol: { plugin_api: [1] }, runs: ['nest'], adds: ['page'], reaches: [],
    entry: { module: 'example.krobi_plugin' }, license: 'AGPL-3.0-or-later',
    homepage: 'https://example.test', state: 'on', reason: 'Manifest reason', ...overrides,
  }
}

function respond(row: SchemaExtension) {
  return (request: { pathname: string }) => request.pathname === '/api/extensions'
    ? { status: 200, json: { extensions: [row], accepted: { helper: [1], source: [1], plugin_api: [1] } } }
    : undefined
}

describe('extension observations in existing settings rows', () => {
  it.each([
    ['on', 'Activo'], ['off', 'Apagado'], ['restart-pending', 'Reinicio pendiente'],
    ['failed:registration', 'Falló'], ['incompatible', 'Incompatible'], ['invalid', 'Inválido'],
  ])('shows %s with its version and reason on the plugin nest row', async (state, word) => {
    const card = fakePlugin()
    renderPage({ section: 'plugins', respond: respond(extension({ state })) })
    const region = within(await screen.findByRole('region', { name: card.name }))
    expect(await region.findByText('1.2.3')).toBeVisible()
    expect(region.getByText(word)).toHaveAttribute('title', 'Manifest reason')
    expect(region.getByText(card.computer.value)).toBeVisible()
  })

  it('shows refused backend packages even without a renderer card', async () => {
    renderPage({ section: 'plugins', respond: respond(extension({ id: 'refused', state: 'incompatible' })) })
    const region = within(await screen.findByRole('region', { name: 'Example' }))
    expect(region.getByText('1.2.3')).toBeVisible()
    expect(region.getByText('Incompatible')).toHaveAttribute('title', 'Manifest reason')
  })

  it.each([['lyrics', 'Letras'], ['stems', 'Stems'], ['analysis', 'Análisis']])('reads %s metadata on the engine nest row', async (id, name) => {
    renderPage({ section: 'complementos', respond: respond(extension({ id, kind: 'engine', state: 'off' })) })
    const region = within(await screen.findByRole('region', { name }))
    expect(await region.findByText('1.2.3')).toBeVisible()
    expect(region.getByTitle('Manifest reason')).toHaveTextContent('Apagado')
  })

  it('does not request owner-only metadata for members', async () => {
    const card = fakePlugin()
    const { fake } = renderPage({ section: 'plugins', me: ME_NORMAL, respond: respond(extension()) })
    await waitFor(() => expect(within(screen.getByRole('region', { name: card.name })).getByRole('button', { name: 'Abrir' })).toBeDisabled())
    expect(fake.requests.some(request => request.pathname === '/api/extensions')).toBe(false)
    expect(screen.queryByText('1.2.3')).not.toBeInTheDocument()
  })

  it('keeps existing plugin rows usable with older nests', async () => {
    const card = fakePlugin()
    renderPage({ section: 'plugins', respond: request => request.pathname === '/api/extensions' ? { status: 404, json: { detail: 'Not Found' } } : undefined })
    expect(await screen.findByText(card.nido.value)).toBeVisible()
    expect(screen.queryByText('1.2.3')).not.toBeInTheDocument()
  })
})
