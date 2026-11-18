import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { highlightMatches } from './highlightMatches';
it('highlights each accent-insensitive word without rewriting displayed text', () => {
  const { container } = render(<>{highlightMatches('Canción de Niño', 'nino cancion')}</>);
  expect(container.textContent).toBe('Canción de Niño');
  expect([...container.querySelectorAll('span')].map(x => x.textContent)).toEqual(['Canción', 'Niño']);
});
