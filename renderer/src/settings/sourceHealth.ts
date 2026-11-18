import type { TFunction } from 'i18next'
import { currentLanguage } from '../i18n'
import type { Provider } from './data'

export function sourceState(provider: Provider) {
  const health = provider.health
  if (health?.kind === 'auth-required' && health.state !== 'ok') return 'auth'
  return health?.state === 'busy' ? 'busy' : health?.state === 'broken' ? 'broken' : 'ready'
}

export function sourceTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function sourceWord(provider: Provider, t: TFunction) {
  const state = sourceState(provider)
  return state === 'auth' ? t('Needs sign-in') : state === 'broken' ? t('Broken')
    : state === 'busy' ? provider.health?.until ? t('Busy until {{time}}', { time: sourceTime(provider.health.until) }) : t('Busy') : t('Ready', { context: 'source' })
}

export function sourceTooltip(provider: Provider, t: TFunction) {
  const health = provider.health
  const cause = health?.kind === 'rate-limited' ? t('Rate-limited') : health?.kind === 'blocked' ? t('Blocked')
    : health?.kind === 'auth-required' ? t('Needs sign-in') : health?.kind === 'broken' ? t('Broken') : null
  return [cause,
    health?.firstFailureAt != null ? t('First failure {{time}}', { time: new Date(health.firstFailureAt * 1000).toLocaleString(currentLanguage()) }) : null,
    health?.lastFailureAt != null ? t('Last failure {{time}}', { time: new Date(health.lastFailureAt * 1000).toLocaleString(currentLanguage()) }) : null,
    health?.until != null ? t('Until {{time}}', { time: new Date(health.until * 1000).toLocaleString(currentLanguage()) }) : null,
  ].filter(Boolean).join(' · ')
}

export function sourceFact(provider: Provider, t: TFunction) {
  const state = sourceState(provider)
  if (state === 'ready') return ''
  if (state === 'busy') return t('{{name}} asked to slow down · retries by itself', { name: provider.name })
  const cause = state === 'auth' ? t('{{name}} needs sign-in', { name: provider.name })
    : provider.health?.kind === 'blocked' ? t('{{name}} blocked downloads', { name: provider.name }) : t('{{name}} could not download', { name: provider.name })
  return [cause, provider.health?.since ? t('since {{time}}', { time: sourceTime(provider.health.since) }) : null].filter(Boolean).join(' · ')
}

export function sourceNeedsAction(provider: Provider, now = Date.now() / 1000) {
  if (!provider.enabled || provider.kind !== 'streaming') return false
  const state = sourceState(provider)
  return state === 'auth' || state === 'broken'
    || (state === 'busy' && provider.health?.since != null && now - provider.health.since > 6 * 3600)
    || Boolean(provider.status?.warning)
}
