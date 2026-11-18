import { useTranslation } from 'react-i18next'
import type { SchemaExtension } from '../api/generated/schema'
import { Word } from './parts'

export type Extension = SchemaExtension

/** Keep host state words consistent across engine and feature rows. */
export function ExtensionState({ extension }: { extension: Extension }) {
  const { t } = useTranslation()
  const state = extension.state
  const label = state === 'on' ? 'On' : state === 'off' ? 'Off' : state === 'restart-pending' ? 'Restart pending' : state === 'incompatible' ? 'Incompatible' : state === 'invalid' ? 'Invalid' : 'Failed'
  const tone = state === 'on' ? 'ok' : state === 'off' ? 'off' : state === 'restart-pending' ? 'warn' : 'bad'
  return <Word tone={tone} title={extension.reason ?? undefined}>{t(label)}</Word>
}
