import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '../i18n'
import type { ReactNode } from 'react'
import { useGlobalKeys } from '../shell/useGlobalKeys'
import { AnalysisValue } from './AnalysisValue'
import { confidenceLine } from './calibration'

function Shortcuts({ children, play }: { children: ReactNode; play: () => void }) {
  useGlobalKeys({ selectedTrack: null, lyricsOpen: false, setIsPlaying: play, openLibrary: () => {} })
  return children
}

afterEach(async () => { await i18n.changeLanguage('es') })

it.each(['key', 'bpm'] as const)('opens info for %s estimates and every source without playing/selecting the row', async field => {
  await i18n.changeLanguage('en')
  const user = userEvent.setup()
  for (const [source, estimated, label] of [
    ['computed', true, "Flipspin's estimate"], ['computed', false, "Flipspin's calculation"],
    ['tag', false, 'File tag'], ['fixed', false, 'Corrected by hand'],
  ] as const) {
    const open = vi.fn(), select = vi.fn(), play = vi.fn()
    const view = render(<Shortcuts play={play}><div onClick={select} onDoubleClick={play}><AnalysisValue
      track={{ key: '3A', bpm: 94, [`${field}Source`]: source, [`${field}Estimated`]: estimated, [`${field}Confidence`]: 0.31 }} field={field} onOpenInfo={open} /></div></Shortcuts>)
    const button = screen.getByRole('button', { name: `Open song info · ${label}` })
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
    expect(button.closest('[tabindex]')).toHaveAttribute('tabindex', '-1')
    await user.tab()
    expect(button).toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent(label)
    if (source === 'computed') expect(screen.getByRole('tooltip')).toHaveTextContent(confidenceLine(field, 0.31)!)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    await user.click(button)
    expect(open).toHaveBeenCalledTimes(3)
    await user.dblClick(button)
    expect(open).toHaveBeenCalledTimes(5)
    expect(select).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
    fireEvent.blur(button)
    fireEvent.mouseEnter(button.closest('[tabindex]')!)
    expect(screen.getByRole('tooltip')).toHaveTextContent(label)
    view.unmount()
  }
})

it('keeps values without an opener, missing values and values without a source passive', () => {
  const view = render(<AnalysisValue track={{ key: '3A', keyEstimated: true }} field="key" />)
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<AnalysisValue track={{ key: '3A', keySource: 'tag' }} field="key" />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByRole('img', { name: 'Etiqueta del archivo' })).toBeInTheDocument()
  view.rerender(<AnalysisValue track={{}} field="key" onOpenInfo={vi.fn()} />)
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<AnalysisValue track={{ bpm: 94 }} field="bpm" onOpenInfo={vi.fn()} />)
  expect(screen.queryByRole('button')).toBeNull()
})
