import type { TFunction } from 'i18next'
import { APP_NAME } from '../brand'

/** Translate contract output without turning a changing duration into a key. */
export function reachWord(t: TFunction, word: string): string {
  const duration = /^hace (\d+) (min|h|d|semana|semanas)$/.exec(word)
  if (duration) {
    const n = Number(duration[1])
    if (duration[2] === 'min') return t("{{n}} min ago", { n })
    if (duration[2] === 'h') return t("{{n}} h ago", { n })
    if (duration[2] === 'd') return t("{{n}} d ago", { n })
    return t("{{n}} weeks ago", { count: n, n })
  }
  switch (word) {
    case '': return ''
    case 'ahora': return t("now")
    case 'conectado': return t("connected_masculine")
    case 'sin respuesta': return t("no answer")
    case 'sin comprobar': return t("not checked")
    case 'sin uso aún': return t("not used yet")
    case 'red local': return t("local network")
    case 'sin acceso': return t("no access")
    case 'no detectado': return t("not detected")
    case 'sin dominio': return t("no domain")
    case 'responde otro nido': return t("another nest answered")
    case 'no es un nido de Krobi': return t("not a {{app}} nest", { app: APP_NAME })
    default: return word
  }
}
