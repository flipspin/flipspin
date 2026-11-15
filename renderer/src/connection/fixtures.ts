/** Canvas states for the component story and boundary tests. No runtime network. */
import type { ServerConnection } from '../lib/ipc'

export function canvasConnection(state: 'primera' | 'tardando' | 'caido' | 'fuera' | 'conectado', since = Date.now()): ServerConnection {
  return {
    state: state === 'conectado' ? 'connected' : state === 'primera' || state === 'tardando' ? 'connecting' : 'unreachable',
    since,
    attempt: state === 'primera' ? 1 : 8,
    lastError: state === 'caido' ? 'refused-port' : state === 'fuera' || state === 'tardando' ? 'refused-route' : null,
    checks: [
      { id: 'this-computer', status: 'ok', detail: state === 'fuera' ? 'Wi-Fi · 10.0.0.23' : 'Wi-Fi · 192.168.1.50' },
      { id: 'route', status: state === 'primera' ? 'idle' : state === 'tardando' ? 'warn' : state === 'fuera' ? 'bad' : 'ok', detail: '192.168.1.20' },
      { id: 'krobi', status: state === 'caido' ? 'bad' : state === 'conectado' ? 'ok' : 'idle', detail: 'puerto 8000' },
    ],
  }
}
