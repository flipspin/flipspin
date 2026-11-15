import { waitForUi as waitFor } from '../test/test-clock'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { chromium } from 'playwright'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SetupSurface } from '../setup/SetupSurface'
import themeCss from '../styles/theme.css?raw'
import modernPrimitivesCss from '../ui/modern-primitives.css?raw'
import primitivesCss from '../ui/primitives.css?raw'
import baseCss from '../ui/tokens/base.css?raw'
import modernCss from '../ui/tokens/modern.css?raw'
import personalCss from '../ui/tokens/personal.css?raw'
import deleteAccountCss from './delete-account.css?raw'
import { nav, renderPage } from './page-test-support'
import settingsCss from './settings.css?raw'

describe('independent Settings scrolling', () => {
  it('resets content after a section change and keeps the sidebar position and keyboard focus', async () => {
    renderPage()
    await waitFor(() => within(nav()).getByRole('button', { name: 'Seguridad' }))
    const content = screen.getByRole('main')
    const menu = nav()
    content.scrollTop = 600
    menu.scrollTop = 120
    const general = within(menu).getByRole('button', { name: 'General' })
    general.focus()
    await userEvent.keyboard('{Enter}')
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'equipo')
    expect(content.scrollTop).toBe(0)
    expect(menu.scrollTop).toBe(120)
    expect(general).toHaveFocus()
    content.scrollTop = 300
    await userEvent.keyboard('{Enter}')
    expect(content.scrollTop).toBe(0)
    expect(menu.scrollTop).toBe(120)
    expect(general).toHaveFocus()
  }, 15000)

  it('keeps focus in the content pane when go replaces an in-page shortcut', async () => {
    renderPage()
    await waitFor(() => within(nav()).getByRole('button', { name: 'Seguridad' }))
    const content = screen.getByRole('main')
    const shortcut = within(content).getByRole('button', { name: /^General/ })
    content.scrollTop = 600
    shortcut.focus()
    await userEvent.keyboard('{Enter}')
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'equipo')
    expect(content).toHaveFocus()
    expect(content.scrollTop).toBe(0)
    await userEvent.tab()
    expect(content.contains(document.activeElement)).toBe(true)
  }, 15000)

  it('keeps the narrow header mounted and resets content on the back-to-index action', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    try {
      renderPage({ section: 'equipo' })
      const content = screen.getByRole('main')
      const header = screen.getByRole('banner')
      const back = within(header).getByRole('button', { name: 'Ajustes' })
      content.scrollTop = 600
      back.focus()
      await userEvent.keyboard('{Enter}')
      expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'resumen')
      expect(content.scrollTop).toBe(0)
      expect(content).toHaveFocus()
      expect(screen.getByRole('banner')).toBe(header)
      expect(content).toContainElement(await waitFor(() => screen.getByRole('heading', { name: 'Resumen' })))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('bounds both scroll panes, keeps the header still, and reserves space across long and short sections', async () => {
    const { baseElement } = renderPage()
    await waitFor(() => within(nav()).getByRole('button', { name: 'Seguridad' }))
    // Capture the populated summary, rather than a cold query's skeleton.
    await waitFor(() => screen.getByText('254 canciones', {}))
    const markup = baseElement.querySelector('.settings')!.outerHTML
    // Leave room for every Nest row before exercising the short viewport.
    const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1300 }, reducedMotion: 'reduce' })
      await page.setContent(`<style>${themeCss}\n${baseCss}\n${personalCss}\n${modernCss}\n${primitivesCss}\n${modernPrimitivesCss}\n${settingsCss}
        body { margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        #shell-header { flex: none; height: 56px; }
      </style><header id="shell-header">Settings</header>${markup}`)
      const content = page.locator('.settings-main')
      const menu = page.locator('.settings-nav')
      const header = page.locator('#shell-header')
      const menuBefore = await menu.boundingBox()
      const headerBefore = await header.boundingBox()
      const columnsBefore = await content.boundingBox()
      expect(await menu.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true)
      await content.hover()
      await page.mouse.wheel(0, 600)
      await page.waitForFunction(() => document.querySelector('.settings-main')!.scrollTop > 0)
      expect(await menu.boundingBox()).toEqual(menuBefore)
      expect(await menu.evaluate(el => el.scrollTop)).toBe(0)
      expect(await header.boundingBox()).toEqual(headerBefore)
      expect(await page.locator('.settings').evaluate(el => el.scrollTop)).toBe(0)
      await page.setViewportSize({ width: 1440, height: 600 })
      expect(await menu.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await content.evaluate(el => { el.scrollTop = 0 })
      await menu.hover()
      await page.mouse.wheel(0, 400)
      await page.waitForFunction(() => document.querySelector('.settings-nav')!.scrollTop > 0)
      expect(await content.evaluate(el => el.scrollTop)).toBe(0)
      await menu.locator('button').last().focus()
      expect(await menu.locator('button').last().evaluate(el => {
        const box = el.getBoundingClientRect()
        const pane = el.closest('nav')!.getBoundingClientRect()
        return box.top >= pane.top && box.bottom <= pane.bottom
      })).toBe(true)
      await page.setViewportSize({ width: 1440, height: 1300 })
      await content.focus()
      await page.keyboard.press('PageDown')
      await page.waitForFunction(() => document.querySelector('.settings-main')!.scrollTop > 0)
      expect(await menu.evaluate(el => el.scrollTop)).toBe(0)
      await content.evaluate(el => { el.innerHTML = '<section class="settings-page"><h2>Settings</h2></section>' })
      expect(await content.boundingBox()).toEqual(columnsBefore)
      await page.setViewportSize({ width: 402, height: 874 })
      expect(await menu.isVisible()).toBe(false)
      expect(await page.locator('.settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    } finally {
      await browser.close()
    }
  // Chromium startup plus three real scroll/layout cycles need a separate budget.
  }, 30_000)
})

