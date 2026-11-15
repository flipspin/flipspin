import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relPathOf, useUserLibrary } from '@state/userLibraryStore';
import { isRealUser, useIdentity } from '@state/identityStore';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { queryGet } from '../../data/http';
import { queryKeys } from '../../data/keys';
import { getLibraryRoot } from '@lib/libraryKeys';
import { narrowAlbums } from '../libraryPanel';
import { useOffline } from '../../offline/useOffline';
import { useLibraryMissing } from '../../data/hooks/use-library-missing';

type Song = { path: string; title?: string; relPath?: string; album?: unknown };
type LibraryRow = { relPath: string };
export type LibraryPerson = { id: string; label: string; count: number; tracks: LibraryRow[] };
export function useLibraryScope<T extends Song, A extends { tracks: T[] }>(tracks: T[], albums: A[]) {
  const { t } = useTranslation();
  const library = useUserLibrary();
  const identity = useIdentity();
  const [scope, setScope] = useState('all');
  const [onlyGone, setOnlyGone] = useState(false);
  const canScope = isRealUser(identity);
  const owner = canScope && !!identity.me?.isOwner;
  const ownId = identity.me?.id;
  useEffect(() => { setScope('all'); setOnlyGone(false); }, [ownId, owner]);
  const client = useQueryClient();
  const offline = useOffline();
  const users = useQuery({
    queryKey: queryKeys.household.usersBody(),
    enabled: owner && !offline,
    queryFn: ({ signal }) => queryGet(client, queryKeys.household.usersBody(), '/api/users', { signal }),
  });
  const accounts = owner ? users.data?.users || [] : [];
  const libraries = useQueries({ queries: accounts.map(user => ({
    queryKey: queryKeys.me.libraryAccount(user.id),
    enabled: !offline,
    queryFn: ({ signal }) => queryGet(client, queryKeys.me.libraryAccount(user.id), '/api/me/library', { params: { query: { accountId: user.id } }, signal }),
  })) });
  const people: LibraryPerson[] = accounts.map((user, index) => ({
    id: user.id, label: user.label || t("Account"),
    count: user.id === ownId ? library.count : libraries[index]?.data?.count ?? 0,
    tracks: user.id === ownId ? Object.values(library.byRelPath) as LibraryRow[] : libraries[index]?.data?.tracks || [],
  }));
  const selected = people.find(p => p.id === scope);
  const selectedRows = useMemo(() => scope !== 'all' && scope !== ownId ? selected?.tracks || [] : Object.values(library.byRelPath) as LibraryRow[], [scope, ownId, selected?.tracks, library.byRelPath]);
  const scoped = scope !== 'all' && canScope;
  const accountName: string = selected?.label || identity.me?.label || identity.me?.username || t("Account");
  const missing = useLibraryMissing(scoped ? [scope] : owner ? [ownId, ...people.map(p => p.id)] : undefined);
  const goneRows = useMemo(() => [...missing].map(relPath => ({ relPath })), [missing]);
  const isMine = useCallback((track: T) => selectedRows.some(r => r.relPath === relPathOf(track)), [selectedRows]);
  const scopedTracks = useMemo(() => {
    const visible = scoped ? tracks.filter(isMine) : tracks;
    const listed = new Set(visible.map(t => relPathOf(t)));
    const absent = goneRows.filter(row => !listed.has(row.relPath)).map(row => {
      const [folder, file] = row.relPath.split('/');
      return { path: `${getLibraryRoot() || ''}/${folder}/${file}`, relPath: row.relPath, title: file.replace(/\.[^.]+$/, ''), album: { album: folder } } as unknown as T;
    });
    return [...visible, ...absent].filter(track => !onlyGone || missing.has(relPathOf(track)))
      .map(track => missing.has(relPathOf(track)) ? { ...track, missingFromNest: true } : track);
  }, [tracks, scoped, isMine, goneRows, onlyGone, missing]);
  const scopedAlbums = useMemo(() => {
    const visible = scoped ? narrowAlbums(albums, isMine) : albums;
    const filtered = onlyGone ? narrowAlbums(visible, tr => missing.has(relPathOf(tr))) : visible;
    return missing.size ? filtered.map(album => ({ ...album, tracks: album.tracks.map(track => missing.has(relPathOf(track)) ? { ...track, missingFromNest: true } : track) })) : filtered;
  }, [scoped, albums, isMine, onlyGone, missing]);
  return { setScope: (next: string) => setScope(next === 'all' ? 'all' : !owner || next === 'mine' ? ownId : next), scoped, canScope, owner, people, selectedId: scoped ? scope : ownId, goneCount: goneRows.length, onlyGone, setOnlyGone, serverCount: tracks.length, mineCount: selected?.count ?? library.count ?? 0, accountName, tracks: scopedTracks, albums: scopedAlbums };
}
