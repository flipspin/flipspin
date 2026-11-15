import { msg } from '../i18n'

export const CONFIG_LABELS: Record<string, string> = {
  KROBI_SOURCE_LOCATION_YOUTUBE: msg("YouTube source location"),
  KROBI_STEMS_BACKGROUND: msg("Separate in the background"),
  KROBI_MAX_CONCURRENT_DOWNLOADS: msg("At a time per source"),
  KROBI_MAX_CONCURRENT_JOBS: msg("Jobs at a time"),
  KROBI_ADVERTISE: msg("Visible on your network"),
  KROBI_UPDATE_CHECK: msg("Check for updates"),
  KROBI_BACKEND_PORT: msg("Port"),
  KROBI_BACKEND_HOST: msg("Accept connections from"),
  KROBI_CORS_ORIGINS: msg("Allowed web pages"),
  KROBI_API_TOKEN: msg("Shared key"),
  KROBI_REQUIRE_SETUP_TOKEN: msg("Setup code"),
  KROBI_ALLOW_UNAUTHENTICATED_REMOTE: msg("Access without an account"),
  KROBI_ALLOW_REMOTE_LOCAL_ACTIONS: msg("Open files from another computer"),
  KROBI_ENABLE_WAVEFORM_CACHE: msg("Save waveforms"),
  KROBI_LYRICS_ENGINE: msg("Lyrics engine"),
  KROBI_NEST_PROCESSES: msg("Let the nest process if no helper is available"),
  KROBI_FFMPEG_PATH: msg('ffmpeg'),
  KROBI_DEMO_OVERRIDES: msg("Demo overrides"),
  KROBI_LOG_LEVEL: msg("Log detail"),
  KROBI_MUSIC_DIR: msg("Music"),
  KROBI_PLAYLIST_DIR: msg('Playlists'),
  KROBI_STEMS_DIR: msg('Stems'),
  KROBI_LOG_DIR: msg("Log"),
}
export const CONFIG_TIPS: Record<string, string> = {
  KROBI_STEMS_BACKGROUND: msg("Only while your mix is playing (not Original)"),
  KROBI_UPDATE_CHECK: msg("Checks GitHub once a day for a new Flipspin version."),
  KROBI_NEST_PROCESSES: msg("If no helper responds within 10 minutes, the nest does one song at a time."),
  KROBI_MAX_CONCURRENT_DOWNLOADS: msg("Songs fetched at once from each source; a source that pushes back waits by itself"),
  KROBI_MAX_CONCURRENT_JOBS: msg("Albums, playlists or imports progressing together. The rest wait in the queue."),
  KROBI_ADVERTISE: msg("Computers on your network see the nest in “Nests on your network” without entering its address."),
  KROBI_BACKEND_PORT: msg("Apps and QR codes use it. It can only be changed on the nest."),
  KROBI_BACKEND_HOST: msg("0.0.0.0: any computer that can reach the port. 127.0.0.1: only this nest."),
  KROBI_CORS_ORIGINS: msg("Web pages that can connect to the nest. An error here disconnects the desktop app."),
  KROBI_API_TOKEN: msg("A legacy key that grants admin access. It is never shown."),
  KROBI_REQUIRE_SETUP_TOKEN: msg("Only matters before the first account: asks for the code the nest writes in its log."),
  KROBI_ALLOW_UNAUTHENTICATED_REMOTE: msg("If enabled, anyone who reaches the port could enter as an admin."),
  KROBI_ALLOW_REMOTE_LOCAL_ACTIONS: msg("Another computer can ask the nest to open files on its disk."),
  KROBI_ENABLE_WAVEFORM_CACHE: msg("Saves each song’s waveform to avoid recalculating it."),
  KROBI_FFMPEG_PATH: msg("The program that converts audio. The one bundled with Flipspin usually works."),
  KROBI_LOG_LEVEL: msg("How much the nest writes to its log. “Debug” uses much more disk space."),
}
export const GROUP_LABELS: Record<string, string> = {
  capacity: msg("Performance"), network: msg("Network"), security: msg("Security"), library: msg("Library and lyrics"),
  lyrics: msg("Lyrics_plural"), stems: msg('Stems'), logging: msg("Log"), folders: msg("Folders"),
}
export const PRESETS: Record<string, string> = { light: msg("Light_weight"), normal: msg("Normal") }
export const CHOICES: Record<string, string> = {
  auto: msg("Automatic"), local: msg("This nest"), agent: msg("Another computer"),
  DEBUG: msg("Debug"), INFO: msg("Standard"), WARNING: msg("Warnings"), ERROR: msg("Errors"),
}

// The API's reason codes are stable; its legacy Spanish messages are not UI keys.
export const CONFIG_DISABLED_REASONS: Record<string, string> = {
  'no-engine': msg("The nest does not have the lyrics engine"),
  'no-cgroup': msg("This nest cannot limit its processor use"),
}
