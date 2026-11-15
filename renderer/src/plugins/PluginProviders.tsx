import { type PropsWithChildren } from 'react'
import { plugins } from './index'

/** Optional plugin state survives navigation without host feature imports. */
export function PluginProviders({ children }: PropsWithChildren) {
  return plugins.reduceRight((content, { Provider }) => Provider ? <Provider>{content}</Provider> : content, children)
}
