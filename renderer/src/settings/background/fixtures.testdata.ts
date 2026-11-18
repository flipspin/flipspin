import type { SchemaComputeSummary, SchemaWorkerLimits } from '../../api/generated/schema'
export const limits: SchemaWorkerLimits = { pace: 'fast', paused: false, window: null, onlyCharging: false, cpuPercent: 50, maxTempC: 85, resumeTempC: 75, use: {}, installEverything: false }
export function summaryFixture(): SchemaComputeSummary {
  return {
    paused: false, waiting: 49,
    kinds: (['align', 'stems', 'analysis'] as const).map((kind, i) => ({
      kind, policy: { kind, placement: kind === 'analysis' ? 'anywhere' : 'helpers', paused: false, nestAfterS: 600, libraryPass: 'auto', requiredMemoryBytes: kind === 'analysis' ? 0 : 8 * 2 ** 30 }, waiting: [37, 0, 12][i], oldestAt: kind === 'stems' ? null : 1794520800, failed: 0, running: [], reason: kind === 'stems' ? null : 'helpers-offline', waitingFor: 'Helper computer', nestMemoryBytes: 4 * 2 ** 30,
    })),
    computers: [
      { id: 'nest', name: 'The nest', nest: true, os: 'linux', accel: 'cpu', jobs: ['analysis'], version: '0.15.6', minimumVersion: '0.10.0', versionState: 'current', state: 'idle', keepAwake: 'none', lastSeenAt: 1794520800, memoryBytes: 4 * 2 ** 30, blockedReasons: [], temperatureC: 64, speed: { analysis: { samples: 4, medianSecondsPerMinute: 6 } }, limits: { ...limits, pace: 'gentle', window: { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 60, endMinute: 420 } } },
      { id: 'helper', name: 'Helper computer', nest: false, os: 'macos', accel: 'mlx', jobs: ['align', 'stems', 'analysis'], version: '0.15.6', minimumVersion: '0.10.0', versionState: 'current', chip: 'Apple Silicon', state: 'asleep', keepAwake: 'none', lastSeenAt: 1794520800, memoryBytes: 16 * 2 ** 30, blockedReasons: [], powerReadable: true, onBattery: false, speed: { align: { samples: 5, medianSecondsPerMinute: 25 }, stems: { samples: 5, medianSecondsPerMinute: 7 }, analysis: { samples: 5, medianSecondsPerMinute: 1.2 } }, limits: structuredClone(limits) },
    ],
  }
}
