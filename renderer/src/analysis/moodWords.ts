import { msg } from '../i18n'

/** The backend's mood ids in the words the song window uses. */
export const MOOD_WORDS: Record<string, string> = {
  romantic: msg('Romantic'), groovy: msg('Groovy'), upbeat: msg('Upbeat'), calm: msg('Calm'),
  melancholic: msg('Melancholic'), dark: msg('Dark'), aggressive: msg('Aggressive'), ambient: msg('Ambient'),
}
