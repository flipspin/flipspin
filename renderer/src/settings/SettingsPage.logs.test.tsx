import { waitForUi as waitFor } from '../test/test-clock'
import { onlineManager } from '@tanstack/react-query'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import themeCss from '../styles/theme.css?raw'
import primitivesCss from '../ui/primitives.css?raw'
import baseCss from '../ui/tokens/base.css?raw'
import personalCss from '../ui/tokens/personal.css?raw'
import { renderPage } from './page-test-support'
import * as settingsContext from './context'
import settingsCss from './settings.css?raw'

const useRealSettings = settingsContext.useSettings
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('local log sources', () => {
  it('clamps long messages to three lines, expands by keyboard and copies the full original line', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const message = Array.from({ length: 30 }, (_, i) => `ERROR: diagnostic ${i} with a long explanation`).join('\n')
    const line = `  ${JSON.stringify({ timestamp: '2026-11-12T14:30:00Z', level: 'ERROR', module: 'app.domains.acquisition', message })}  `
    const { baseElement } = renderPage({ section: 'registro', respond: r => r.pathname === '/api/logs'
      ? { status: 200, json: { lines: [line], sizeBytes: line.length } } : undefined })
    expect((await waitFor(() => screen.getByTitle('Todo', {}))).tagName).toBe('SUMMARY')
    const row = screen.getByTitle('Todo').closest('details')!
    const copyLine = screen.getByRole('button', { name: 'Copiar línea' })
    expect(row.contains(copyLine)).toBe(false)
    // Clipboard feedback lasts 1.5 seconds; drive that timer without a real wait.
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(copyLine) })
    expect(copy).toHaveBeenLastCalledWith(line)
    expect(row.open).toBe(false)
    expect(copyLine.querySelector('.lucide-check')).not.toBeNull()
    const toolbarCopy = screen.getByRole('button', { name: 'Copiar' })
    await act(async () => { fireEvent.click(toolbarCopy) })
    expect(copy).toHaveBeenCalledWith(line)
    expect(toolbarCopy.querySelector('.lucide-check')).not.toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(copyLine.querySelector('.lucide-copy')).not.toBeNull()
    expect(toolbarCopy.querySelector('.lucide-copy')).not.toBeNull()
    vi.useRealTimers()
    row.querySelector('summary')!.focus()
    await user.keyboard('{Enter}')
    // Native disclosure keyboard behavior is exercised in Chromium below.

    // Measure the real CSS: jsdom cannot lay out line clamps. The row's native
    // disclosure is also its keyboard-accessible expand/collapse control.
    const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })
    try {
      const page = await browser.newPage()
      for (const width of [1100, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.setContent(`<style>${themeCss}\n${baseCss}\n${personalCss}\n${primitivesCss}\n${settingsCss}</style>${baseElement.querySelector('.settings')!.outerHTML}`)
        const rowCopy = page.locator('.settings-log__copy')
        await page.mouse.move(0, 0)
        expect(await rowCopy.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
        await rowCopy.focus()
        expect(await rowCopy.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
        await page.locator('input').focus()
        expect(await rowCopy.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
        await page.locator('.settings-logrow').hover()
        expect(await rowCopy.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
        const text = page.locator('.settings-log__msg')
        const closedHeight = await text.evaluate(el => {
          const style = getComputedStyle(el)
          const height = el.getBoundingClientRect().height
          return { height, lineHeight: parseFloat(style.lineHeight), clamp: style.webkitLineClamp, overflow: el.scrollHeight > el.clientHeight }
        })
        expect(closedHeight.clamp).toBe('3')
        expect(closedHeight.height).toBeLessThanOrEqual(closedHeight.lineHeight * 3 + 1)
        expect(closedHeight.overflow).toBe(true)
        await page.locator('.settings-log > summary').focus()
        await page.keyboard.press('Enter')
        await expect.poll(() => page.locator('.settings-log').getAttribute('open')).toBe('')
        expect(await text.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(closedHeight.height)
        expect(await text.textContent()).toBe(message)
        await page.keyboard.press('Enter')
        await expect.poll(() => page.locator('.settings-log').getAttribute('open')).toBeNull()
      }
    } finally { await browser.close() }
  // Chromium startup and layout at two viewport sizes need their own deadline.
  }, 20_000)

  it('reads desktop and helper locally, searches, refreshes and opens only the selected source folder', async () => {
    const { fake } = renderPage({ section: 'registro', localLogs: { helper: true, read: request => ({
      path: '', lines: [`[2026-11-12][14:30:00][desktop][INFO] ${request.source} ${request.q || 'started'}`],
      truncated: false, sizeBytes: 100, matched: 1, scanned: 1,
    }) }, respond: r => r.pathname === '/api/logs' ? { status: 200, json: { lines: [], sizeBytes: 0 } } : undefined })
    const localSource = await waitFor(() => screen.getByRole('radio', { name: 'Esta computadora' }))
    onlineManager.setOnline(false)
    try {
      await userEvent.click(localSource)
      expect(await waitFor(() => screen.getByText('desktop started'))).toBeVisible()
      await userEvent.click(screen.getByRole('button', { name: 'Abrir carpeta' }))
      expect(fake.invokedWith('log:open-folder')).toEqual([{ source: 'desktop' }])
      const search = screen.getByRole('searchbox', { name: 'Filtrar el registro' })
      await userEvent.type(search, 'failure')
      await userEvent.tab()
      expect(await waitFor(() => screen.getByText('desktop failure'))).toBeVisible()
      await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }))
      await userEvent.click(screen.getByRole('radio', { name: 'Ayudante' }))
      expect(await waitFor(() => screen.getByText('helper failure'))).toBeVisible()
      await userEvent.click(screen.getByRole('button', { name: 'Abrir carpeta' }))
      expect(fake.invokedWith('log:open-folder')).toEqual([{ source: 'desktop' }, { source: 'helper' }])
      expect(fake.invokedWith('log:read')).toContainEqual({ source: 'helper', lines: 300, q: 'failure' })
      expect(fake.requests.filter(r => r.pathname === '/api/logs')).toHaveLength(1)
    } finally { onlineManager.setOnline(true) }
  })
  it('omits the helper source when its log is absent', async () => {
    renderPage({ section: 'registro', respond: r => r.pathname === '/api/logs' ? { status: 200, json: { lines: [] } } : undefined })
    await waitFor(() => screen.getByRole('searchbox', { name: 'Filtrar el registro' }))
    expect(screen.queryByRole('radio', { name: 'Ayudante' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Abrir carpeta' })).toBeNull()
  })
})


describe('clear the selected log', () => {
  const page = { lines: ['  raw diagnostic  '], sizeBytes: 19 }
  for (const file of ['errors', 'app'] as const) {
    it(`confirms, cancels, clears and refetches the ${file} server log`, async () => {
      const user = userEvent.setup()
      const { fake } = renderPage({ section: 'registro', respond: r => r.pathname === '/api/logs'
        ? { status: 200, json: page } : r.pathname === '/api/logs/clear'
          ? { status: 200, json: { file, clearedBytes: 19 } } : undefined })
      const clear = await waitFor(() => screen.getByRole('button', { name: 'Limpiar' }))
      const buttons = within(clear.closest('form')!).getAllByRole('button')
      expect(buttons.at(-1)).toBe(clear)
      for (const button of buttons) {
        expect(button).toHaveClass('ks-btn', 'ks-btn--sm', 'ks-btn--icon')
        expect(button.textContent).toBe('')
        expect(button).toHaveAttribute('title')
        expect(button).toHaveAttribute('aria-label')
      }
      if (file === 'app') await user.click(screen.getByRole('radio', { name: 'Todo' }))
      await user.click(clear)
      let dialog = await waitFor(() => screen.getByRole('alertdialog', { name: `¿Vaciar el registro ${file === 'app' ? 'Todo' : 'Errores'}?` }))
      expect(within(dialog).queryByText('raw diagnostic')).toBeNull()
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus()
      if (file === 'app') {
        const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })
        try {
          const browserPage = await browser.newPage()
          for (const width of [1100, 390]) {
            await browserPage.setViewportSize({ width, height: 900 })
            await browserPage.setContent(`<style>${themeCss}\n${baseCss}\n${personalCss}\n${primitivesCss}\n${settingsCss}</style>${dialog.parentElement!.outerHTML}`)
            const panel = browserPage.getByRole('alertdialog')
            const box = await panel.boundingBox()
            expect(box!.width).toBeGreaterThan(200)
            expect(box!.width).toBeLessThanOrEqual(width)
            expect(box!.x).toBeGreaterThanOrEqual(0)
            expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
            expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
          }
        } finally { await browser.close() }
      }
      await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(fake.requests.filter(r => r.pathname === '/api/logs/clear')).toHaveLength(0)
      expect(clear).toHaveFocus()
      await user.click(clear)
      dialog = await waitFor(() => screen.getByRole('alertdialog'))
      const reads = fake.requests.filter(r => r.pathname === '/api/logs').length
      await user.click(within(dialog).getByRole('button', { name: 'Limpiar' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(fake.requests.filter(r => r.pathname === '/api/logs/clear')).toMatchObject([{ method: 'POST', body: { file } }])
      expect(fake.requests.filter(r => r.pathname === '/api/logs').length).toBeGreaterThan(reads)
      expect(fake.invokedWith('log:clear')).toEqual([])
    // The app case also launches Chromium and measures two viewport layouts.
    }, file === 'app' ? 20_000 : undefined)
  }
  for (const source of ['desktop', 'helper'] as const) {
    it(`clears ${source} through the native channel even for members`, async () => {
      const user = userEvent.setup()
      // The page itself is owner-gated; exercise Logs with a member context
      // without changing the shared section registry.
      const context = vi.spyOn(settingsContext, 'useSettings').mockImplementation(() => ({ ...useRealSettings(), admin: false }))
      const { fake } = renderPage({ section: 'registro',
        localLogs: { helper: true, read: () => ({ ...page, path: '', scanned: 1, matched: 1, truncated: false }) },
        respond: r => r.pathname === '/api/logs' ? { status: 200, json: page } : undefined })
      await waitFor(() => screen.getByText('raw diagnostic', { selector: '.settings-log__msg' }))
      expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull()
      await user.click(screen.getByRole('radio', { name: source === 'desktop' ? 'Esta computadora' : 'Ayudante' }))
      await user.click(await waitFor(() => screen.getByRole('button', { name: 'Limpiar' })))
      const reads = fake.invokedWith('log:read').length
      const dialog = await waitFor(() => screen.getByRole('alertdialog'))
      await user.click(within(dialog).getByRole('button', { name: 'Limpiar' }))
      await waitFor(() => expect(fake.invokedWith('log:clear')).toEqual([{ source }]))
      await waitFor(() => expect(fake.invokedWith('log:read').length).toBeGreaterThan(reads))
      expect(fake.requests.filter(r => r.pathname === '/api/logs/clear')).toEqual([])
      context.mockRestore()
    })
  }
  it('disables clear for an empty log but allows clearing a filtered nonempty file', async () => {
    const user = userEvent.setup()
    const { fake } = renderPage({ section: 'registro', respond: r => r.pathname === '/api/logs'
      ? { status: 200, json: { lines: [], sizeBytes: new URLSearchParams(r.search).get('q') ? 19 : 0 } } : undefined })
    const clear = await waitFor(() => screen.getByRole('button', { name: 'Limpiar' }))
    expect(clear).toBeDisabled()
    await user.click(clear)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await user.type(screen.getByRole('searchbox'), 'absent')
    await user.click(screen.getByRole('button', { name: 'Actualizar' }))
    await waitFor(() => expect(clear).toBeEnabled())
    expect(fake.invokedWith('log:clear')).toEqual([])
  })
  for (const status of [403, 404, 405]) {
    it(`shows the existing update wording for server ${status}`, async () => {
      const user = userEvent.setup()
      renderPage({ section: 'registro', respond: r => r.pathname === '/api/logs'
        ? { status: 200, json: page } : r.pathname === '/api/logs/clear'
          ? { status, json: { detail: status === 404 ? 'Not Found' : 'Unavailable' } } : undefined })
      await user.click(await waitFor(() => screen.getByRole('button', { name: 'Limpiar' })))
      await user.click(within(await waitFor(() => screen.getByRole('alertdialog'))).getByRole('button', { name: 'Limpiar' }))
      expect(await waitFor(() => screen.getByText('Actualiza el nido para usar esta función.'))).toBeVisible()
    })
  }
})
