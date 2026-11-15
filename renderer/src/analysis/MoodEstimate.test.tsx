import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../i18n'
import { MoodEstimate } from './MoodEstimate'

it('shows mood as an estimate with its reason in the tooltip and to screen readers', () => {
  const { container } = render(<MoodEstimate>Groovy</MoodEstimate>)
  const value = container.querySelector('.analysis-value--estimated')
  expect(value).not.toBeNull()
  expect(value?.getAttribute('title')).toBeTruthy()
  expect(screen.getByText('Groovy')).toBeVisible()
  expect(value?.textContent).toContain('≈')
  expect(container.querySelector('.k-sr-only')?.textContent).toContain(value?.getAttribute('title') ?? '')
})
