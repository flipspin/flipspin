import { createContext, useContext } from 'react'
import { msg } from '../i18n'

export const STEPS = [
  { id: 'nest', label: msg("Nest"), hue: 'purple', icon: 'home', tip: msg("The computer that keeps your music and accounts") },
  { id: 'account', label: msg("Account"), hue: 'coral', icon: 'user', tip: msg("The nest’s first account; it’s the admin") },
  { id: 'music', label: msg("Music"), hue: 'yellow', icon: 'music', tip: msg("The folder Flipspin reads. Your files are never moved") },
  { id: 'remote', label: msg("Remote"), hue: 'teal', icon: 'globe', tip: msg("Listen away from home without opening ports") },
  { id: 'addons', label: msg("Engines"), hue: 'rose', icon: 'music', tip: msg("Optional · also in Settings → Engines") },
  { id: 'done', label: msg("Done"), hue: 'green', icon: 'home', tip: msg("Review what was set up and open Flipspin") },
] as const

const MEMBER_STEP = { id: 'devices', label: msg("Devices"), hue: 'blue', icon: 'phone', tip: msg("Subsonic apps to listen on your phone") } as const
export type StepId = (typeof STEPS)[number]['id'] | 'devices'
export const WizardPlan = createContext<readonly StepId[]>(STEPS.map(s => s.id))
export function useWizardSteps() {
  const plan = useContext(WizardPlan)
  return [...STEPS, MEMBER_STEP].filter(s => plan.includes(s.id))
}
