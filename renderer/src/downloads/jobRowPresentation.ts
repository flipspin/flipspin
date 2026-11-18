import type { ReactNode } from 'react'
import { acquisitionLive, type AcquisitionJob } from './acquisitionJobs'

export type WorkGroup = 'running' | 'waiting' | 'terminal'
export interface GroupedWorkRow { key: string; group: WorkGroup; row: ReactNode }

export function pausedAcquisitionItem(job: AcquisitionJob) {
  return acquisitionLive(job) ? job.items.find(item => item.reason === 'en-pausa' && ['queued', 'running'].includes(item.state)) : undefined
}

export function acquisitionGroup(job: AcquisitionJob): WorkGroup {
  return !acquisitionLive(job) ? 'terminal' : pausedAcquisitionItem(job) ? 'waiting' : 'running'
}