describe('SettingsPage', () => {
  it('computes the app theme colours for Paper × light/dark/night, including OS dark', async () => {
    // Fail explicitly if the runner strips raw CSS before Chromium sees it.
    expect(themeCss).toContain('--paper:')
    expect(themeCss).toContain('--app-bg:')
    expect(baseCss).toContain('--accent-coral:')
    expect(personalCss).toContain('--color-bg-surface-primary: var(--paper)')
    expect(primitivesCss).toContain('.z-btn')
    expect(settingsCss).toContain('--color-bg-surface-primary: var(--paper)')
    const { baseElement } = renderPage({ section: 'cuentas', respond: r => r.pathname.endsWith('/deletion-preview') ? { status: 200, json: { devices: 2, songs: 212, playlists: 3, removable: { count: 38, bytes: 1234567890 }, kept: 174 } } : undefined })
    await userEvent.click(await waitFor(() => screen.getByText('Member', {})))
    await userEvent.click(within(screen.getByText('Member', { selector: 'b' }).closest('details')!).getByRole('button', { name: 'Eliminar' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /La cuenta y sus canciones/ })).toBeEnabled())
    expect(baseElement.querySelector('.krobi-modern')).toHaveAttribute('data-profile', 'modern')
    const setup = renderToStaticMarkup(<SetupSurface variant="inline"><p>Setup</p></SetupSurface>)
    expect(setup).not.toContain('data-theme')
    expect(setup).not.toContain('data-palette')
    const markup = baseElement.querySelector('.settings')!.outerHTML + setup
    // jsdom does not resolve custom properties. Exercise the actual stylesheets
    // and rendered root in Chromium, including the vendored competing rules.
    // This is a one-page CSS check. In-process Chromium also runs in restricted
    // macOS environments where child-process Mach rendezvous is unavailable.
    const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })
    try {
      const page = await browser.newPage()
      await page.setContent(`<style>${themeCss}\n${baseCss}\n${personalCss}\n${modernCss}\n${primitivesCss}\n${modernPrimitivesCss}\n${settingsCss}\n${deleteAccountCss}</style>${markup}<div id="paper" style="background:var(--paper)"></div><div id="app-bg" style="background:var(--app-bg)"></div><div id="card" style="background:var(--panel)"></div>`)
      for (const palette of ['paper']) {
        for (const mode of ['light', 'dark', 'night']) {
          for (const os of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: os })
            for (const stamped of [false, true]) {
              for (const selector of ['.settings', '.krobi-modern', '.krobi-setup']) {
                const colours = await page.evaluate(({ palette, mode, stamped, selector }) => {
                  document.documentElement.dataset.theme = palette
                  document.documentElement.dataset.mode = mode
                  const root = document.querySelector<HTMLElement>(selector)!
                  // Also exercise the highest-specificity UI profile selectors even if
                  // a future caller stamps these attributes again.
                  if (stamped) {
                    root.dataset.palette = palette
                    root.dataset.theme = mode === 'light' ? 'light' : 'dark'
                  } else {
                    delete root.dataset.palette
                    delete root.dataset.theme
                  }
                  const app = getComputedStyle(document.getElementById(selector === '.settings' ? 'app-bg' : selector === '.krobi-setup' ? 'paper' : 'card')!).backgroundColor
                  const actual = getComputedStyle(root).backgroundColor
                  const pairs = [
                    ['--color-bg-surface-primary', '--paper'],
                    ['--color-bg-surface-secondary', '--panel'],
                    ['--color-bg-surface-tertiary', '--panel'],
                    ['--color-bg-surface-head', '--panel-2'],
                    ['--color-bg-surface-hover', '--paper-2'],
                    ['--color-bg-surface-rail', '--paper'],
                    ['--color-bg-surface-foot', '--panel-2'],
                    ['--color-bg-surface-dim', '--paper-2'],
                    ['--color-text-secondary', '--ink-2'],
                    ['--color-text-tertiary', '--ink-3'],
                    ['--color-text-body', '--ink'],
                    ['--color-text-disabled', '--ink-4'],
                    ['--color-text-on-fill', '--chalk'],
                    ['--color-text-accent', '--fg-coral'],
                    ['--color-border-soft', '--line-soft'],
                    ['--color-border-mid', '--line-med'],
                    ['--color-border-bold', '--line'],
                    ['--color-border-accent', '--coral'],
                    ['--color-bg-fill-primary', '--coral'],
                    ['--color-bg-fill-primary-hover', '--coral-deep'],
                    ['--color-bg-fill-secondary', '--paper'],
                    ['--color-bg-fill-secondary-hover', '--panel-2'],
                    ...(selector === '.krobi-modern' ? [
                      ['--zm-ink-fill', '--ink'], ['--zm-ink-fill-hover', '--ink-2'], ['--zm-on-ink', '--paper'],
                      ['--zm-tint-1', '--paper-2'], ['--zm-bad', '--rose'], ['--zm-bad-soft', '--rose-tint'], ['--zm-bad-fg', '--fg-rose'],
                      ['--status-danger', '--rose'], ['--status-danger-tint', '--rose-tint'], ['--status-danger-fg', '--fg-rose'],
                    ] : []),
                    ['--color-text-primary', '--ink'],
                    ['--color-text-on-hue', '--yellow-ink'],
                    ['--color-border-primary', '--line'],
                    ['--color-shadow-offset', '--line'],
                    ...['coral', 'yellow', 'teal', 'blue', 'purple', 'rose', 'green'].flatMap((hue) => [
                      [`--accent-${hue}`, `--${hue}`],
                      [`--accent-${hue}-tint`, `--${hue}-tint`],
                      [`--accent-${hue}-fg`, `--fg-${hue}`],
                    ]),
                  ]
                  const probe = document.createElement('span')
                  root.append(probe)
                  const tokens = pairs.map(([token, host]) => {
                    probe.style.color = `var(${token})`
                    const actual = getComputedStyle(probe).color
                    probe.style.color = `var(${host})`
                    return { token, actual, expected: getComputedStyle(probe).color }
                  })
                  probe.remove()
                  return { actual, app, tokens }
                }, { palette, mode, stamped, selector })
                expect(colours.actual, `${selector} ${palette}-${mode}, OS ${os}: background`).toBe(colours.app)
                expect(colours.actual).not.toBe('rgba(0, 0, 0, 0)')
                for (const { token, actual, expected } of colours.tokens) {
                  expect(actual, `${selector} ${palette}-${mode}, OS ${os}: ${token}`).toBe(expected)
                }
              }
            }
          }
        }
      }
    } finally {
      await browser.close()
    }
  }, 30_000)
})
