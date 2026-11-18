import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExportDropZone from './ExportDropZone';
import { ImportSteps } from './ImportSteps';




describe('Spotify archive entry', () => {
  it('keeps instructions optional and permits retrying the same file', () => {
    const picked = vi.fn();
    const { container } = render(<ExportDropZone parsing={false} onFile={picked} />);
    expect(screen.getByRole('button', { name: 'Cómo conseguirlo' })).toHaveAttribute('aria-expanded', 'false');
    const file = new File(['{}'], 'playlist.json', { type: 'application/json' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(picked).toHaveBeenCalledTimes(2);
    expect(picked).toHaveBeenLastCalledWith(file);
  });
  it('opens the same four Spotify instructions in Settings', () => {
    render(<ExportDropZone parsing={false} onFile={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cómo conseguirlo' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Abre la configuración de privacidad de Spotify' })).toHaveAttribute('href', 'https://www.spotify.com/account/privacy/');
  });
  it('does not accept another dropped archive while parsing', () => {
    const picked = vi.fn();
    render(<ExportDropZone parsing onFile={picked} />);
    fireEvent.drop(screen.getByRole('button', { name: 'Elegir archivo de Spotify' }), { dataTransfer: { files: [new File(['{}'], 'playlist.json')] } });
    expect(picked).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Leyendo el archivo…');
  });
  it('identifies the current step without presenting unavailable stages as buttons', () => {
    const { container, rerender } = render(<ImportSteps step="resolving" />);
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('Revisión');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ImportSteps step="importing" />);
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('Descarga');
  });
});
