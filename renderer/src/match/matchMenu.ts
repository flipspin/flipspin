import { getState } from '@state/identityStore';
import { isOfflineNow } from '../offline/policy';
import i18n from '../i18n';
import type { MenuItem } from '../albums/TrackContextMenu';
import { openSongMatch, type MatchSong } from './matchStore';

export function matchSongMenuItems(song: MatchSong, count = 1): MenuItem[] {
  if (!getState().me?.isOwner || count !== 1) return [];
  return [{ label: i18n.t("Match on MusicBrainz…"), color: 'var(--teal)', disabled: isOfflineNow(),
    tooltip: isOfflineNow() ? i18n.t("MusicBrainz needs the nest") : undefined,
    onClick: () => openSongMatch(song) }];
}
