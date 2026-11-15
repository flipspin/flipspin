/** Keep shared copy as msg() keys and translate at render time so language changes apply. */
import { msg } from '../i18n'

export const IMPORT_COPY = {
  blurb:
    msg("Add music to your nest’s library."),
  playlistLabel: msg("Playlist link"),
  youtubeLabel: msg("Video link"),
  youtubeNameLabel: msg("File name"),
  youtubeWait: msg("Wait for the download to finish."),
  untitledPlaylist: msg('Playlist'),
  started: msg("is now downloading."),
  landed: msg("Downloaded."),
  genericFailure: msg("Couldn't import."),
} as const
