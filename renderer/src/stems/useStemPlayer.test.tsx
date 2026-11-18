import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useStemPlayer } from './useStemPlayer';
import { stemPlayer } from './StemPlayer';
import { isOriginal } from './mix';

function CardHarness() {
  const player = useStemPlayer();
  return <>
    <output>{player.state}</output>
    <button onClick={() => player.setPreset('karaoke')}>Karaoke</button>
    {!isOriginal(player.mix) && <button onClick={player.reset}>volver al original</button>}
  </>;
}
afterEach(async () => { stemPlayer.reset(); await Promise.resolve(); stemPlayer.detach(); });
it('check 8: the card hook exposes a carried mix and volver al original action without a drawer implementation', async () => {
  render(<CardHarness />);
  act(() => screen.getByRole('button', { name: 'Karaoke' }).click());
  expect(screen.getByRole('button', { name: 'volver al original' })).toBeInTheDocument();
  await act(async () => { screen.getByRole('button', { name: 'volver al original' }).click(); });
  expect(screen.queryByRole('button', { name: 'volver al original' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('original');
});
