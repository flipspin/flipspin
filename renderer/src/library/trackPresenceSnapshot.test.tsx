import { QueryClient } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DataProvider } from '../data/provider';
import { queryKeys } from '../data/keys';
import { recordQueryHeaders } from '../data/http';
import { isTrackPresent, markTrackAbsent } from './trackPresence';

it('uses the raw query snapshot, retains 404s on revalidation, and clears them on a new revision or cache reset', () => {
  const client = new QueryClient();
  const key = queryKeys.library.albums({ covers: false });
  const track = { relPath: 'Artist∕Album/CD1∕song.mp3' };
  const data = [{ tracks: [track] }];
  // This is also how the offline listing is installed in the shared query cache.
  client.setQueryData(key, data);
  recordQueryHeaders(client, key, new Headers({ etag: '"one"', 'x-krobi-snapshot-at': '1' }));
  const view = render(<DataProvider queryClient={client}><span /></DataProvider>);
  expect(isTrackPresent(track)).toBe(true);
  expect(isTrackPresent({ relPath: 'Other/gone.mp3' })).toBe(false);
  act(() => markTrackAbsent(track));
  act(() => client.setQueryData(key, data));
  expect(isTrackPresent(track)).toBe(false);
  recordQueryHeaders(client, key, new Headers({ etag: '"two"' }));
  act(() => client.setQueryData(key, data));
  expect(isTrackPresent(track)).toBe(true);
  act(() => client.clear());
  expect(isTrackPresent({ relPath: 'Other/gone.mp3' })).toBe(true);
  view.unmount();
});
